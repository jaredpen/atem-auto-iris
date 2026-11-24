// Demo mode: a simulated switcher + synthetic multiview so the whole loop can be
// tried without any hardware. Simulated cameras respond to iris commands.

import { SOURCE_PREVIEW, SOURCE_PROGRAM } from './layout.js'

const CAMS = 8
const IRIS_STOPS = 8 // full iris travel in the simulation ≈ 8 stops

export class DemoSwitcher {
	constructor(onState) {
		this.onState = onState
		this.program = 1
		this.preview = 2
		this.iris = {}
		this.gain = {}
		this.frozen = false
		this.scene = {} // per-camera lighting offset in stops
		const startGains = [0, 0, 16, 0, 6, 0, 18, 0]
		for (let i = 1; i <= CAMS; i++) {
			this.iris[i] = { normalised: 0.35 + Math.random() * 0.3, source: 'switcher', at: Date.now() }
			this.gain[i] = { db: startGains[i - 1], source: 'switcher', at: Date.now() }
			this.scene[i] = (Math.random() - 0.5) * 2 - startGains[i - 1] / 6
		}
		this.#emit()
	}

	get state() {
		const tally = {}
		for (let i = 1; i <= CAMS; i++) tally[i] = { program: i === this.program, preview: i === this.preview }
		const inputs = {}
		for (let i = 1; i <= CAMS; i++) inputs[i] = { shortName: `CAM${i}`, longName: `Camera ${i}` }
		const windows = [
			{ index: 0, source: SOURCE_PREVIEW },
			{ index: 1, source: SOURCE_PROGRAM },
		]
		for (let i = 1; i <= CAMS; i++) windows.push({ index: i + 1, source: i })
		return { connected: true, demo: true, ip: 'demo', modelName: 'Simulated switcher', inputs, tally, multiview: { layout: 12, swapped: false, windows }, iris: this.iris, gain: this.gain, frozen: this.frozen }
	}

	#emit() {
		this.onState?.(this.state)
	}

	async setIris(cam, value, auto) {
		if (this.frozen) return { ok: false, reason: 'frozen' }
		if (auto && cam === this.program) return { ok: false, reason: 'on-air' }
		this.iris[cam] = { normalised: Math.min(1, Math.max(0, value)), source: 'sent', at: Date.now() }
		this.#emit()
		return { ok: true }
	}

	async setGain(cam, db, auto) {
		if (this.frozen) return { ok: false, reason: 'frozen' }
		if (auto && cam === this.program) return { ok: false, reason: 'on-air' }
		this.gain[cam] = { db: Math.round(Math.min(36, Math.max(-12, db))), source: 'sent', at: Date.now() }
		this.#emit()
		return { ok: true }
	}
	setFrozen(on) {
		this.frozen = !!on
		this.#emit()
		return this.frozen
	}
	/** Shift lighting on all idle-ish cameras by a number of stops. */
	shiftLighting(stops) {
		for (let i = 1; i <= CAMS; i++) this.scene[i] += stops
		this.#emit()
	}

	setPreview(cam) {
		this.preview = cam
		this.#emit()
	}
	cut() {
		;[this.program, this.preview] = [this.preview, this.program]
		this.#emit()
	}
	/** Simulate a lighting change on some cameras. */
	changeLighting() {
		for (let i = 1; i <= CAMS; i++) if (Math.random() < 0.6) this.scene[i] += (Math.random() - 0.5) * 2.5
		this.#emit()
	}
	/** Simulate an operator moving the iris on the ATEM panel. */
	externalGain(cam, db) {
		this.gain[cam] = { db, source: 'switcher', at: Date.now() }
		this.#emit()
	}
	externalIris(cam, value) {
		this.iris[cam] = { normalised: value, source: 'switcher', at: Date.now() }
		this.#emit()
	}

	/** Encoded-signal multiplier for a camera given its iris and lighting. */
	gainFor(cam) {
		const stops = this.scene[cam] + (this.iris[cam].normalised - 0.5) * IRIS_STOPS + this.gain[cam].db / 6
		return Math.pow(Math.pow(2, stops), 0.45)
	}
}

// ---------------------------------------------------------------- synthetic multiview
function makeScene(seed) {
	const c = document.createElement('canvas')
	c.width = 480
	c.height = 270
	const g = c.getContext('2d')
	const hue = (seed * 47) % 360
	const grad = g.createLinearGradient(0, 0, 480, 270)
	grad.addColorStop(0, `hsl(${hue},25%,32%)`)
	grad.addColorStop(1, `hsl(${(hue + 60) % 360},20%,18%)`)
	g.fillStyle = grad
	g.fillRect(0, 0, 480, 270)
	// some set dressing
	g.fillStyle = `hsl(${(hue + 180) % 360},30%,40%)`
	g.fillRect(30 + seed * 20, 160, 120, 90)
	g.fillStyle = 'hsl(40,15%,70%)'
	g.fillRect(360 - seed * 10, 40, 70, 50) // a bright-ish window
	// "presenter"
	g.fillStyle = 'hsl(25,45%,52%)'
	g.beginPath()
	g.arc(240, 105, 36, 0, Math.PI * 2)
	g.fill()
	g.fillStyle = `hsl(${(hue + 200) % 360},35%,30%)`
	g.beginPath()
	g.ellipse(240, 250, 85, 100, 0, 0, Math.PI * 2)
	g.fill()
	return c
}

export class DemoMultiview {
	constructor(sw) {
		this.sw = sw
		this.canvas = document.createElement('canvas')
		this.canvas.width = 1920
		this.canvas.height = 1080
		this.ctx = this.canvas.getContext('2d')
		this.scenes = {}
		for (let i = 1; i <= CAMS; i++) this.scenes[i] = makeScene(i)
		this.t0 = performance.now()
		this.timer = setInterval(() => this.draw(), 40)
		this.draw()
	}

	stream() {
		return this.canvas.captureStream(25)
	}

	stop() {
		clearInterval(this.timer)
	}

	#tile(cam, x, y, w, h, label, border) {
		const g = this.ctx
		g.save()
		const wobble = 1 + 0.015 * Math.sin((performance.now() - this.t0) / 900 + cam) // a little life
		g.filter = `brightness(${(this.sw.gainFor(cam) * wobble).toFixed(3)})`
		g.drawImage(this.scenes[cam], x, y, w, h)
		g.restore()
		if (border) {
			g.strokeStyle = border
			g.lineWidth = 6
			g.strokeRect(x + 3, y + 3, w - 6, h - 6)
		}
		g.fillStyle = 'rgba(0,0,0,0.65)'
		const lh = Math.max(22, h * 0.09)
		g.fillRect(x + w / 2 - 70, y + h - lh - 6, 140, lh)
		g.fillStyle = '#fff'
		g.font = `${Math.round(lh * 0.7)}px Helvetica, Arial`
		g.textAlign = 'center'
		g.textBaseline = 'middle'
		g.fillText(label, x + w / 2, y + h - lh / 2 - 6)
	}

	draw() {
		const g = this.ctx
		g.fillStyle = '#000'
		g.fillRect(0, 0, 1920, 1080)
		const { program, preview } = this.sw
		this.#tile(preview, 0, 0, 960, 540, 'PREVIEW', '#1fbf4a')
		this.#tile(program, 960, 0, 960, 540, 'PROGRAM', '#e02424')
		for (let i = 1; i <= CAMS; i++) {
			const idx = i - 1
			const x = (idx % 4) * 480
			const y = 540 + Math.floor(idx / 4) * 270
			const border = i === program ? '#e02424' : i === preview ? '#1fbf4a' : null
			this.#tile(i, x, y, 480, 270, `CAM${i}`, border)
		}
		g.strokeStyle = '#444'
		g.lineWidth = 2
		for (let i = 1; i < 4; i++) {
			g.beginPath()
			g.moveTo(i * 480, 540)
			g.lineTo(i * 480, 1080)
			g.stroke()
		}
	}
}
