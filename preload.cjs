const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('atemApi', {
	connect: (ip) => ipcRenderer.invoke('atem:connect', ip),
	disconnect: () => ipcRenderer.invoke('atem:disconnect'),
	setIris: (cam, value, auto) => ipcRenderer.invoke('atem:setIris', { cam, value, auto }),
	setGain: (cam, value, auto) => ipcRenderer.invoke('atem:setGain', { cam, value, auto }),
	setFrozen: (on) => ipcRenderer.invoke('atem:setFrozen', on),
	getState: () => ipcRenderer.invoke('atem:getState'),
	version: () => ipcRenderer.invoke('app:version'),
	checkUpdate: (o) => ipcRenderer.invoke('update:check', o),
	installUpdate: (o) => ipcRenderer.invoke('update:install', o),
	loadSettings: () => ipcRenderer.invoke('settings:load'),
	saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
	onState: (cb) => ipcRenderer.on('atem:state', (_e, s) => cb(s)),
	onLog: (cb) => ipcRenderer.on('atem:log', (_e, l) => cb(l)),
})
