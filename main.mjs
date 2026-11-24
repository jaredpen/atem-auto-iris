// ATEM Auto-Iris — Electron main process
// Owns the switcher connection (tally, multiview config, camera control) and settings storage.

import { app, BrowserWindow, ipcMain, session, systemPreferences } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'
import { Atem, Commands } from 'atem-connection'
import { AtemCameraControlDirectCommandSender } from '@atem-connection/camera-control'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Blackmagic SDI camera control protocol: Lens category = 0
const CC_LENS = 0
const CC_APERTURE_FSTOP = 2 // "Aperture Value" (AV): f-number = sqrt(2^AV)
const CC_APERTURE_NORMALISED = 3 // 0.0 .. 1.0
const CC_VIDEO = 1
const CC_GAIN_DB = 13 // int8 dB

let win = null
let atem = null
let ccSender = null

const bridge = {
	connected: false,
	ip: '',
	modelName: '',
	inputs: {}, // id -> { shortName, longName }
	hwTally: {}, // from the switcher's own tally-by-source (TlSr)
	tally: {}, // id -> { program, preview } (merged)
	multiview: null, // { layout, swapped, windows: [{ index, source }] }
	iris: {}, // cam -> { normalised, fNumber, source: 'switcher'|'sent', at }
	gain: {}, // cam -> { db, source: 'switcher'|'sent', at }
	frozen: false, // when true, NO camera commands of any kind leave this app
}

// ---------------------------------------------------------------- settings
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
function loadSettings() {
	try {
		return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
	} catch {
		return null
	}
}
function saveSettings(s) {
	try {
		fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
		fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2))
		return true
	} catch (e) {
		console.error('save settings failed', e)
		return false
	}
}

// ---------------------------------------------------------------- push state to UI (coalesced)
let pushTimer = null
function pushState() {
	if (pushTimer) return
	pushTimer = setTimeout(() => {
		pushTimer = null
		if (win && !win.isDestroyed()) win.webContents.send('atem:state', bridge)
	}, 15)
}
function log(msg, level = 'info') {
	if (win && !win.isDestroyed()) win.webContents.send('atem:log', { msg, level, at: Date.now() })
}

// ---------------------------------------------------------------- tally
function recomputeTally() {
	const tally = {}
	const ensure = (id) => (tally[id] ??= { program: false, preview: false })
	// 1) Switcher's own tally (covers keys, DSKs, SuperSource, transitions)
	for (const [id, t] of Object.entries(bridge.hwTally)) {
		if (!t) continue
		const e = ensure(id)
		e.program ||= !!t.program
		e.preview ||= !!t.preview
	}
	// 2) Belt and braces: atem-connection's emulation of the same logic, merged in.
	try {
		if (atem && bridge.connected) {
			for (const id of atem.listVisibleInputs('program', 0)) ensure(id).program = true
			for (const id of atem.listVisibleInputs('preview', 0)) ensure(id).preview = true
		}
	} catch {
		/* state not complete yet */
	}
	bridge.tally = tally
}

function refreshFromState() {
	const st = atem?.state
	if (!st) return
	bridge.modelName = st.info?.productIdentifier ?? ''
	const inputs = {}
	for (const [id, inp] of Object.entries(st.inputs ?? {})) {
		if (inp) inputs[id] = { shortName: inp.shortName, longName: inp.longName }
	}
	bridge.inputs = inputs
	const mv = st.settings?.multiViewers?.[0]
	if (mv) {
		bridge.multiview = {
			layout: mv.properties?.layout ?? null,
			swapped: !!mv.properties?.programPreviewSwapped,
			windows: (mv.windows ?? []).filter(Boolean).map((w) => ({ index: w.windowIndex, source: w.source })),
		}
	}
	recomputeTally()
}

// ---------------------------------------------------------------- connection
async function connect(ip) {
	await disconnect()
	bridge.ip = ip
	atem = new Atem({})
	ccSender = new AtemCameraControlDirectCommandSender(atem)

	atem.on('connected', () => {
		bridge.connected = true
		refreshFromState()
		log(`Connected to switcher at ${ip}${bridge.modelName ? ` (${bridge.modelName})` : ''}`)
		pushState()
	})
	atem.on('disconnected', () => {
		bridge.connected = false
		bridge.hwTally = {}
		bridge.tally = {}
		log('Switcher disconnected — auto-iris paused until it reconnects', 'warn')
		pushState()
	})
	atem.on('error', (e) => log(`ATEM error: ${e}`, 'error'))
	atem.on('stateChanged', () => {
		refreshFromState()
		pushState()
	})
	atem.on('receivedCommands', (cmds) => {
		let changed = false
		for (const c of cmds) {
			if (c instanceof Commands.TallyBySourceCommand) {
				bridge.hwTally = { ...c.properties }
				changed = true
			} else if (c instanceof Commands.CameraControlUpdateCommand && c.category === CC_VIDEO && c.parameter === CC_GAIN_DB) {
				const v = c.properties?.numberData?.[0]
				if (typeof v !== 'number') continue
				bridge.gain[c.source] = { db: v, source: 'switcher', at: Date.now() }
				changed = true
			} else if (c instanceof Commands.CameraControlUpdateCommand && c.category === CC_LENS) {
				const v = c.properties?.numberData?.[0]
				if (typeof v !== 'number') continue
				const cur = (bridge.iris[c.source] ??= {})
				if (c.parameter === CC_APERTURE_NORMALISED) {
					cur.normalised = v
					cur.source = 'switcher'
					cur.at = Date.now()
					changed = true
				} else if (c.parameter === CC_APERTURE_FSTOP) {
					cur.fNumber = Math.round(Math.sqrt(Math.pow(2, v)) * 10) / 10
					changed = true
				}
			}
		}
		if (changed) {
			recomputeTally()
			pushState()
		}
	})

	try {
		await atem.connect(ip)
		log(`Connecting to ${ip}…`)
	} catch (e) {
		log(`Could not start connection: ${e?.message ?? e}`, 'error')
	}
	pushState()
}

async function disconnect() {
	if (!atem) return
	const a = atem
	atem = null
	ccSender = null
	try {
		await a.disconnect()
		await a.destroy()
	} catch {
		/* ignore */
	}
	bridge.connected = false
	bridge.hwTally = {}
	bridge.tally = {}
	pushState()
}

// ---------------------------------------------------------------- iris
// `auto` commands are refused for any input the switcher reports as on air.
// This is a second, independent safety gate behind the controller's own check.
async function setIris(cam, value, auto) {
	cam = Number(cam)
	value = Math.min(1, Math.max(0, Number(value)))
	if (bridge.frozen) return { ok: false, reason: 'frozen' }
	if (!atem || !bridge.connected || !ccSender) return { ok: false, reason: 'not-connected' }
	recomputeTally()
	if (auto && bridge.tally[cam]?.program) return { ok: false, reason: 'on-air' }
	try {
		await ccSender.lensIrisNormalised(cam, value)
		const cur = (bridge.iris[cam] ??= {})
		cur.normalised = value
		cur.source = 'sent'
		cur.at = Date.now()
		pushState()
		return { ok: true }
	} catch (e) {
		return { ok: false, reason: String(e?.message ?? e) }
	}
}

async function setGain(cam, db, auto) {
	cam = Number(cam)
	db = Math.round(Math.min(36, Math.max(-12, Number(db))))
	if (bridge.frozen) return { ok: false, reason: 'frozen' }
	if (!atem || !bridge.connected || !ccSender) return { ok: false, reason: 'not-connected' }
	recomputeTally()
	if (auto && bridge.tally[cam]?.program) return { ok: false, reason: 'on-air' }
	try {
		await ccSender.videoGain(cam, db)
		bridge.gain[cam] = { db, source: 'sent', at: Date.now() }
		pushState()
		return { ok: true }
	} catch (e) {
		return { ok: false, reason: String(e?.message ?? e) }
	}
}

function setFrozen(on) {
	bridge.frozen = !!on
	log(on ? 'FROZEN — this app will send no camera commands. Full control is on the ATEM.' : 'Unfrozen — commands allowed again (auto stays off until you switch it on)', on ? 'warn' : 'info')
	pushState()
	return bridge.frozen
}

// ---------------------------------------------------------------- updates (from a GitHub repository)
// The app checks the repo's package.json version. To update, it downloads the repo, then runs the
// same "Install ATEM Auto-Iris" build in a Terminal window and quits; the new version opens when done.
function normaliseRepo(repo) {
	return String(repo || '')
		.trim()
		.replace(/^https?:\/\/github\.com\//i, '')
		.replace(/\.git$/i, '')
		.replace(/\/+$/, '')
}
function ghHeaders(token, accept = 'application/vnd.github.raw+json') {
	const h = { 'User-Agent': 'ATEM-Auto-Iris', Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' }
	if (token) h.Authorization = `Bearer ${token.trim()}`
	return h
}
function cmpVersion(a, b) {
	const pa = String(a).split('.').map(Number)
	const pb = String(b).split('.').map(Number)
	for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
	return 0
}
async function ghFile(repo, file, token) {
	const r = await fetch(`https://api.github.com/repos/${repo}/contents/${file}`, { headers: ghHeaders(token) })
	if (!r.ok) {
		const reason =
			r.status === 404
				? 'Repository not found. Check the name — or if it is private, add an access token.'
				: r.status === 401 || r.status === 403
				? 'GitHub refused access — check the access token.'
				: `GitHub replied ${r.status}`
		throw new Error(reason)
	}
	return r.text()
}
async function checkUpdate({ repo, token }) {
	repo = normaliseRepo(repo)
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, reason: 'Enter the repository as owner/name' }
	try {
		const pkg = JSON.parse(await ghFile(repo, 'package.json', token))
		let notes = ''
		try {
			const changelog = await ghFile(repo, "CHANGELOG.md", token)
			const m = changelog.split(/\n(?=## )/).find((sec) => sec.startsWith('## '))
			notes = (m ?? '').trim()
		} catch {
			/* no changelog */
		}
		const current = app.getVersion()
		return { ok: true, repo, current, latest: pkg.version, newer: cmpVersion(pkg.version, current) > 0, notes }
	} catch (e) {
		return { ok: false, reason: e?.message ?? String(e) }
	}
}
async function installUpdate({ repo, token }) {
	if (process.platform !== 'darwin') return { ok: false, reason: 'Updating is only set up for macOS' }
	repo = normaliseRepo(repo)
	try {
		const root = path.join(app.getPath('userData'), 'updates')
		fs.rmSync(root, { recursive: true, force: true }) // clear older downloads
		const dir = path.join(root, String(Date.now()))
		fs.mkdirSync(dir, { recursive: true })
		log(`Downloading update from github.com/${repo}…`)
		const r = await fetch(`https://api.github.com/repos/${repo}/zipball`, { headers: ghHeaders(token, 'application/vnd.github+json') })
		if (!r.ok) throw new Error(`Download failed (GitHub replied ${r.status})`)
		const zip = path.join(dir, 'src.zip')
		fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()))
		const x = spawnSync('ditto', ['-x', '-k', zip, dir])
		if (x.status !== 0) throw new Error('Could not unpack the download')
		const src = fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => path.join(dir, d.name))
			.find((d) => fs.existsSync(path.join(d, 'scripts', 'build-mac-app.sh')))
		if (!src) throw new Error('The download does not look like an ATEM Auto-Iris project')
		const runner = path.join(dir, 'Update ATEM Auto-Iris.command')
		fs.writeFileSync(
			runner,
			`#!/bin/bash\necho "Updating ATEM Auto-Iris… You can close this window once it says Done."\nsleep 2\ncd ${JSON.stringify(src)}\nbash scripts/build-mac-app.sh\n`,
			{ mode: 0o755 }
		)
		spawn('open', ['-a', 'Terminal', runner], { detached: true, stdio: 'ignore' }).unref()
		log('Update is building in a Terminal window. This app will now close; the new version opens when the build finishes.')
		setTimeout(() => app.quit(), 2500)
		return { ok: true }
	} catch (e) {
		return { ok: false, reason: e?.message ?? String(e) }
	}
}

// ---------------------------------------------------------------- window
function createWindow() {
	win = new BrowserWindow({
		width: 1600,
		height: 980,
		minWidth: 1200,
		minHeight: 760,
		backgroundColor: '#0f1115',
		title: 'ATEM Auto-Iris',
		icon: path.join(__dirname, 'build', 'icon.png'),
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	})
	win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
	win.on('closed', () => (win = null))
}

app.whenReady().then(async () => {
	// Allow the renderer to open capture devices.
	session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'))
	session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')
	if (process.platform === 'darwin') {
		try {
			await systemPreferences.askForMediaAccess('camera')
		} catch {
			/* ignore */
		}
	}

	ipcMain.handle('atem:connect', (_e, ip) => connect(String(ip)))
	ipcMain.handle('atem:disconnect', () => disconnect())
	ipcMain.handle('atem:setIris', (_e, { cam, value, auto }) => setIris(cam, value, !!auto))
	ipcMain.handle('atem:setGain', (_e, { cam, value, auto }) => setGain(cam, value, !!auto))
	ipcMain.handle('atem:setFrozen', (_e, on) => setFrozen(on))
	ipcMain.handle('atem:getState', () => bridge)
	ipcMain.handle('app:version', () => app.getVersion())
	ipcMain.handle('update:check', (_e, o) => checkUpdate(o ?? {}))
	ipcMain.handle('update:install', (_e, o) => installUpdate(o ?? {}))
	ipcMain.handle('settings:load', () => loadSettings())
	ipcMain.handle('settings:save', (_e, s) => saveSettings(s))

	createWindow()
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow()
	})
})

app.on('window-all-closed', async () => {
	await disconnect()
	app.quit()
})
