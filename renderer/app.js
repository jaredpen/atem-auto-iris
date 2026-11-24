// ATEM Auto-Iris — renderer: video capture, measurement, controller loop and UI.

import { measureRegion, stopsError, trimmedTarget } from './analysis.js'
import { AutoIrisController, DEFAULT_TUNING, STATUS } from './controller.js'

// Response presets (speed vs. smoothness of corrections on idle cameras)
const RESPONSE_PRESETS = {
	smooth: { maxStep: 0.08, aggressiveness: 0.6, firstMoveAggressiveness: 0.5, minSettleMs: 400, maxSettleMs: 1500, stableStops: 0.06, maxGainStep: 6 },
	fast: { maxStep: 0.4, aggressiveness: 0.9, firstMoveAggressiveness: 0.65, minSettleMs: 250, maxSettleMs: 1000, stableStops: 0.06, maxGainStep: 12 },
	snap: { maxStep: 0.6, aggressiveness: 1.0, firstMoveAggressiveness: 0.8, minSettleMs: 180, maxSettleMs: 700, stableStops: 0.08, maxGainStep: 18 },
}
const TUNING_VERSION = 2
import { LAYOUTS, layoutTiles, defaultSources, measureRect, SOURCE_PREVIEW, SOURCE_PROGRAM } from './layout.js'
import { DemoSwitcher, DemoMultiview } from './demo.js'

const $ = (id) => document.getElementById(id)
const api = window.atemApi ?? null // undefined only when opened in a plain browser

// ---------------------------------------------------------------- settings
const DEFAULT_SETTINGS = {
	atemIp: '',
	deviceId: '',
	reference: null, // { cam, luma, at }
	trimStops: 0,
	trimStep: 0.2,
	controlMode: 'iris', // 'iris' | 'gain' | 'both'
	offsets: {}, // cam -> stops
	holds: {}, // cam -> bool
	mapping: { mode: 'auto', layout: 12, sources: null },
	tuning: { ...DEFAULT_TUNING },
	tuningVersion: TUNING_VERSION,
	response: 'fast',
	learned: {}, // cam -> learned iris-per-stop
	update: { repo: '', token: '' },
}
let S = structuredClone(DEFAULT_SETTINGS)
let saveTimer = null
function save() {
	clearTimeout(saveTimer)
	saveTimer = setTimeout(() => {
		if (api) api.saveSettings(S)
		else localStorage.setItem('atemAutoIris', JSON.stringify(S))
	}, 300)
}
async function load() {
	let s = null
	try {
		s = api ? await api.loadSettings() : JSON.parse(localStorage.getItem('atemAutoIris') || 'null')
	} catch {}
	if (s) {
		S = { ...structuredClone(DEFAULT_SETTINGS), ...s }
		S.tuning = { ...DEFAULT_TUNING, ...(s.tuning ?? {}) }
		S.mapping = { ...DEFAULT_SETTINGS.mapping, ...(s.mapping ?? {}) }
		S.update = { ...DEFAULT_SETTINGS.update, ...(s.update ?? {}) }
		if ((s.tuningVersion ?? 1) < TUNING_VERSION) {
			// v1.1 → v1.2: move to the faster timing defaults; keep the user's other choices.
			for (const k of ['maxStep', 'irisPerStop', 'cooldownAfterAirMs', 'gainHoldMs', 'maxGainStep', 'minSamples']) S.tuning[k] = DEFAULT_TUNING[k]
			delete S.tuning.settleMs
			Object.assign(S.tuning, RESPONSE_PRESETS.fast)
			S.response = 'fast'
			S.tuningVersion = TUNING_VERSION
			save()
		}
	}
	for (const [cam, v] of Object.entries(S.learned ?? {})) ctl.setIrisPerStop(Number(cam), v)
}

// ---------------------------------------------------------------- runtime state
let mode = null // 'atem' | 'demo' | null
let sw = { connected: false, inputs: {}, tally: {}, multiview: null, iris: {} } // latest switcher state
let demo = null
let demoMv = null
let autoEnabled = false // always starts OFF for safety
let frozen = false
const ctl = new AutoIrisController()
const results = {} // cam -> last controller result
const inFlight = {}
const lastLoggedStatus = {}
let stream = null

// ---------------------------------------------------------------- logging
function log(msg, level = 'info') {
	const el = document.createElement('div')
	el.className = level
	const t = new Date().toLocaleTimeString([], { hour12: false })
	el.innerHTML = `<span class="t">${t}</span>`
	el.append(document.createTextNode(msg))
	const box = $('log')
	box.prepend(el)
	while (box.childElementCount > 300) box.lastChild.remove()
}

// ---------------------------------------------------------------- switcher abstraction
function camName(id) {
	const i = sw.inputs?.[id]
	return i?.shortName || `CAM${id}`
}
function irisOf(cam) {
	return sw.iris?.[cam]?.normalised ?? null
}
function gainOf(cam) {
	return sw.gain?.[cam]?.db ?? null
}
async function setIris(cam, value, auto) {
	if (frozen) return { ok: false, reason: 'frozen' }
	if (mode === 'demo') return demo.setIris(cam, value, auto)
	if (mode === 'atem' && api) return api.setIris(cam, value, auto)
	return { ok: false, reason: 'no switcher' }
}
async function setGain(cam, db, auto) {
	if (frozen) return { ok: false, reason: 'frozen' }
	if (mode === 'demo') return demo.setGain(cam, db, auto)
	if (mode === 'atem' && api) return api.setGain(cam, db, auto)
	return { ok: false, reason: 'no switcher' }
}
const fmtGain = (db) => (db == null ? '— dB' : `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db)} dB`)
function onSwitcherState(state) {
	sw = state
	if (typeof state.frozen === 'boolean' && state.frozen !== frozen) {
		frozen = state.frozen
		if (frozen) autoEnabled = false
	}
	const now = performance.now()
	for (const [cam, i] of Object.entries(sw.iris ?? {})) {
		ctl.noteValue(Number(cam), 'iris', i?.normalised ?? null, now, i?.source, S.tuning)
	}
	for (const [cam, g] of Object.entries(sw.gain ?? {})) {
		ctl.noteValue(Number(cam), 'gain', g?.db ?? null, now, g?.source, S.tuning)
	}
	renderHeader()
	renderDemoBar()
}

async function connectAtem(ip) {
	ip = ip.trim()
	if (!ip) return log('Enter the switcher IP address first', 'warn')
	if (!api) return log('Switcher connection only works inside the desktop app', 'error')
	stopDemo()
	S.atemIp = ip
	save()
	mode = 'atem'
	syncIpFields()
	await api.connect(ip)
	renderHeader()
}
async function disconnectAtem() {
	if (api) await api.disconnect()
	mode = null
	sw = { connected: false, inputs: {}, tally: {}, multiview: null, iris: {} }
	renderHeader()
}

async function startDemo() {
	if (mode === 'atem' && api) await api.disconnect()
	stopDemo()
	mode = 'demo'
	demo = new DemoSwitcher(onSwitcherState)
	demoMv = new DemoMultiview(demo)
	setStream(demoMv.stream(), 'Simulated multiview')
	log('Demo mode: simulated switcher and cameras. Nothing is sent to real hardware.')
	renderDeviceSelects()
	buildDemoButtons()
	renderHeader()
}
function stopDemo() {
	if (mode !== 'demo') return
	demoMv?.stop()
	demo = null
	demoMv = null
	mode = null
	setStream(null)
	sw = { connected: false, inputs: {}, tally: {}, multiview: null, iris: {} }
	$('demoBar').hidden = true
	renderDeviceSelects()
}

// ---------------------------------------------------------------- video capture
let devices = []
async function listDevices() {
	try {
		// Labels are only visible after permission has been granted once.
		const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
		tmp.getTracks().forEach((t) => t.stop())
	} catch (e) {
		log(`Camera permission / capture not available: ${e.message}. On macOS check System Settings → Privacy & Security → Camera.`, 'warn')
	}
	try {
		devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
	} catch {
		devices = []
	}
	renderDeviceSelects()
}
function renderDeviceSelects() {
	for (const id of ['deviceSelect', 'sDeviceSelect']) {
		const sel = $(id)
		sel.innerHTML = ''
		if (mode === 'demo') {
			sel.append(new Option('Simulated multiview (demo)', '__demo'))
			sel.disabled = true
			continue
		}
		sel.disabled = false
		sel.append(new Option('— choose capture device —', ''))
		for (const d of devices) sel.append(new Option(d.label || `Video device ${d.deviceId.slice(0, 6)}`, d.deviceId))
		sel.value = devices.some((d) => d.deviceId === S.deviceId) ? S.deviceId : ''
	}
}
async function openDevice(deviceId) {
	S.deviceId = deviceId
	save()
	renderDeviceSelects()
	if (!deviceId) return setStream(null)
	try {
		const s = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
		})
		const label = devices.find((d) => d.deviceId === deviceId)?.label ?? 'capture device'
		setStream(s, label)
	} catch (e) {
		log(`Could not open capture device: ${e.message}`, 'error')
		setStream(null)
	}
}
function setStream(s, label = '') {
	if (stream && stream !== s) stream.getTracks().forEach((t) => t.stop())
	stream = s
	const v = $('mv')
	v.srcObject = s
	$('noVideo').hidden = !!s
	const pill = $('videoPill')
	if (s) {
		const set = s.getVideoTracks()[0]?.getSettings?.() ?? {}
		pill.textContent = `Video: ${label}${set.width ? ` · ${set.width}×${set.height}` : ''}`
		pill.className = 'pill on'
		log(`Video source: ${label}`)
	} else {
		pill.textContent = 'Video: none'
		pill.className = 'pill off'
	}
}

// ---------------------------------------------------------------- mapping
function currentMapping() {
	const mv = sw.multiview
	if (S.mapping.mode === 'auto' && mv && mv.layout != null && mv.windows?.length) {
		const sources = {}
		for (const w of mv.windows) sources[w.index] = w.source
		return { layout: mv.layout, sources, from: 'switcher' }
	}
	const layout = S.mapping.layout ?? 12
	return { layout, sources: S.mapping.sources ?? defaultSources(layout), from: S.mapping.mode === 'auto' ? 'default' : 'manual' }
}
/** Tiles that show a camera input we can control. */
function cameraTiles() {
	const m = currentMapping()
	return layoutTiles(m.layout)
		.map((t) => ({ ...t, source: m.sources[t.index] ?? 0 }))
		.filter((t) => t.source >= 1 && t.source <= 40)
}
function allTiles() {
	const m = currentMapping()
	return layoutTiles(m.layout).map((t) => ({ ...t, source: m.sources[t.index] ?? 0 }))
}
function sourceLabel(s) {
	if (s === SOURCE_PROGRAM) return 'Program'
	if (s === SOURCE_PREVIEW) return 'Preview'
	if (s >= 1 && s <= 40) return camName(s)
	return s ? `Source ${s}` : '—'
}

// ---------------------------------------------------------------- measurement + control loop
const ana = document.createElement('canvas')
ana.width = 960
ana.height = 540
const anaCtx = ana.getContext('2d', { willReadFrequently: true })
let lastFrame = null // ImageData

function tick() {
	const v = $('mv')
	const now = performance.now()
	const tiles = cameraTiles()
	if (stream && v.readyState >= 2 && v.videoWidth) {
		anaCtx.drawImage(v, 0, 0, ana.width, ana.height)
		lastFrame = anaCtx.getImageData(0, 0, ana.width, ana.height)
		for (const t of tiles) {
			const m = measureRegion(lastFrame.data, ana.width, ana.height, measureRect(t))
			ctl.addSample(t.source, now, m)
		}
	}

	const ref = S.reference
	// Preview cameras first: they're next on air, so they get priority.
	const ordered = [...tiles].sort((a, b) => !!sw.tally?.[b.source]?.preview - !!sw.tally?.[a.source]?.preview)
	for (const t of ordered) {
		const cam = t.source
		const r = ctl.step({
			cam,
			now,
			tally: sw.tally?.[cam],
			iris: irisOf(cam),
			gain: gainOf(cam),
			mode: S.controlMode,
			frozen,
			hold: !!S.holds[cam],
			autoEnabled: autoEnabled && sw.connected && !!stream,
			target: ref?.luma ?? null,
			offsetStops: S.offsets[cam] ?? 0,
			trimStops: S.trimStops,
			tuning: S.tuning,
		})
		results[cam] = r
		noteStatusChange(cam, r)
		if (r.actions?.length && !inFlight[cam] && !frozen) sendActions(cam, r)
	}
	renderOverlay(tiles)
	renderCams(tiles)
}

async function sendActions(cam, r) {
	inFlight[cam] = true
	const parts = []
	try {
		// Actions arrive in send order: gain first, then iris.
		// When a gain change comes with an iris compensation, the pair is atomic: the iris always
		// follows the gain (milliseconds later), even if the camera was cut to air in between —
		// otherwise it could go on air with the new gain but without the matching iris.
		for (let i = 0; i < r.actions.length; i++) {
			const a = r.actions[i]
			const compensation = i > 0
			if (frozen) break
			if (!compensation && sw.tally?.[cam]?.program) {
				log(`${camName(cam)} went on air — change cancelled`, 'warn')
				break
			}
			const from = a.kind === 'gain' ? gainOf(cam) : irisOf(cam)
			ctl.markCommanded(cam, a.value, performance.now(), a.kind)
			const auto = !compensation
			const res = a.kind === 'gain' ? await setGain(cam, a.value, auto) : await setIris(cam, a.value, auto)
			if (!res?.ok) {
				if (res?.reason === 'on-air') log(`${camName(cam)} went on air — change blocked`, 'warn')
				else if (res?.reason !== 'frozen') log(`${camName(cam)} ${a.kind} command failed: ${res?.reason}`, 'error')
				break
			}
			parts.push(a.kind === 'gain' ? `gain ${fmtGain(from)} → ${fmtGain(a.value)}` : `iris ${from?.toFixed(3)} → ${a.value.toFixed(3)}`)
		}
		if (parts.length) {
			const why = r.status === STATUS.REBASING ? 'back to base gain' : `${Math.abs(r.errorStops).toFixed(2)} st ${r.errorStops > 0 ? 'bright' : 'dark'}`
			log(`${camName(cam)} ${parts.join(', ')}  (${why})`)
		}
	} finally {
		inFlight[cam] = false
	}
}

function noteStatusChange(cam, r) {
	const prev = lastLoggedStatus[cam]
	if (prev === r.status) return
	lastLoggedStatus[cam] = r.status
	const n = camName(cam)
	if (r.status === STATUS.PREVIEW_WARN)
		log(`${n} is on PREVIEW and ${fmtErr(r.errorStops)} off target — ${r.detail ? `can't fix it (${STATUS_TEXT[r.detail] ?? r.detail})` : 'not adjusting (preview is locked)'}`, 'warn')
	else if (r.status === STATUS.LIMIT_OPEN) log(`${n}: can't go brighter — ${S.controlMode === 'iris' ? 'iris fully open; add gain or remove ND' : S.controlMode === 'gain' ? 'gain at maximum; open iris or remove ND' : 'iris open and gain at maximum; remove ND or add light'}`, 'warn')
	else if (r.status === STATUS.LIMIT_CLOSED) log(`${n}: can't go darker — ${S.controlMode === 'iris' ? 'iris fully closed; add ND or lower gain' : S.controlMode === 'gain' ? 'gain at minimum; close iris or add ND' : 'iris closed and gain at minimum; add ND'}`, 'warn')
	else if (r.status === STATUS.NO_GAIN && autoEnabled) log(`${n}: no gain value from the switcher yet — set its gain once (here or on the panel)`, 'warn')
	else if (r.status === STATUS.CLIP_PROTECT) log(`${n}: highlights clipping — not opening further`, 'warn')
	else if (r.status === STATUS.MANUAL) log(`${n}: iris moved from the ATEM panel — auto backing off for ${Math.round(S.tuning.manualOverrideMs / 1000)} s`)
	else if (r.status === STATUS.NO_IRIS && autoEnabled) log(`${n}: no iris value from the switcher yet — nudge its iris once (here or on the panel)`, 'warn')
	else if (r.status === STATUS.OK && prev === STATUS.ADJUSTING) log(`${n}: settled on target`)
}

// ---------------------------------------------------------------- rendering
const STATUS_TEXT = {
	[STATUS.ON_AIR]: 'ON AIR · locked',
	[STATUS.PREVIEW_OK]: 'PREVIEW · ready',
	[STATUS.PREVIEW_WARN]: 'PREVIEW · off target',
	[STATUS.PREVIEW_ADJUSTING]: 'PREVIEW · adjusting',
	[STATUS.HELD]: 'held',
	[STATUS.AUTO_OFF]: 'auto off',
	[STATUS.COOLDOWN]: 'just off air',
	[STATUS.MANUAL]: 'manual override',
	[STATUS.NO_SIGNAL]: 'no signal',
	[STATUS.NO_IRIS]: 'waiting for iris value',
	[STATUS.NO_REF]: 'no reference set',
	[STATUS.SETTLING]: 'settling',
	[STATUS.MEASURING]: 'measuring',
	[STATUS.OK]: 'on target',
	[STATUS.ADJUSTING]: 'adjusting',
	[STATUS.LIMIT_OPEN]: 'at limit · too dark',
	[STATUS.LIMIT_CLOSED]: 'at limit · too bright',
	[STATUS.FROZEN]: 'FROZEN',
	[STATUS.NO_GAIN]: 'waiting for gain value',
	[STATUS.REBASING]: 'moving to base gain',
	[STATUS.CLIP_PROTECT]: 'clipping',
}
const fmtErr = (e) => (e == null ? '—' : `${e > 0 ? '+' : e < 0 ? '−' : '±'}${Math.abs(e).toFixed(2)} st`)
const errClass = (e) => (e == null ? '' : Math.abs(e) <= S.tuning.deadbandStops ? 'err-ok' : e > 0 ? 'err-hi' : 'err-lo')

function renderOverlay(tiles) {
	const ov = $('overlay')
	const all = allTiles()
	const key = all.map((t) => `${t.index}:${t.source}`).join(',')
	if (ov.dataset.key !== key) {
		ov.dataset.key = key
		ov.innerHTML = ''
		for (const t of all) {
			const d = document.createElement('div')
			d.className = 'tileOv' + (t.w > 0.3 ? ' big' : '')
			d.style.cssText = `left:${t.x * 100}%;top:${t.y * 100}%;width:${t.w * 100}%;height:${t.h * 100}%`
			d.dataset.src = t.source
			const isCam = t.source >= 1 && t.source <= 40
			if (isCam) {
				const mr = measureRect({ x: 0, y: 0, w: 1, h: 1 })
				const m = document.createElement('div')
				m.className = 'measure'
				m.style.cssText = `left:${mr.x * 100}%;top:${mr.y * 100}%;width:${mr.w * 100}%;height:${mr.h * 100}%`
				d.append(m)
			}
			const tag = document.createElement('div')
			tag.className = 'tag'
			d.append(tag)
			ov.append(d)
		}
	}
	for (const d of ov.children) {
		const src = Number(d.dataset.src)
		const tag = d.querySelector('.tag')
		if (!(src >= 1 && src <= 40)) {
			tag.innerHTML = `<span>${sourceLabel(src)}</span>`
			continue
		}
		const r = results[src] ?? {}
		const luma = r.luma != null ? `${Math.round(r.luma * 100)}%` : '—'
		tag.innerHTML = `<span>${sourceLabel(src)}</span><span class="st-${r.status}">${STATUS_TEXT[r.status] ?? '…'}</span><span>${luma} ${fmtErr(r.errorStops)}</span>`
	}
}

let camRowsKey = ''
function renderCams(tiles) {
	const list = $('camList')
	const cams = [...new Set(tiles.map((t) => t.source))].sort((a, b) => a - b)
	const key = cams.join(',') + '|' + cams.map(camName).join(',')
	if (key !== camRowsKey) {
		camRowsKey = key
		list.innerHTML = cams.length ? '' : '<div class="hint">No camera tiles yet — connect the switcher or check the multiview mapping.</div>'
		for (const cam of cams) list.append(buildCamRow(cam))
	}
	const ref = S.reference
	for (const row of list.querySelectorAll('.cam')) {
		const cam = Number(row.dataset.cam)
		const r = results[cam] ?? {}
		const t = sw.tally?.[cam] ?? {}
		const tl = row.querySelector('.tally')
		tl.className = 'tally' + (t.program ? ' pgm' : t.preview ? ' pvw' : '')
		tl.textContent = t.program ? 'ON AIR' : t.preview ? 'PVW' : 'idle'
		row.querySelector('.fill').style.width = `${Math.min(100, (r.luma ?? 0) * 100)}%`
		const tgt = r.target ?? (ref ? trimmedTarget(ref.luma, S.trimStops + (S.offsets[cam] ?? 0)) : null)
		const tm = row.querySelector('.target')
		const band = row.querySelector('.band')
		if (tgt) {
			tm.style.display = band.style.display = ''
			tm.style.left = `${tgt * 100}%`
			const lo = trimmedTarget(tgt, -S.tuning.deadbandStops)
			const hi = trimmedTarget(tgt, S.tuning.deadbandStops)
			band.style.left = `${lo * 100}%`
			band.style.width = `${(hi - lo) * 100}%`
		} else tm.style.display = band.style.display = 'none'
		const e = row.querySelector('.err')
		e.textContent = fmtErr(r.errorStops)
		e.className = 'err ' + errClass(r.errorStops)
		row.querySelector('.luma').textContent = r.luma != null ? `${Math.round(r.luma * 100)}%` : '—'
		let st = STATUS_TEXT[r.status] ?? ''
		if (r.status === STATUS.MANUAL && r.overrideLeftMs) st += ` (${Math.ceil(r.overrideLeftMs / 1000)} s)`
		row.querySelector('.status').textContent = st
		row.querySelector('.resume').hidden = r.status !== STATUS.MANUAL
		const iris = irisOf(cam)
		const fn = sw.iris?.[cam]?.fNumber
		row.querySelector('.irisVal').textContent = iris == null ? 'iris —' : `iris ${iris.toFixed(3)}${fn ? ` · f/${fn}` : ''}`
		const g = gainOf(cam)
		const gv = row.querySelector('.gainVal')
		gv.textContent = fmtGain(g)
		gv.className = 'gainVal' + (g == null ? '' : S.tuning.baseGains.includes(g) ? ' base' : ' offbase')
		gv.title = g == null ? '' : S.tuning.baseGains.includes(g) ? 'Base gain (cleanest)' : 'Not a base gain — noisier than necessary'
		const slider = row.querySelector('input[type=range]')
		if (document.activeElement !== slider && iris != null) slider.value = iris
		const canSend = sw.connected && !frozen
		slider.disabled = !canSend
		row.querySelector('.gDown').disabled = row.querySelector('.gUp').disabled = !canSend
	}
}

function buildCamRow(cam) {
	const row = document.createElement('div')
	row.className = 'cam'
	row.dataset.cam = cam
	row.innerHTML = `
		<div class="name">${camName(cam)}<span class="tally">idle</span><span class="status"></span></div>
		<div>
			<div class="meter"><div class="band"></div><div class="fill"></div><div class="target"></div></div>
			<div class="line"><span class="luma">—</span><span class="err">—</span><span class="irisVal">iris —</span><span class="gainVal">— dB</span></div>
			<div class="line ctrl">
				<label title="Never auto-adjust this camera"><input type="checkbox" class="hold" /> Hold</label>
				<input type="range" min="0" max="1" step="0.005" title="Manual iris" />
				<button class="gDown small ghost" title="Gain down">−dB</button><button class="gUp small ghost" title="Gain up">+dB</button>
				<label title="Per-camera exposure offset in stops">±<input type="number" class="offset" step="0.1" min="-3" max="3" /></label>
				<button class="resume small ghost" hidden title="Stop backing off after a manual change">Resume</button>
			</div>
		</div>`
	const hold = row.querySelector('.hold')
	hold.checked = !!S.holds[cam]
	hold.onchange = () => {
		S.holds[cam] = hold.checked
		save()
		log(`${camName(cam)} ${hold.checked ? 'held — auto will not touch it' : 'released to auto'}`)
	}
	const off = row.querySelector('.offset')
	off.value = (S.offsets[cam] ?? 0).toFixed(1)
	off.onchange = () => {
		S.offsets[cam] = Math.max(-3, Math.min(3, Number(off.value) || 0))
		save()
	}
	const slider = row.querySelector('input[type=range]')
	slider.oninput = throttle(() => manualIris(cam, Number(slider.value)), 60)
	row.querySelector('.resume').onclick = () => ctl.clearOverride(cam)
	row.querySelector('.gDown').onclick = () => manualGainNudge(cam, -1)
	row.querySelector('.gUp').onclick = () => manualGainNudge(cam, +1)
	return row
}

function manualGainNudge(cam, dir) {
	const cur = gainOf(cam) ?? 0
	const next = Math.max(S.tuning.gainMin, Math.min(S.tuning.gainMax, cur + dir * S.tuning.gainStep))
	const now = performance.now()
	ctl.markCommanded(cam, next, now, 'gain')
	ctl.startOverride(cam, now, S.tuning.manualOverrideMs)
	setGain(cam, next, false)
}

function manualIris(cam, v) {
	// Manual moves are the operator's call, so they are allowed even on air.
	// Auto then backs off this camera so it doesn't fight the operator.
	const now = performance.now()
	ctl.markCommanded(cam, v, now)
	ctl.startOverride(cam, now, S.tuning.manualOverrideMs)
	setIris(cam, v, false)
}

function renderHeader() {
	const pill = $('connPill')
	if (mode === 'demo') {
		pill.textContent = 'Switcher: DEMO (simulated)'
		pill.className = 'pill demo'
	} else if (sw.connected) {
		pill.textContent = `Switcher: ${sw.modelName || 'ATEM'} · ${sw.ip}`
		pill.className = 'pill on'
	} else if (mode === 'atem') {
		pill.textContent = `Switcher: connecting to ${S.atemIp}…`
		pill.className = 'pill off'
	} else {
		pill.textContent = 'Switcher: not connected'
		pill.className = 'pill off'
	}
	const connected = mode === 'atem'
	$('connectBtn').textContent = connected ? 'Disconnect' : 'Connect'
	$('sConnectBtn').textContent = connected ? 'Disconnect' : 'Connect'
	$('demoBtn').textContent = mode === 'demo' ? 'Leave demo mode' : 'Demo mode (no hardware)'
	$('sDemoBtn').textContent = mode === 'demo' ? 'Leave demo mode' : 'Use demo mode instead'
	$('trimVal').textContent = `${S.trimStops > 0 ? '+' : S.trimStops < 0 ? '−' : '±'}${Math.abs(S.trimStops).toFixed(1)} st`
	const ref = S.reference
	$('refInfo').textContent = ref ? `· reference ${camName(ref.cam)} @ ${Math.round(ref.luma * 100)}%` : '· no reference yet'
	$('autoEnabled').checked = autoEnabled
	$('autoEnabled').disabled = frozen
	const what = { iris: 'IRIS', gain: 'GAIN', both: 'IRIS+GAIN' }[S.controlMode]
	$('autoLabel').textContent = `AUTO ${what} ${autoEnabled ? 'ON' : 'OFF'}`
	for (const b of document.querySelectorAll('#modeSeg button')) b.classList.toggle('active', b.dataset.mode === S.controlMode)
	$('freezeBtn').hidden = frozen
	$('frozenBanner').hidden = !frozen
	document.body.classList.toggle('isFrozen', frozen)
	const ss = []
	ss.push(mode === 'demo' ? 'Demo switcher running.' : sw.connected ? `Connected to ${sw.modelName || 'switcher'}.` : 'Switcher not connected.')
	ss.push(stream ? 'Multiview video OK.' : 'No video yet.')
	$('sStatus').textContent = ss.join(' ')
}

function syncIpFields() {
	$('ipInput').value = S.atemIp || ''
	$('sIpInput').value = S.atemIp || ''
}

// ---------------------------------------------------------------- demo bar
function buildDemoButtons() {
	$('demoBar').hidden = mode !== 'demo'
	const box = $('demoPvw')
	box.innerHTML = ''
	for (let i = 1; i <= 8; i++) {
		const b = document.createElement('button')
		b.textContent = i
		b.onclick = () => demo?.setPreview(i)
		box.append(b)
	}
	renderDemoBar()
}
function renderDemoBar() {
	if (mode !== 'demo' || !demo) return
	;[...$('demoPvw').children].forEach((b, i) => {
		b.className = i + 1 === demo.program ? 'pgm' : i + 1 === demo.preview ? 'pvw' : ''
	})
}

// ---------------------------------------------------------------- mapping + tuning panels
function renderMappingPanel() {
	for (const r of document.querySelectorAll('input[name=mapMode]')) r.checked = r.value === S.mapping.mode
	const sel = $('layoutSelect')
	sel.innerHTML = ''
	for (const l of LAYOUTS) sel.append(new Option(l.label, l.value))
	const m = currentMapping()
	sel.value = m.layout
	sel.disabled = S.mapping.mode === 'auto'
	const box = $('tileMap')
	box.innerHTML = ''
	for (const t of layoutTiles(m.layout)) {
		const lab = document.createElement('label')
		lab.textContent = `Tile ${t.index + 1}`
		const s = document.createElement('select')
		s.append(new Option('—', 0), new Option('Preview', SOURCE_PREVIEW), new Option('Program', SOURCE_PROGRAM))
		for (let i = 1; i <= 8; i++) s.append(new Option(`Input ${i} (${camName(i)})`, i))
		s.value = m.sources[t.index] ?? 0
		s.disabled = S.mapping.mode === 'auto'
		s.onchange = () => {
			S.mapping.sources = { ...(S.mapping.sources ?? defaultSources(S.mapping.layout)), [t.index]: Number(s.value) }
			save()
		}
		lab.append(s)
		box.append(lab)
	}
}

const TUNING_FIELDS = [
	['deadbandStops', 'On-target window (± stops)', 0.05],
	['previewDeadbandStops', 'Preview on-target window (± stops)', 0.01],
	['previewWarnStops', 'Preview warning beyond (stops)', 0.05],
	['irisPerStop', 'Iris change per stop', 0.005],
	['maxStep', 'Largest single iris move', 0.01],
	['aggressiveness', 'Correction per move (0–1)', 0.05],
	['minSettleMs', 'Min wait after a move (ms)', 10],
	['maxSettleMs', 'Max wait after a move (ms)', 50],
	['stableStops', '"Picture settled" within (stops)', 0.01],
	['cooldownAfterAirMs', 'Wait after leaving air (ms)', 100],
	['manualOverrideMs', 'Back-off after panel move (ms)', 1000],
	['clipLimitPct', 'Clipping limit (% of frame)', 0.5],
	['irisMin', 'Iris lower limit', 0.01],
	['irisMax', 'Iris upper limit', 0.01],
	['irisMargin', 'Spare iris kept when picking gain', 0.01],
	['gainMin', 'Gain lower limit (dB)', 2],
	['gainMax', 'Gain upper limit (dB)', 2],
	['gainStep', 'Gain step (dB)', 1],
	['maxGainStep', 'Largest gain move, gain-only (dB)', 1],
	['gainHoldMs', 'Hold gain after a change (ms)', 500],
]
function renderTuning() {
	const box = $('tuning')
	box.innerHTML = ''
	const lr = document.createElement('span')
	lr.textContent = 'Response speed'
	const sr = document.createElement('select')
	for (const [v, l] of [['smooth', 'Smooth'], ['fast', 'Fast'], ['snap', 'Snap'], ['custom', 'Custom']]) sr.append(new Option(l, v))
	sr.value = S.response ?? 'fast'
	sr.onchange = () => {
		S.response = sr.value
		if (RESPONSE_PRESETS[sr.value]) Object.assign(S.tuning, RESPONSE_PRESETS[sr.value])
		save()
		renderTuning()
		log(`Response speed: ${sr.options[sr.selectedIndex].text}`)
	}
	box.append(lr, sr)
	for (const [k, label, step] of TUNING_FIELDS) {
		const l = document.createElement('span')
		l.textContent = label
		const i = document.createElement('input')
		i.type = 'number'
		i.step = step
		i.value = S.tuning[k]
		i.onchange = () => {
			const v = Number(i.value)
			if (Number.isFinite(v)) S.tuning[k] = v
			if (k in RESPONSE_PRESETS.fast) S.response = 'custom'
			save()
			if (k in RESPONSE_PRESETS.fast) sr.value = 'custom'
		}
		box.append(l, i)
	}
	const lp = document.createElement('span')
	lp.textContent = 'Adjust the preview camera (priority)'
	const cp = document.createElement('input')
	cp.type = 'checkbox'
	cp.checked = S.tuning.adjustPreview !== false
	cp.onchange = () => {
		S.tuning.adjustPreview = cp.checked
		save()
		log(cp.checked ? 'Preview camera: adjusted first, to a tighter target' : 'Preview camera: locked (only idle cameras are adjusted)')
	}
	box.append(lp, cp)
	const l = document.createElement('span')
	l.textContent = 'Invert iris direction'
	const c = document.createElement('input')
	c.type = 'checkbox'
	c.checked = !!S.tuning.invertIris
	c.onchange = () => {
		S.tuning.invertIris = c.checked
		save()
	}
	box.append(l, c)
	const lb = document.createElement('span')
	lb.textContent = 'Base gains (dB, comma separated)'
	const ib = document.createElement('input')
	ib.value = S.tuning.baseGains.join(', ')
	ib.onchange = () => {
		const v = ib.value.split(/[ ,]+/).map(Number).filter(Number.isFinite)
		S.tuning.baseGains = v.length ? v : [...DEFAULT_TUNING.baseGains]
		ib.value = S.tuning.baseGains.join(', ')
		save()
	}
	box.append(lb, ib)
	const l2 = document.createElement('span')
	l2.textContent = 'Show-exposure step (stops)'
	const i2 = document.createElement('input')
	i2.type = 'number'
	i2.step = 0.05
	i2.value = S.trimStep
	i2.onchange = () => {
		S.trimStep = Math.max(0.05, Number(i2.value) || 0.2)
		save()
	}
	box.append(l2, i2)
}

// ---------------------------------------------------------------- setup screen
let setupOpen = false
function openSetup() {
	setupOpen = true
	$('setup').hidden = false
	renderRefCamSelect()
	renderHeader()
	requestAnimationFrame(drawSetup)
}
function closeSetup() {
	setupOpen = false
	$('setup').hidden = true
}
function renderRefCamSelect() {
	const sel = $('refCam')
	const cams = [...new Set(cameraTiles().map((t) => t.source))].sort((a, b) => a - b)
	const prev = sel.value
	sel.innerHTML = ''
	for (const c of cams) sel.append(new Option(camName(c), c))
	if (!cams.length) sel.append(new Option('— no cameras yet —', ''))
	sel.value = prev && cams.includes(Number(prev)) ? prev : String(S.reference?.cam ?? cams[0] ?? '')
}
function refCam() {
	return Number($('refCam').value) || null
}
function recentMeasure(cam) {
	const c = ctl.cams.get(cam)
	if (!c) return null
	const now = performance.now()
	const v = c.samples.filter((s) => s.t > now - 1000 && s.valid)
	if (!v.length) return null
	const med = (a) => a.sort((x, y) => x - y)[a.length >> 1]
	return { luma: med(v.map((s) => s.luma)), clipPct: med(v.map((s) => s.clipPct)) }
}

const refView = $('refView')
const refCtx = refView.getContext('2d')
const histCtx = $('refHist').getContext('2d')
let refCamListKey = ''
function drawSetup() {
	if (!setupOpen) return
	requestAnimationFrame(drawSetup)
	const key = cameraTiles().map((t) => t.source).join(',')
	if (key !== refCamListKey) {
		refCamListKey = key
		renderRefCamSelect()
	}
	const cam = refCam()
	const tile = cameraTiles().find((t) => t.source === cam)
	const v = $('mv')
	refCtx.fillStyle = '#000'
	refCtx.fillRect(0, 0, refView.width, refView.height)
	if (tile && stream && v.videoWidth) {
		refCtx.drawImage(v, tile.x * v.videoWidth, tile.y * v.videoHeight, tile.w * v.videoWidth, tile.h * v.videoHeight, 0, 0, refView.width, refView.height)
		const mr = measureRect({ x: 0, y: 0, w: 1, h: 1 })
		refCtx.strokeStyle = 'rgba(255,255,255,0.35)'
		refCtx.setLineDash([8, 6])
		refCtx.strokeRect(mr.x * refView.width, mr.y * refView.height, mr.w * refView.width, mr.h * refView.height)
		refCtx.setLineDash([])
	} else {
		refCtx.fillStyle = '#8a92a3'
		refCtx.font = '22px sans-serif'
		refCtx.textAlign = 'center'
		refCtx.fillText(stream ? 'Choose a reference camera' : 'Waiting for multiview video…', refView.width / 2, refView.height / 2)
	}
	// meters
	const m = cam ? recentMeasure(cam) : null
	$('refLuma').textContent = m ? `${Math.round(m.luma * 100)}%` : '—'
	$('refClip').textContent = m ? `${m.clipPct.toFixed(1)}%` : '—'
	$('refSaved').textContent = S.reference ? `${camName(S.reference.cam)} · ${Math.round(S.reference.luma * 100)}%` : 'none'
	const iris = cam ? irisOf(cam) : null
	const fn = cam ? sw.iris?.[cam]?.fNumber : null
	$('refIrisVal').textContent = iris == null ? '—' : `${iris.toFixed(3)}${fn ? ` f/${fn}` : ''}`
	const slider = $('refIris')
	if (document.activeElement !== slider && iris != null) slider.value = iris
	slider.disabled = $('irisMinus').disabled = $('irisPlus').disabled = !(sw.connected && cam && !frozen)
	$('refGainVal').textContent = cam ? fmtGain(gainOf(cam)) : '—'
	$('refGainDown').disabled = $('refGainUp').disabled = !(sw.connected && cam && !frozen)
	$('setRef').disabled = !m
	// histogram
	drawHistogram(tile)
}
function drawHistogram(tile) {
	const W = histCtx.canvas.width
	const H = histCtx.canvas.height
	histCtx.fillStyle = '#0d0f13'
	histCtx.fillRect(0, 0, W, H)
	if (!tile || !lastFrame) return
	const m = measureRegion(lastFrame.data, ana.width, ana.height, measureRect(tile), { histogram: true })
	if (!m.hist) return
	const max = Math.max(...m.hist, 1)
	const bw = W / 64
	m.hist.forEach((n, i) => {
		const h = (n / max) * (H - 6)
		histCtx.fillStyle = i >= 61 ? '#e5484d' : i <= 1 ? '#4c8dff' : '#9aa3b5'
		histCtx.fillRect(i * bw + 1, H - h, bw - 2, h)
	})
	if (S.reference) {
		const x = trimmedTarget(S.reference.luma, S.trimStops) * W
		histCtx.fillStyle = '#f5a524'
		histCtx.fillRect(x - 1, 0, 2, H)
	}
}
function setReference() {
	const cam = refCam()
	const m = cam ? recentMeasure(cam) : null
	if (!m) return log('No stable measurement for that camera yet', 'warn')
	S.reference = { cam, luma: m.luma, at: Date.now() }
	S.trimStops = 0
	S.offsets[cam] = 0
	ctl.clearOverride(cam)
	camRowsKey = '' // rebuild rows so offsets refresh
	save()
	renderHeader()
	log(`Reference set from ${camName(cam)}: ${Math.round(m.luma * 100)}% brightness. Show trim reset to 0.`)
}

// ---------------------------------------------------------------- updates
let updInfo = null
let installArmed = false
async function initUpdates() {
	if (!api?.version) {
		$('updCard').hidden = true
		return
	}
	$('appVersion').textContent = await api.version()
	$('updRepo').value = S.update.repo || ''
	$('updToken').value = S.update.token || ''
	$('updRepo').onchange = () => {
		S.update.repo = $('updRepo').value.trim()
		save()
	}
	$('updToken').onchange = () => {
		S.update.token = $('updToken').value.trim()
		save()
	}
	$('updCheck').onclick = () => checkUpdates(true)
	$('updInstall').onclick = installUpdate
	$('updPill').onclick = () => {
		$('updCard').open = true
		$('updCard').scrollIntoView({ behavior: 'smooth' })
	}
	if (S.update.repo) setTimeout(() => checkUpdates(false), 3000)
}
async function checkUpdates(manual) {
	const st = $('updStatus')
	if (!S.update.repo) return (st.textContent = 'Enter the GitHub repository first.')
	st.textContent = 'Checking…'
	const r = await api.checkUpdate({ repo: S.update.repo, token: S.update.token })
	updInfo = r
	installArmed = false
	$('updInstall').textContent = 'Install update'
	if (!r.ok) {
		st.textContent = `Couldn't check: ${r.reason}`
		if (manual) log(`Update check failed: ${r.reason}`, 'warn')
		return
	}
	$('updInstall').hidden = !r.newer
	$('updPill').hidden = !r.newer
	$('updBadge').textContent = r.newer ? `· v${r.latest} available` : ''
	st.textContent = r.newer ? `Version ${r.latest} is available (you have ${r.current}).` : `You're up to date (v${r.current}).`
	$('updNotes').hidden = !(r.newer && r.notes)
	$('updNotes').textContent = r.notes || ''
	if (r.newer) log(`Update available: v${r.latest}`)
}
async function installUpdate() {
	if (autoEnabled) return log('Switch AUTO off before updating — the app closes during the update', 'warn')
	if (!installArmed) {
		installArmed = true
		$('updInstall').textContent = 'Click again to update now (app will close)'
		$('updStatus').textContent = "Don't update in the middle of a show. The app closes, rebuilds itself in a Terminal window (a few minutes), then reopens."
		return
	}
	$('updInstall').disabled = true
	$('updStatus').textContent = 'Downloading…'
	const r = await api.installUpdate({ repo: S.update.repo, token: S.update.token })
	if (!r.ok) {
		$('updInstall').disabled = false
		installArmed = false
		$('updInstall').textContent = 'Install update'
		$('updStatus').textContent = `Update failed: ${r.reason}`
		log(`Update failed: ${r.reason}`, 'error')
	} else $('updStatus').textContent = 'Building the new version in Terminal — this app will close now.'
}

// ---------------------------------------------------------------- helpers
function throttle(fn, ms) {
	let last = 0
	let t = null
	return (...a) => {
		const now = Date.now()
		clearTimeout(t)
		if (now - last >= ms) {
			last = now
			fn(...a)
		} else t = setTimeout(() => ((last = Date.now()), fn(...a)), ms - (now - last))
	}
}
function setTrim(v) {
	S.trimStops = Math.round(Math.max(-3, Math.min(3, v)) * 100) / 100
	save()
	renderHeader()
	log(`Show exposure ${S.trimStops >= 0 ? '+' : ''}${S.trimStops.toFixed(1)} st — idle cameras follow now; on-air/preview cameras follow once they're idle`)
}
async function setFrozen(on) {
	frozen = !!on
	if (frozen) autoEnabled = false
	if (mode === 'demo') demo?.setFrozen(frozen)
	else if (api) await api.setFrozen(frozen)
	if (mode !== 'atem' || !api) log(frozen ? 'FROZEN — this app will send no camera commands. Full control is on the ATEM.' : 'Unfrozen — auto stays off until you switch it on', frozen ? 'warn' : 'info')
	renderHeader()
}

function setAuto(on) {
	if (frozen && on) {
		$('autoEnabled').checked = false
		return log('Unfreeze first, then switch auto on', 'warn')
	}
	autoEnabled = on
	renderHeader()
	log(on ? 'AUTO-IRIS ON — adjusting idle cameras only' : 'AUTO-IRIS OFF — no automatic changes', on ? 'info' : 'warn')
	if (on && !S.reference) log('No reference exposure yet — open Reference setup first', 'warn')
}

// ---------------------------------------------------------------- wire up
async function init() {
	await load()
	syncIpFields()
	renderTuning()
	renderMappingPanel()

	if (api) {
		api.onState((s) => {
			if (mode === 'atem') {
				const mvChanged = JSON.stringify(s.multiview) !== JSON.stringify(sw.multiview)
				onSwitcherState(s)
				if (mvChanged) renderMappingPanel()
			}
		})
		api.onLog((l) => log(l.msg, l.level))
	}

	// header
	$('autoEnabled').onchange = (e) => setAuto(e.target.checked)
	$('trimUp').onclick = () => setTrim(S.trimStops + S.trimStep)
	$('trimDown').onclick = () => setTrim(S.trimStops - S.trimStep)
	$('trimReset').onclick = () => setTrim(0)
	$('openSetup').onclick = openSetup
	$('freezeBtn').onclick = () => setFrozen(true)
	$('unfreezeBtn').onclick = () => setFrozen(false)
	for (const b of document.querySelectorAll('#modeSeg button'))
		b.onclick = () => {
			S.controlMode = b.dataset.mode
			save()
			renderHeader()
			log(`Auto control: ${{ iris: 'iris only', gain: 'gain only', both: 'gain first (kept near base gain), then iris' }[S.controlMode]}`)
		}
	window.addEventListener('keydown', (e) => {
		if (e.target.matches('input, select, textarea')) return
		if (e.key === ']') setTrim(S.trimStops + S.trimStep)
		else if (e.key === '[') setTrim(S.trimStops - S.trimStep)
		else if (e.key === 'a' || e.key === 'A') setAuto(!autoEnabled)
		else if (e.key === 'Escape') setFrozen(true)
	})

	// sources
	const onDevice = (e) => openDevice(e.target.value)
	$('deviceSelect').onchange = onDevice
	$('sDeviceSelect').onchange = onDevice
	$('refreshDevices').onclick = listDevices
	navigator.mediaDevices?.addEventListener?.('devicechange', listDevices)
	const onConnect = (field) => () => (mode === 'atem' ? disconnectAtem() : connectAtem($(field).value))
	$('connectBtn').onclick = onConnect('ipInput')
	$('sConnectBtn').onclick = onConnect('sIpInput')
	const onDemo = () => (mode === 'demo' ? stopDemo() || renderHeader() : startDemo())
	$('demoBtn').onclick = onDemo
	$('sDemoBtn').onclick = onDemo

	// demo bar
	$('demoCut').onclick = () => demo?.cut()
	$('demoDim').onclick = () => {
		demo?.shiftLighting(-3)
		log('Demo: stage lights down 3 stops')
	}
	$('demoBright').onclick = () => {
		demo?.shiftLighting(+3)
		log('Demo: stage lights up 3 stops')
	}
	$('demoLight').onclick = () => {
		demo?.changeLighting()
		log('Demo: lighting changed on some cameras')
	}
	$('demoPanel').onclick = () => {
		if (!demo) return
		const idle = [1, 2, 3, 4, 5, 6, 7, 8].filter((c) => c !== demo.program && c !== demo.preview)
		const cam = idle[Math.floor(Math.random() * idle.length)]
		demo.externalIris(cam, Math.random() * 0.6 + 0.2)
		log(`Demo: someone moved ${camName(cam)}'s iris on the ATEM panel`)
	}

	// mapping
	for (const r of document.querySelectorAll('input[name=mapMode]'))
		r.onchange = () => {
			S.mapping.mode = r.value
			if (r.value === 'manual' && !S.mapping.sources) {
				const m = currentMapping()
				S.mapping.layout = m.layout
				S.mapping.sources = { ...m.sources }
			}
			save()
			renderMappingPanel()
		}
	$('layoutSelect').onchange = (e) => {
		S.mapping.layout = Number(e.target.value)
		S.mapping.sources = defaultSources(S.mapping.layout)
		save()
		renderMappingPanel()
	}
	$('relearn').onclick = () => {
		ctl.forgetLearned()
		S.learned = {}
		save()
		log('Lens data cleared — the app will re-learn each lens as it adjusts')
	}
	$('tuneReset').onclick = () => {
		S.tuning = { ...DEFAULT_TUNING }
		S.response = 'fast'
		save()
		renderTuning()
	}

	// setup
	$('closeSetup').onclick = closeSetup
	$('startShow').onclick = closeSetup
	$('setRef').onclick = setReference
	$('refCam').onchange = () => {}
	const sendRef = throttle((v) => {
		const cam = refCam()
		if (cam) manualIris(cam, v)
	}, 50)
	$('refIris').oninput = (e) => sendRef(Number(e.target.value))
	const nudge = (d) => {
		const cam = refCam()
		const cur = cam ? irisOf(cam) : null
		if (cur == null) return
		manualIris(cam, Math.min(1, Math.max(0, cur + d)))
	}
	$('refGainDown').onclick = () => refCam() && manualGainNudge(refCam(), -1)
	$('refGainUp').onclick = () => refCam() && manualGainNudge(refCam(), +1)
	$('irisMinus').onclick = () => nudge(-0.01)
	$('irisPlus').onclick = () => nudge(0.01)

	await listDevices()
	if (S.deviceId && devices.some((d) => d.deviceId === S.deviceId)) await openDevice(S.deviceId)
	if (S.atemIp && api) connectAtem(S.atemIp)

	renderHeader()
	setInterval(tick, 100) // 10 measurements a second
	// remember what's been learned about each lens
	setInterval(() => {
		const l = ctl.learned()
		if (JSON.stringify(l) !== JSON.stringify(S.learned)) {
			S.learned = l
			save()
		}
	}, 5000)
	initUpdates()
	openSetup()
	log('Ready. Auto-iris starts OFF — set your reference, then switch it on.')
}

init()
