// Exposure measurement on a region of an RGBA frame.
// Values are video-level luma (Rec.709 weights on the gamma-encoded signal), 0..1 ≈ 0..100 IRE.

export const CLIP_LEVEL = 0.96 // ≈ 96 IRE counts as clipped
export const BLACK_LEVEL = 0.03

/**
 * @param {Uint8ClampedArray} data  RGBA pixels of the whole frame
 * @param {number} fw frame width, @param {number} fh frame height
 * @param {{x,y,w,h}} r normalised region
 * @param {{histogram?: boolean}} opts
 */
export function measureRegion(data, fw, fh, r, opts = {}) {
	const x0 = Math.max(0, Math.floor(r.x * fw))
	const y0 = Math.max(0, Math.floor(r.y * fh))
	const x1 = Math.min(fw, Math.ceil((r.x + r.w) * fw))
	const y1 = Math.min(fh, Math.ceil((r.y + r.h) * fh))
	const rw = x1 - x0
	const rh = y1 - y0
	if (rw < 4 || rh < 4) return { valid: false }

	const step = Math.max(1, Math.floor(Math.min(rw, rh) / 90)) // ~90 samples across the short side
	const cx = (x0 + x1) / 2
	const cy = (y0 + y1) / 2
	const hist = opts.histogram ? new Array(64).fill(0) : null

	let wSum = 0
	let lSum = 0
	let n = 0
	let clipped = 0
	let black = 0
	let sq = 0
	let plain = 0
	for (let y = y0; y < y1; y += step) {
		const dy = (y - cy) / (rh / 2)
		for (let x = x0; x < x1; x += step) {
			const i = (y * fw + x) * 4
			const l = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
			const dx = (x - cx) / (rw / 2)
			// centre-weighted: middle of frame counts 3×, edges 1×
			const w = 1 + 2 * Math.exp(-(dx * dx + dy * dy) * 2.2)
			wSum += w
			lSum += l * w
			plain += l
			sq += l * l
			n++
			if (l >= CLIP_LEVEL) clipped++
			if (l <= BLACK_LEVEL) black++
			if (hist) hist[Math.min(63, Math.floor(l * 64))]++
		}
	}
	const mean = plain / n
	const stdev = Math.sqrt(Math.max(0, sq / n - mean * mean))
	// A black/flat tile usually means "no input" rather than a very dark shot.
	const noSignal = mean < 0.015 && stdev < 0.01
	return {
		valid: !noSignal,
		noSignal,
		luma: lSum / wSum,
		clipPct: (clipped / n) * 100,
		blackPct: (black / n) * 100,
		stdev,
		hist,
	}
}

// Video luma is roughly linear light ^ 0.45, so one stop of light ≈ 2^0.45 in luma.
export const GAMMA = 0.45

/** Exposure error in stops (positive = too bright). */
export function stopsError(luma, target) {
	if (!(luma > 0) || !(target > 0)) return 0
	return Math.log2(luma / target) / GAMMA
}

/** Luma target after applying an exposure trim in stops. */
export function trimmedTarget(target, stops) {
	return Math.min(0.95, target * Math.pow(2, stops * GAMMA))
}
