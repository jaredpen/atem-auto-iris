// Simulates cameras + tally and checks the controller obeys the on-air / preview / idle rules.
import test from 'node:test'
import assert from 'node:assert/strict'
import { AutoIrisController, DEFAULT_TUNING, STATUS, planGainIris } from '../renderer/controller.js'
import { stopsError } from '../renderer/analysis.js'

const T = { ...DEFAULT_TUNING }
const TARGET = 0.45

// Simple camera model: luma = target * 2^(0.45 * stops), stops = scene + (iris - 0.5) * 8
function lumaOf(cam) {
	const stops = cam.scene + (cam.iris - 0.5) * 8 + (cam.gain ?? 0) / 6
	return Math.min(1, TARGET * Math.pow(2, 0.45 * stops))
}

function run({ cams, tallyAt, ms = 20000, auto = true, hold = {}, mode = 'iris', frozen = false, tuning = T, step = 200 }) {
	const ctl = new AutoIrisController()
	const sent = []
	const statuses = {}
	const statusAt = {}
	for (let now = 0; now <= ms; now += step) {
		for (const [id, cam] of Object.entries(cams)) {
			const cid = Number(id)
			ctl.addSample(cid, now, { valid: true, luma: lumaOf(cam), clipPct: 0 })
			const tally = tallyAt(cid, now)
			const r = ctl.step({ cam: cid, now, tally, iris: cam.iris, gain: cam.gain ?? 0, mode, frozen, hold: !!hold[cid], autoEnabled: auto, target: TARGET, offsetStops: 0, trimStops: 0, tuning })
			;(statuses[cid] ??= []).push(r.status)
			for (const a of r.actions ?? []) {
				assert.ok(!tally.program, `command sent to on-air camera ${cid} at ${now}`)
				if (tuning.adjustPreview === false) assert.ok(!tally.preview, `command sent to locked preview camera ${cid} at ${now}`)
				sent.push({ cid, now, ...a })
				ctl.markCommanded(cid, a.value, now, a.kind)
				cam[a.kind] = a.value
			}
		}
	}
	return { sent, statuses }
}

test('idle cameras converge to target', () => {
	const cams = { 1: { scene: 1.5, iris: 0.5 }, 2: { scene: -2, iris: 0.5 }, 3: { scene: 0.4, iris: 0.6 } }
	run({ cams, tallyAt: () => ({ program: false, preview: false }) })
	for (const c of Object.values(cams)) assert.ok(Math.abs(stopsError(lumaOf(c), TARGET)) <= T.deadbandStops + 0.01, `not converged: ${stopsError(lumaOf(c), TARGET)}`)
})

test('on-air camera is never touched, even when badly exposed', () => {
	const cams = { 1: { scene: 2.5, iris: 0.5 } }
	const { sent, statuses } = run({ cams, tallyAt: () => ({ program: true, preview: false }) })
	assert.equal(sent.length, 0)
	assert.ok(statuses[1].every((s) => s === STATUS.ON_AIR))
})

test('preview lock option: preview camera is locked and warns', () => {
	const cams = { 2: { scene: -2, iris: 0.5 } }
	const { sent, statuses } = run({ cams, tallyAt: () => ({ program: false, preview: true }), tuning: { ...T, adjustPreview: false } })
	assert.equal(sent.length, 0)
	assert.equal(statuses[2].at(-1), STATUS.PREVIEW_WARN)
})

test('camera is adjusted while idle, frozen while on air, waits cooldown after', () => {
	const cams = { 1: { scene: 2, iris: 0.5 } }
	// idle 0-0.4s (too short to finish), on air 0.4-6s (last on-air tick 5.8s), idle afterwards
	const tallyAt = (_c, now) => ({ program: now >= 400 && now < 6000, preview: false })
	const { sent } = run({ cams, tallyAt, ms: 25000 })
	assert.ok(sent.every((s) => s.now < 400 || s.now >= 5800 + T.cooldownAfterAirMs), 'sent during air or cooldown')
	assert.ok(sent.some((s) => s.now >= 6000), 'never resumed after leaving air')
	assert.ok(Math.abs(stopsError(lumaOf(cams[1]), TARGET)) <= T.deadbandStops + 0.01)
})

test('held camera and auto-off are respected', () => {
	const cams = { 1: { scene: 2, iris: 0.5 } }
	assert.equal(run({ cams, tallyAt: () => ({}), hold: { 1: true } }).sent.length, 0)
	assert.equal(run({ cams, tallyAt: () => ({}), auto: false }).sent.length, 0)
})

test('iris at the limit is reported, not hammered', () => {
	const cams = { 1: { scene: -8, iris: 0.99 } }
	const { statuses } = run({ cams, tallyAt: () => ({}) })
	assert.equal(statuses[1].at(-1), STATUS.LIMIT_OPEN)
})

test('panel move from the switcher triggers back-off', () => {
	const ctl = new AutoIrisController()
	ctl.noteIris(1, 0.5, 0, 'switcher', T)
	ctl.noteIris(1, 0.7, 5000, 'switcher', T)
	for (let t = 5000; t < 6000; t += 200) ctl.addSample(1, t, { valid: true, luma: 0.9, clipPct: 0 })
	const r = ctl.step({ cam: 1, now: 6000, tally: {}, iris: 0.7, autoEnabled: true, target: TARGET, tuning: T })
	assert.equal(r.status, STATUS.MANUAL)
})

test('no step until fresh settled samples exist after a move', () => {
	const ctl = new AutoIrisController()
	for (let t = 0; t < 1000; t += 200) ctl.addSample(1, t, { valid: true, luma: 0.8, clipPct: 0 })
	ctl.markCommanded(1, 0.45, 1000)
	ctl.addSample(1, 1800, { valid: true, luma: 0.8, clipPct: 0 })
	const r = ctl.step({ cam: 1, now: 1800, tally: {}, iris: 0.45, autoEnabled: true, target: TARGET, tuning: T })
	assert.ok([STATUS.MEASURING, STATUS.SETTLING].includes(r.status), r.status)
	assert.ok(!r.actions)
})

// ------------------------------------------------------------------ gain
test('freeze stops everything', () => {
	const cams = { 1: { scene: 2, iris: 0.5 } }
	assert.equal(run({ cams, tallyAt: () => ({}), frozen: true, mode: 'both' }).sent.length, 0)
})

test('both: dark camera with iris wide open jumps to the next base gain (+18) and closes iris', () => {
	const cams = { 1: { scene: -5, iris: 0.97, gain: 0 } }
	const { sent } = run({ cams, tallyAt: () => ({}), mode: 'both' })
	assert.equal(cams[1].gain, 18)
	assert.ok(Math.abs(stopsError(lumaOf(cams[1]), TARGET)) <= T.deadbandStops + 0.01)
	const firstGain = sent.findIndex((s) => s.kind === 'gain')
	assert.ok(firstGain >= 0)
	// gain is sent before the iris compensation in the same step
	const same = sent.filter((s) => s.now === sent[firstGain].now)
	assert.equal(same[0].kind, 'gain')
})

test('both: off-base gain (+16) is moved to base (+18) even when exposure is fine', () => {
	const cam = { scene: 0, iris: 0.5, gain: 16 }
	cam.scene = -(16 / 6) // make it correctly exposed at gain 16
	const cams = { 1: cam }
	run({ cams, tallyAt: () => ({}), mode: 'both' })
	assert.equal(cams[1].gain, 18)
	assert.ok(Math.abs(stopsError(lumaOf(cams[1]), TARGET)) <= T.deadbandStops + 0.01)
})

test('both: too bright at +18 with iris closed drops back to 0 dB', () => {
	const cams = { 1: { scene: 1.5, iris: 0.03, gain: 18 } }
	run({ cams, tallyAt: () => ({}), mode: 'both' })
	assert.equal(cams[1].gain, 0)
	assert.ok(Math.abs(stopsError(lumaOf(cams[1]), TARGET)) <= T.deadbandStops + 0.01)
})

test('both: uses a non-base gain only when nothing else works', () => {
	const cams = { 1: { scene: -9, iris: 0.5, gain: 18 } } // needs more than +18 with iris fully open
	run({ cams, tallyAt: () => ({}), mode: 'both', ms: 40000 })
	assert.ok(cams[1].gain > 18 && cams[1].gain <= 36)
	assert.ok(Math.abs(stopsError(lumaOf(cams[1]), TARGET)) <= T.deadbandStops + 0.05)
})

test('both: no gain ping-pong once settled', () => {
	const cams = { 1: { scene: -5, iris: 0.97, gain: 0 }, 2: { scene: 1.5, iris: 0.03, gain: 18 } }
	const { sent } = run({ cams, tallyAt: () => ({}), mode: 'both', ms: 60000 })
	const gainMoves = sent.filter((s) => s.kind === 'gain')
	assert.ok(gainMoves.length <= 2, `too many gain moves: ${gainMoves.length}`)
})

test('gain only: never touches iris, converges with gain', () => {
	const cams = { 1: { scene: -2, iris: 0.5, gain: 0 } }
	const { sent } = run({ cams, tallyAt: () => ({}), mode: 'gain' })
	assert.ok(sent.every((s) => s.kind === 'gain'))
	assert.ok(Math.abs(stopsError(lumaOf(cams[1]), TARGET)) <= 0.2)
})

test('iris only: never touches gain', () => {
	const cams = { 1: { scene: -2, iris: 0.5, gain: 16 } }
	const { sent } = run({ cams, tallyAt: () => ({}), mode: 'iris' })
	assert.ok(sent.every((s) => s.kind === 'iris'))
	assert.equal(cams[1].gain, 16)
})

test('planner prefers staying on current base gain', () => {
	const p = planGainIris({ iris: 0.5, gain: 18, needStops: 0.5, t: T })
	assert.equal(p.gain, 18)
})

test('learns the lens response (iris per stop) from its own moves', () => {
	const ctl = new AutoIrisController()
	const cam = { scene: 2.5, iris: 0.5, gain: 0 } // plant: 0.125 iris per stop
	for (let now = 0; now <= 20000; now += 200) {
		ctl.addSample(1, now, { valid: true, luma: lumaOf(cam), clipPct: 0 })
		const r = ctl.step({ cam: 1, now, tally: {}, iris: cam.iris, gain: 0, mode: 'iris', autoEnabled: true, target: TARGET, tuning: T })
		for (const a of r.actions ?? []) {
			ctl.markCommanded(1, a.value, now, a.kind)
			cam[a.kind] = a.value
		}
	}
	const ips = ctl.irisPerStop(1, T)
	assert.ok(Math.abs(ips - 0.125) < 0.02, `learned ${ips}`)
})

test('speed: 2.5 stops off converges within ~3 s (lens not yet learned)', () => {
	const ctl = new AutoIrisController()
	const cam = { scene: 2.5, iris: 0.5, gain: 0 }
	let doneAt = null
	for (let now = 0; now <= 10000; now += 100) {
		ctl.addSample(1, now, { valid: true, luma: lumaOf(cam), clipPct: 0 })
		const r = ctl.step({ cam: 1, now, tally: {}, iris: cam.iris, gain: 0, mode: 'iris', autoEnabled: true, target: TARGET, tuning: T })
		for (const a of r.actions ?? []) {
			ctl.markCommanded(1, a.value, now, a.kind)
			cam[a.kind] = a.value
		}
		if (doneAt == null && r.status === STATUS.OK) doneAt = now
	}
	assert.ok(doneAt != null && doneAt <= 3000, `took ${doneAt} ms`)
})

test('both: gain may go above +18 when the iris cannot cover it', () => {
	const cams = { 1: { scene: -8, iris: 0.5, gain: 0 } }
	run({ cams, tallyAt: () => ({}), mode: 'both', ms: 30000 })
	assert.ok(cams[1].gain > 18, `gain ${cams[1].gain}`)
	assert.ok(Math.abs(stopsError(lumaOf(cams[1]), TARGET)) <= T.deadbandStops + 0.05)
})

test('preview camera is adjusted to a tighter target', () => {
	const cams = { 2: { scene: -2, iris: 0.5 } }
	const { sent, statuses } = run({ cams, tallyAt: () => ({ program: false, preview: true }) })
	assert.ok(sent.length > 0)
	assert.equal(statuses[2].at(-1), STATUS.PREVIEW_OK)
	assert.ok(Math.abs(stopsError(lumaOf(cams[2]), TARGET)) <= T.previewDeadbandStops + 0.01)
})

test('preview camera converges at least as fast as an idle one', () => {
	const timeTo = (tally) => {
		const cams = { 1: { scene: 2.5, iris: 0.5 } }
		const { statuses } = run({ cams, tallyAt: () => tally, step: 50, ms: 8000 })
		const ok = tally.preview ? STATUS.PREVIEW_OK : STATUS.OK
		return statuses[1].indexOf(ok) * 50
	}
	const idle = timeTo({})
	const pvw = timeTo({ preview: true })
	assert.ok(pvw > 0 && pvw <= idle, `preview ${pvw} ms vs idle ${idle} ms`)
})

test('camera cut from preview to program stops being adjusted instantly', () => {
	const cams = { 1: { scene: 3, iris: 0.5 } }
	const tallyAt = (_c, now) => (now < 300 ? { preview: true } : { program: true })
	const { sent } = run({ cams, tallyAt, ms: 5000 })
	assert.ok(sent.every((s) => s.now < 300))
})
