// Multiview geometry. ATEM layouts are a bitmask saying which screen quadrants
// are split into 4 small windows: 1 = top-left, 2 = top-right, 4 = bottom-left, 8 = bottom-right.
// e.g. 12 ("ProgramTop") is the classic look: big Preview + Program on top, 8 small windows below.

export const LAYOUTS = [
	{ value: 12, label: 'Program/Preview on top (classic default)' },
	{ value: 3, label: 'Program/Preview on bottom' },
	{ value: 10, label: 'Program/Preview on left' },
	{ value: 5, label: 'Program/Preview on right' },
	{ value: 15, label: '4 × 4 small windows' },
	{ value: 0, label: '4 large quadrants' },
	{ value: 1, label: 'Top-left split' },
	{ value: 2, label: 'Top-right split' },
	{ value: 4, label: 'Bottom-left split' },
	{ value: 8, label: 'Bottom-right split' },
]

export const SOURCE_PROGRAM = 10010
export const SOURCE_PREVIEW = 10011

/**
 * Returns tile rectangles in normalised (0..1) frame coordinates, in reading order
 * (top-to-bottom, left-to-right), which is how window indices are assigned.
 */
export function layoutTiles(layout) {
	const quads = [
		{ bit: 1, x: 0, y: 0 },
		{ bit: 2, x: 0.5, y: 0 },
		{ bit: 4, x: 0, y: 0.5 },
		{ bit: 8, x: 0.5, y: 0.5 },
	]
	const tiles = []
	for (const q of quads) {
		if (layout & q.bit) {
			for (let r = 0; r < 2; r++)
				for (let c = 0; c < 2; c++) tiles.push({ x: q.x + c * 0.25, y: q.y + r * 0.25, w: 0.25, h: 0.25 })
		} else {
			tiles.push({ x: q.x, y: q.y, w: 0.5, h: 0.5 })
		}
	}
	tiles.sort((a, b) => a.y - b.y || a.x - b.x)
	return tiles.map((t, i) => ({ ...t, index: i }))
}

/**
 * Default source assignment when the switcher isn't telling us: large tiles are
 * Preview/Program (in that order), small tiles are inputs 1, 2, 3…
 */
export function defaultSources(layout) {
	const tiles = layoutTiles(layout)
	const out = {}
	let big = 0
	let input = 1
	for (const t of tiles) {
		if (t.w > 0.3) out[t.index] = big++ === 0 ? SOURCE_PREVIEW : big === 2 ? SOURCE_PROGRAM : 0
		else out[t.index] = input++
	}
	return out
}

/** Region of a tile to measure: inset away from tally borders, label and audio meters. */
export function measureRect(tile, inset = { side: 0.1, top: 0.08, bottom: 0.2 }) {
	return {
		x: tile.x + tile.w * inset.side,
		y: tile.y + tile.h * inset.top,
		w: tile.w * (1 - 2 * inset.side),
		h: tile.h * (1 - inset.top - inset.bottom),
	}
}
