# ATEM Auto-Iris

This Mac app keeps your Blackmagic Studio cameras matched to one reference exposure. It watches the ATEM multiview and adjusts **iris, gain, or both** through the ATEM's camera control. It follows the switcher's tally:

| Tally | What the app does |
|---|---|
| **On air** (program tally) | Never touches the camera. This includes key, PiP and SuperSource sources, and cameras mid-transition. |
| **Preview** | Locked. Shows a warning if the camera is still off target. |
| **Idle** | Adjusts in small steps, waits for the picture to settle, measures again, and stops once on target. |

---

## 1. Install as a normal Mac app (one time)

1. Install **Node.js** (the LTS version) from <https://nodejs.org>. The app needs it only to build itself.
2. Unzip this folder and **double-click `Install ATEM Auto-Iris.command`**.
   - If macOS says it can't verify the file, open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to the message. Then double-click the file again.
   - A Terminal window opens and does everything by itself. The first time takes about 2–5 minutes.
3. When it finishes, **ATEM Auto-Iris** is in your **Applications** folder and opens straight away. Drag it to the Dock to keep it handy.
4. The first time the app runs, macOS asks for two permissions. Click **Allow** for both:
   - **Camera**, so the app can read the multiview from your capture device
   - **Local Network**, so the app can talk to the ATEM

After that, open the app like any other. You can delete the unzipped folder, but keep the zip. To install a newer version later, run the `.command` file from the new zip.

*Alternative to step 2:* in Terminal, `cd` into the folder and run `npm run install-app`.

## 2. Hardware
- **Control:** the ATEM on the same network as the Mac. ATEM Software Control can stay open at the same time.
- **Video:** the ATEM **multiview output** goes into the Mac, through an UltraStudio or DeckLink (install Blackmagic Desktop Video) or through the switcher's USB-C webcam output. Use 1080p if you can.
- **Cameras:** Studio Camera 4K models on SDI with the return feed, using lenses the ATEM can control.

## 3. Using it

### Reference setup (opens at launch)
1. Pick the capture device, enter the switcher IP and click **Connect**.
2. Pick the reference camera.
3. Set its iris and gain by eye. The brightness meter, clipping meter and histogram help.
4. Click **Set as reference**. Every other camera is matched to that brightness.

### What auto may change
Use the **Iris / Gain / Iris + Gain** buttons in the header.

- **Iris**: iris only. Gain is left exactly where it is.
- **Gain**: gain only. The iris is never touched.
- **Iris + Gain**: **gain is set first, then iris fine-tunes.** The app keeps each camera on a **base gain** (0 dB or +18 dB on the Studio 4K), where the picture is cleanest:
  - **Too dark, iris almost fully open:** the app jumps to the next base gain (for example 0 → +18 dB) and closes the iris to compensate. Gain goes first, then iris, in the same step.
  - **Too bright, iris almost closed:** it drops to the lower base gain and opens the iris.
  - **Sitting on a non-base gain** (for example +16 dB, maybe after someone changed it on the panel): when the camera is idle, the app moves it to the nearest base gain and compensates with the iris, even if the exposure was already fine. It's shown as *moving to base gain*.
  - **The iris can't cover the gap even at a base gain** (very dark, or very bright): the app goes past it, including above +18 dB, up to the gain limit in Tuning. It uses the gain closest to a base gain that still exposes correctly. In-between gains show in **amber** in the camera list. Base gains show in green.
  - **After any gain change,** the app fine-tunes with the iris only for 3 seconds. This stops it from hunting back and forth between gains.

### FREEZE
The red **FREEZE** button (or the **Esc** key) stops everything at once:
- Auto switches off and any change in progress is cancelled.
- The app sends **nothing** to the cameras, including from its own manual sliders. This is enforced in the part of the app that talks to the switcher, not just the screen.
- A striped banner shows while frozen. **You have full control from the ATEM panel or ATEM Software Control.**

Click **Unfreeze** when you're ready. Auto stays off until you switch it back on.

### During the show
- **AUTO** switch (or the **A** key). It always starts **OFF** when the app opens.
- **Show exposure − / +** (or the **[** and **]** keys) raises or lowers the overall exposure, 0.2 stop per press. Idle cameras follow right away. Cameras on air or on preview follow once they're idle.
- **Per camera:**
  - **Hold**: auto never touches this camera.
  - **±**: an exposure offset in stops for this camera only.
  - **Iris slider** and **−dB / +dB** buttons for manual control.
- **Manual changes:** if you change a camera from this app or from the ATEM panel, auto leaves that camera alone for 30 s. Click **Resume** to end that early.
- **Speed:** the app measures 10 times a second and moves most of the way to the right exposure in one go. It acts as soon as the picture stops changing, rather than after a fixed wait. Choose **Response speed** under Tuning: **Smooth**, **Fast** (default) or **Snap**.
- **Lens learning:** the app works out how each lens responds to iris moves and saves it, so corrections are quick from the start of the next session. After changing lenses, click **Re-learn lenses** under Tuning.

### Demo mode
Click **Demo mode** to try everything without hardware. **Lights −3 st** and **Lights +3 st** show the gain switching.

### Updates
1. Open the **App updates** panel in the sidebar.
2. Enter the GitHub repository the app is published to, for example `yourname/atem-auto-iris`. For a private repository, also paste an access token.
3. The app checks for a newer version each time it opens and shows **Update available** in the header.
4. Click **Install update**, then click it again to confirm. The app closes, builds the new version in a Terminal window (a few minutes), and reopens. Your settings, reference and learned lens data are kept.

You can't install an update while AUTO is on, and you shouldn't do it during a show.

## 4. Tuning (sidebar → Tuning)
| Setting | Default | Meaning |
|---|---|---|
| On-target window | ±0.15 stop | Inside this range a camera counts as correct |
| Preview warning | 0.3 stop | Warn when a camera on preview is further off than this |
| Iris change per stop | 0.15 | Starting guess for how far the iris moves per stop. The app learns the real value per camera |
| Response speed | Fast | Preset for the four settings below |
| Correction per move | 0.9 | How much of the measured error to fix in one move (1 = all of it) |
| Largest single iris move | 0.4 | The biggest iris move the app makes at once |
| Min / max wait after a move | 250 / 1000 ms | Act once the picture is stable, but never sooner than the min or later than the max. Raise the min if moves overshoot |
| "Picture settled" within | 0.06 stop | How still the picture must be before measuring |
| Base gains | 0, 18 | The camera's cleanest gains |
| Gain range / step | −12 … +36 dB, 2 dB | The gains the app may use |
| Hold gain after a change | 3000 ms | Iris-only fine-tuning time after a gain change |
| Spare iris kept when picking gain | 0.05 | Iris range kept in reserve when choosing a gain, so it can still fine-tune |
| Clipping limit | 6 % | Don't make the picture brighter if more than this share of it is blown out |
| Invert iris direction | off | Turn on if auto makes cameras darker when they should get brighter |

## 5. Things to know
- **A camera on preview is locked.** If the lighting changes while it's there, the app warns you but doesn't correct it until it goes back to idle.
- **The first time you connect,** a camera may show *waiting for iris/gain value* until that setting has been changed once, here or on the panel. The switcher only reports values after they've been set.
- **Test before trusting it live.** On your first run, keep AUTO off and check three things: the tile labels match your cameras, tally shows correctly, and the iris and gain controls move the right camera.

## Developer use
`npm install`, then `npm start` to run from source, and `npm test` to run the controller tests.
