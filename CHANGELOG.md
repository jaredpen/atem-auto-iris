# Changelog

## 1.3.0
- The PREVIEW camera is no longer locked: it's now adjusted first (top priority), with a tighter on-target window (±0.1 stop) and quicker, larger corrections — so it's ready before you cut to it.
- After a cut, the camera that just came off air (now on preview) is corrected straight away once it's clear of air.
- A gain change and its matching iris move are now always sent together, so a camera cut to air mid-change can't end up with the new gain but the old iris.
- Tuning: "Adjust the preview camera (priority)" — untick to lock preview cameras like before. New "Preview on-target window" setting.

## 1.2.0
- Much faster exposure correction: the app now jumps most of the way in one move, using what it has learned about each lens, and acts as soon as the picture stops changing instead of waiting a fixed time.
- Measures 10 times a second (was 5).
- New "Response speed" setting under Tuning: Smooth / Fast (default) / Snap.
- What the app learns about each lens is saved, so corrections are quick from the start of the next session. "Re-learn lenses" clears it.
- Gain can go above +18 dB when the iris can't make up the difference; it still prefers 0 / +18 dB whenever it can.
- Removed the grain effect from the demo picture.
- New "App updates" panel: check for and install new versions from GitHub without downloading the zip again.

## 1.1.0
- Gain control: Iris / Gain / Iris + Gain modes, with base-gain preference (0 / +18 dB).
- FREEZE button (Esc) — the app stops sending anything to the cameras.
- Installs as a normal Mac app.

## 1.0.0
- First version: tally-aware auto-iris, reference setup, show exposure trim, demo mode.
