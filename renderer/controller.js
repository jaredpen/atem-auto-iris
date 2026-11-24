// Tally-aware auto-exposure controller (iris and/or gain). Pure logic: no DOM, no network.
//
//   ON AIR  (program tally) → never touch the camera.
//   PREVIEW (preview tally) → adjusted FIRST and to a tighter target, so it's ready before the cut.
//                             (Optional: lock preview instead, with adjustPreview = false.)
//   IDLE                    → corrective moves, wait for the picture to settle, re-measure.
//
// Modes:
//   'iris' — iris only.
//   'gain' — gain only.
//   'both' — gain is chosen first, pulled to the nearest base gain (cleanest image, e.g. 0 / +18 dB);
//            iris then fine-tunes. A non-base gain is only used when the iris can't make up the difference.

import { stopsError, trimmedTarget } from './analysis.js'

export const DEFAULT_TUNING = {
	deadbandStops: 0.15, // "close enough" — stop adjusting inside ±this
	previewWarnStops: 0.3, // flag a preview camera that is further off than this and can't be fixed
	adjustPreview: true, // false = lock preview cameras like on-air ones
	previewDeadbandStops: 0.1, // tighter "on target" window for the preview camera
	previewAggressiveness: 0.95, // preview camera: fix nearly all of the error in each move
	previewMinSettleMs: 180, // preview camera: react sooner after a move
	irisPerStop: 0.15, // starting guess: normalised iris change per stop. Learned per camera as it runs.
	learnIris: true, // refine irisPerStop for each camera from how the picture actually responds
	maxStep: 0.4, // largest single iris move
	aggressiveness: 0.9, // fraction of the computed correction applied per move once the lens is learned
	firstMoveAggressiveness: 0.65, // ...and before it's learned (first move doubles as a measurement)
	minSettleMs: 250, // after a move, wait at least this long...
	maxSettleMs: 1000, // ...then act as soon as the picture is stable, or after this long regardless
	stableStops: 0.06, // "stable" = the last samples agree within this many stops
	minSamples: 2, // fresh measurements needed before deciding
	irisMin: 0.0,
	irisMax: 1.0,
	irisMargin: 0.05, // when choosing a gain, leave this much iris travel spare
	invertIris: false, // set true if a higher iris value makes the picture darker
	clipLimitPct: 6, // don't brighten if more than this % of the measured area is clipped
	cooldownAfterAirMs: 1000, // after a camera leaves program, wait before touching it
	manualOverrideMs: 30000, // if someone moves iris/gain from the ATEM panel, back off this long
	gainMin: -12, // dB
	gainMax: 36, // dB
	gainStep: 2, // dB between available gain settings
	baseGains: [0, 18], // dB — the camera's native (cleanest) gains
	maxGainStep: 12, // dB per move in gain-only mode
	gainHoldMs: 3000, // after a gain change, fine-tune with iris only for this long (prevents gain hunting)
}

export const STATUS = {
	ON_AIR: 'on-air',
	PREVIEW_OK: 'preview-ok',
	PREVIEW_WARN: 'preview-warn',
	PREVIEW_ADJUSTING: 'preview-adjusting',
	HELD: 'held',
	AUTO_OFF: 'auto-off',
	FROZEN: 'frozen',
	COOLDOWN: 'cooldown',
	MANUAL: 'manual-override',
	NO_SIGNAL: 'no-signal',
	NO_IRIS: 'waiting-iris',
	NO_GAIN: 'waiting-gain',
	NO_REF: 'no-reference',
	SETTLING: 'settling',
	MEASURING: 'measuring',
	OK: 'ok',
	ADJUSTING: 'adjusting',
	REBASING: 'rebasing', // moving gain back to a base gain with iris compensation
	LIMIT_OPEN: 'limit-open', // can't get brighter
	LIMIT_CLOSED: 'limit-closed', // can't get darker
	CLIP_PROTECT: 'clip-protect',
}

const DB_PER_STOP = 6

function median(arr) {
	const s = [...arr].sort((a, b) => a - b)
	const m = s.length >> 1
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function gainSteps(t) {
	const set = new Set()
	for (let g = t.gainMin; g <= t.gainMax + 1e-9; g += t.gainStep) set.add(Math.round(g))
	for (const b of t.baseGains) if (b >= t.gainMin && b <= t.gainMax) set.add(b)
	return [...set].sort((a, b) => a - b)
}
export function distToBase(g, t) {
	if (!t.baseGains?.length) return 0
	return Math.min(...t.baseGains.map((b) => Math.abs(g - b)))
}
const isBase = (g, t) => distToBase(g, t) < 0.5

/**
 * Choose gain + iris for a wanted brightness change (stops, + = brighter).
 * Exported for testing. Returns { gain, iris, feasible, residualStops }.
 */
export function planGainIris({ iris, gain, needStops, t, irisPerStop = t.irisPerStop }) {
	const dir = t.invertIris ? -1 : 1 // sign of iris change that makes the picture brighter
	const irisFor = (stops) => iris + dir * stops * irisPerStop
	let best = null
	for (const g of gainSteps(t)) {
		const irisStops = needStops - (g - gain) / DB_PER_STOP
		const want = irisFor(irisStops)
		// Staying at the current gain may use the full iris range; switching must leave a margin
		// (hysteresis, so measurement noise can't make it flip-flop between gains).
		const m = g === gain ? 0 : t.irisMargin
		const feasible = want >= t.irisMin + m - 1e-9 && want <= t.irisMax - m + 1e-9
		const clamped = Math.min(t.irisMax, Math.max(t.irisMin, want))
		const residual = Math.abs(want - clamped) / irisPerStop
		// Cost: distance from a base gain dominates; then prefer not switching; then the smallest jump.
		const cost = feasible
			? distToBase(g, t) + (g === gain ? 0 : 0.5) + Math.abs(g - gain) * 0.01 + g * 0.001
			: 1000 + residual * 100 + distToBase(g, t) + g * 0.001
		if (!best || cost < best.cost) best = { gain: g, iris: Math.round(clamped * 1000) / 1000, feasible, residualStops: residual, cost }
	}
	return best
}

export class AutoIrisController {
	constructor() {
		this.cams = new Map()
	}

	#cam(id) {
		let c = this.cams.get(id)
		if (!c) {
			c = {
				samples: [],
				lastCommandAt: -Infinity,
				lastCommanded: { iris: null, gain: null },
				last: { iris: null, gain: null },
				lastAirAt: -Infinity,
				lastGainChangeAt: -Infinity,
				overrideUntil: -Infinity,
				adjusting: false,
				ips: null, // learned iris-per-stop for this camera's lens
				pendingProbe: null,
				probe: null,
			}
			this.cams.set(id, c)
		}
		return c
	}

	addSample(cam, t, m) {
		const c = this.#cam(cam)
		c.samples.push({ t, ...m })
		while (c.samples.length && c.samples[0].t < t - 3000) c.samples.shift()
	}

	/** Report iris/gain values from the switcher; detects changes made from the ATEM panel. */
	noteValue(cam, kind, value, now, source, tuning) {
		const c = this.#cam(cam)
		if (value == null) return
		const tol = kind === 'gain' ? 0.5 : 0.005
		const prev = c.last[kind]
		c.last[kind] = value
		if (prev == null || Math.abs(value - prev) <= tol || source !== 'switcher') return
		const ours = c.lastCommanded[kind] != null && Math.abs(value - c.lastCommanded[kind]) <= Math.max(tol, 0.01)
		const recent = now - c.lastCommandAt < 1500
		if (!ours && !recent) c.overrideUntil = now + tuning.manualOverrideMs
	}
	/** Back-compat helper. */
	noteIris(cam, value, now, source, tuning) {
		this.noteValue(cam, 'iris', value, now, source, tuning)
	}

	startOverride(cam, now, ms) {
		this.#cam(cam).overrideUntil = now + ms
	}
	clearOverride(cam) {
		this.#cam(cam).overrideUntil = -Infinity
	}

	/** Record a command that was actually sent. kind = 'iris' | 'gain'. */
	markCommanded(cam, value, now, kind = 'iris') {
		const c = this.#cam(cam)
		if (kind === 'gain' && c.last.gain !== value) c.lastGainChangeAt = now
		// A lone iris move becomes a probe we learn the lens response from; anything else cancels it.
		c.probe = kind === 'iris' && c.pendingProbe ? { ...c.pendingProbe, at: now } : null
		c.pendingProbe = null
		c.lastCommanded[kind] = value
		c.last[kind] = value
		c.lastCommandAt = now
	}

	/** Learned iris-per-stop for a camera (or the tuning default). */
	irisPerStop(cam, tuning) {
		return this.#cam(cam).ips ?? tuning.irisPerStop
	}
	/** Restore a previously learned lens response (e.g. from saved settings). */
	setIrisPerStop(cam, v) {
		if (v > 0) this.#cam(cam).ips = v
	}
	/** Forget everything learned about the lenses. */
	forgetLearned() {
		for (const c of this.cams.values()) c.ips = null
	}
	/** All learned lens responses, for saving. */
	learned() {
		const out = {}
		for (const [cam, c] of this.cams) if (c.ips) out[cam] = Math.round(c.ips * 1000) / 1000
		return out
	}

	/**
	 * Settled measurement: waits minSettleMs after the last move, then returns as soon as the
	 * latest samples agree (picture has stopped changing) — or after maxSettleMs regardless.
	 */
	settled(cam, now, tuning) {
		const c = this.#cam(cam)
		const since = c.lastCommandAt
		const fresh = c.samples.filter((s) => s.t >= since + tuning.minSettleMs && s.t >= now - 1200)
		if (fresh.length < tuning.minSamples) return null
		const recent = fresh.slice(-Math.max(tuning.minSamples, 2))
		const valid = recent.filter((s) => s.valid)
		if (valid.length < Math.ceil(recent.length / 2)) return { noSignal: true }
		const st = valid.map((s) => Math.log2(Math.max(s.luma, 1e-3)) / 0.45)
		const stable = valid.length >= 2 && Math.max(...st) - Math.min(...st) <= tuning.stableStops
		const timedOut = !Number.isFinite(since) || now - since >= tuning.maxSettleMs
		if (!stable && !timedOut) return null
		return { luma: median(valid.map((s) => s.luma)), clipPct: median(valid.map((s) => s.clipPct)) }
	}

	/**
	 * Decide what to do for one camera.
	 * @param p { cam, now, tally, iris, gain, mode, hold, autoEnabled, frozen, target, offsetStops, trimStops, tuning }
	 * @returns { status, errorStops?, luma?, actions?: [{kind:'gain'|'iris', value}] }  (actions in send order)
	 */
	step(p) {
		const pv = !!p.tally?.preview && !p.tally?.program && p.tuning.adjustPreview !== false
		if (!pv) return this.#step(p, p.tuning, false)
		// Priority settings for the camera that's about to go on air.
		const b = p.tuning
		const t = {
			...b,
			deadbandStops: Math.min(b.deadbandStops, b.previewDeadbandStops ?? b.deadbandStops),
			aggressiveness: Math.max(b.aggressiveness, b.previewAggressiveness ?? 0),
			firstMoveAggressiveness: Math.max(b.firstMoveAggressiveness, (b.previewAggressiveness ?? 0) * 0.85),
			minSettleMs: Math.min(b.minSettleMs, b.previewMinSettleMs ?? b.minSettleMs),
		}
		const r = this.#step(p, t, true)
		r.preview = true
		const working = [STATUS.ADJUSTING, STATUS.REBASING, STATUS.SETTLING, STATUS.MEASURING, STATUS.COOLDOWN].includes(r.status)
		if (r.status === STATUS.OK) r.status = STATUS.PREVIEW_OK
		else if (working) {
			r.detail = r.status
			r.status = STATUS.PREVIEW_ADJUSTING
		} else if (r.errorStops != null && Math.abs(r.errorStops) > b.previewWarnStops) {
			// can't fix it (held, frozen, auto off, at a limit, manual override…) — warn
			r.detail = r.status
			r.status = STATUS.PREVIEW_WARN
		}
		return r
	}

	#step(p, t, adjustingPreview) {
		const mode = p.mode || 'iris'
		const c = this.#cam(p.cam)
		const program = !!p.tally?.program
		const preview = !!p.tally?.preview
		if (program) c.lastAirAt = p.now

		const target = p.target ? trimmedTarget(p.target, (p.trimStops || 0) + (p.offsetStops || 0)) : null
		const meas = this.settled(p.cam, p.now, t)
		const base = { target }
		const shown = meas && !meas.noSignal ? meas : c.samples.findLast?.((s) => s.valid) ?? null
		if (shown) {
			base.luma = shown.luma
			base.clipPct = shown.clipPct
			if (target) base.errorStops = stopsError(shown.luma, target)
		}
		if (program || (preview && !adjustingPreview) || p.hold || !p.autoEnabled || p.frozen) c.adjusting = false
		const ips = c.ips ?? t.irisPerStop
		base.irisPerStop = ips

		// Learn the lens: compare the brightness change with the iris move that caused it.
		if (c.probe && meas && !meas.noSignal && target && c.lastCommandAt <= c.probe.at) {
			const pr = c.probe
			c.probe = null
			const dStops = stopsError(meas.luma, target) - pr.errBefore // + = got brighter
			const dIris = (pr.to - pr.from) * (t.invertIris ? -1 : 1) // + = opened
			if (t.learnIris && Math.abs(dIris) >= 0.01 && Math.abs(dStops) >= 0.08 && Math.sign(dStops) === Math.sign(dIris) && meas.clipPct < t.clipLimitPct) {
				const obs = Math.min(0.5, Math.max(0.02, dIris / dStops))
				c.ips = c.ips == null ? obs : c.ips * 0.5 + obs * 0.5
			}
		}

		// 1. ON AIR — hard lock.
		if (program) return { ...base, status: STATUS.ON_AIR }
		// 2. PREVIEW — locked (only when preview adjusting is switched off).
		if (preview && !adjustingPreview) {
			const warn = base.errorStops != null && Math.abs(base.errorStops) > t.previewWarnStops
			return { ...base, status: warn ? STATUS.PREVIEW_WARN : STATUS.PREVIEW_OK }
		}
		// 3. IDLE
		if (p.frozen) return { ...base, status: STATUS.FROZEN }
		if (p.hold) return { ...base, status: STATUS.HELD }
		if (!p.autoEnabled) return { ...base, status: STATUS.AUTO_OFF }
		if (!target) return { ...base, status: STATUS.NO_REF }
		if (p.now - c.lastAirAt < t.cooldownAfterAirMs) return { ...base, status: STATUS.COOLDOWN }
		if (p.now < c.overrideUntil) return { ...base, status: STATUS.MANUAL, overrideLeftMs: c.overrideUntil - p.now }
		if (p.now - c.lastCommandAt < t.minSettleMs) return { ...base, status: STATUS.SETTLING }
		if (!meas) return { ...base, status: Number.isFinite(c.lastCommandAt) && p.now - c.lastCommandAt < t.maxSettleMs ? STATUS.SETTLING : STATUS.MEASURING }
		if (meas.noSignal) return { ...base, status: STATUS.NO_SIGNAL }

		const useIris = mode !== 'gain'
		const useGain = mode !== 'iris'
		if (useIris && p.iris == null) return { ...base, status: STATUS.NO_IRIS }
		if (useGain && p.gain == null) return { ...base, status: STATUS.NO_GAIN }

		const err = stopsError(meas.luma, target)
		base.errorStops = err
		base.luma = meas.luma
		const clipping = meas.clipPct > t.clipLimitPct
		const okWindow = c.adjusting ? t.deadbandStops * 0.6 : t.deadbandStops
		const onTarget = Math.abs(err) <= okWindow && !(clipping && err >= 0)

		// Wanted change in stops (+ = brighter)
		let need = -err
		if (clipping && need > 0) {
			c.adjusting = false
			return { ...base, status: STATUS.CLIP_PROTECT }
		}
		if (clipping && Math.abs(err) <= t.deadbandStops) need = -t.deadbandStops

		const done = (status, extra = {}) => {
			c.adjusting = false
			return { ...base, status, ...extra }
		}
		const act = (status, actions) => {
			c.adjusting = true
			c.pendingProbe = actions.length === 1 && actions[0].kind === 'iris' ? { from: p.iris, to: actions[0].value, errBefore: err } : null
			return { ...base, status, actions }
		}

		// ---- gain only
		if (mode === 'gain') {
			if (onTarget) return done(STATUS.OK)
			const steps = gainSteps(t)
			let want = p.gain + Math.max(-t.maxGainStep, Math.min(t.maxGainStep, need * DB_PER_STOP))
			// snap to the nearest available gain
			want = steps.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a))
			if (want === p.gain) {
				// error smaller than one gain step, or at the end of the range
				const atEnd = need > 0 ? p.gain >= t.gainMax : p.gain <= t.gainMin
				if (atEnd) return done(need > 0 ? STATUS.LIMIT_OPEN : STATUS.LIMIT_CLOSED)
				return done(STATUS.OK, { note: 'within one gain step' })
			}
			return act(STATUS.ADJUSTING, [{ kind: 'gain', value: want }])
		}

		// ---- iris only (closed-loop small steps)
		const irisStep = () => {
			// Model-based jump: go most of the way in one move using the (learned) lens response.
			const k = c.ips != null ? t.aggressiveness : t.firstMoveAggressiveness
			let delta = need * ips * k
			delta = Math.max(-t.maxStep, Math.min(t.maxStep, delta))
			if (t.invertIris) delta = -delta
			const next = Math.max(t.irisMin, Math.min(t.irisMax, p.iris + delta))
			if (Math.abs(next - p.iris) < 0.002) return null
			return Math.round(next * 1000) / 1000
		}
		if (mode === 'iris') {
			if (onTarget) return done(STATUS.OK)
			const next = irisStep()
			if (next == null) return done(need > 0 ? STATUS.LIMIT_OPEN : STATUS.LIMIT_CLOSED)
			return act(STATUS.ADJUSTING, [{ kind: 'iris', value: next }])
		}

		// ---- both: gain first, then iris
		const gainLocked = p.now - c.lastGainChangeAt < t.gainHoldMs
		const plan = gainLocked ? { gain: p.gain } : planGainIris({ iris: p.iris, gain: p.gain, needStops: onTarget ? 0 : need, t, irisPerStop: ips })
		if (plan.gain !== p.gain) {
			// Change gain, and set the iris to compensate in the same breath (gain sent first).
			const actions = [{ kind: 'gain', value: plan.gain }]
			if (Math.abs(plan.iris - p.iris) >= 0.002) actions.push({ kind: 'iris', value: plan.iris })
			const status = onTarget ? STATUS.REBASING : STATUS.ADJUSTING
			return act(status, actions)
		}
		if (onTarget) return done(STATUS.OK)
		const next = irisStep()
		if (next == null) {
			if (gainLocked) return done(STATUS.SETTLING) // gain may move again once the hold ends
			return done(need > 0 ? STATUS.LIMIT_OPEN : STATUS.LIMIT_CLOSED)
		}
		return act(STATUS.ADJUSTING, [{ kind: 'iris', value: next }])
	}
}
