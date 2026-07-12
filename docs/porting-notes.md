# Porting notes — bugs found in the original

The study code (VeasyGuide) worked well enough to run an experiment on. That is a lower bar
than "runs on a stranger's Chromebook". Everything below was found while carrying it across,
and is recorded so nobody re-introduces it — or wonders why the port isn't literal.

---

## Analyzer (`backend/analyzer.py`, `backend/roi.py`)

### The node-merging loop never ran
```python
keep_merging = True
while not keep_merging:   # ← never executes
    ...
```
The contraction step that was supposed to merge near-duplicate nodes in consecutive frames
was **dead code**. This matters for parity: the committed analysis JSONs were produced
*without* any merging, so the TypeScript port must not merge either, or it will disagree with
every golden output.

### O(n²) graph construction
`_gen_roi_graph` compared every node against every other node across the entire video, then
discarded pairs outside the time window. Since edges are only ever possible within `spanTh`
(1s), this is quadratic work for a linear result. The streaming clusterer avoids it by
construction — candidates are only the nodes in the open window.

### Random-access frame seeking
The analyzer called `cap.set(CAP_PROP_POS_FRAMES)` twice per sampled pair — random seeks
instead of a sequential decode. Combined with the above, a 6.6-minute 720p video took **310
seconds** to analyze. The browser port does the same work at ~15× realtime, i.e. roughly
**8× faster than the original**, mostly by decoding sequentially.

---

## Player (`frontend/src/components/`)

### 🔴 The magnification canvas ran forever
```tsx
const renderFrame = () => {
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  requestAnimationFrame(renderFrame);   // never cancelled, never gated
};
```
`MagnificationOverlay` mirrored the video onto a canvas **on every animation frame, for the
entire session** — whether or not the magnifier was visible. That's a per-frame GPU→CPU
readback tax on all playback, on exactly the low-end hardware this app targets, to draw
something with `opacity: 0`.

**Fixed:** the render loop only runs while zoomed in, and is cancelled on cleanup.

### 🔴 Un-zooming force-played a paused video
```tsx
if (settings.pause_on_zoom) props.videoRef.current?.play();
```
With *pause on zoom* enabled, exiting zoom called `play()` **unconditionally** — so if you had
paused the video yourself and then toggled zoom off, the app started playing it against your
wishes.

**Fixed:** the overlay tracks whether *it* was the one that paused, and only resumes then.

### 🟠 `stableActivity` survived scene changes
The zoom fallback target (`stableActivity`) was never cleared on a scene change, so pressing
*Z* just after a slide transition could magnify a region belonging to the **previous slide**.

**Fixed:** cleared alongside `currActivity` when the scene changes.

### 🟠 Fullscreen on `document.body`
```tsx
document.body.requestFullscreen();
```
The project's own README documents the consequence: *"Chrome has an issue with full-screen
mode (for `body`), and the video position gets shifted uncontrollably. Maybe related to videos
that are not 16:9."* The bug was known and worked around in prose instead of in code.

**Fixed:** fullscreen is requested on the player container.

### 🟡 Smaller ones
| Bug | Fix |
|---|---|
| `leftShirt` typo (a shadowed `leftShift`) | renamed |
| `handleTimeShift` checked `allowControls` twice | deduplicated |
| Stray `7;` statement before `export default` in `HighlightIndicatorSettings` | removed |
| Timeline tooltip computed `NaN%` before the ref mounted | guarded |
| Settings popover width was `devicePixelRatio * 17.5vw` — panel size depended on the user's *display scaling* | fixed width |
| Pointer-scale label showed float noise (`30.000000004%`) | rounded |
| Two overlapping `useEffect`s both called `setZoom` on activity change | merged |
| Settings option arrays weren't `as const`, so `TPointerStyle` etc. had silently degraded to plain `string` | `as const` |

---

## Deliberate behaviour changes (not bugs)

### `sessionStorage` → `localStorage`
The study wanted every participant to start from identical defaults; sessionStorage was
correct there. For a real user, an accessibility configuration is *theirs* and must survive
a browser restart. See [D13](decisions.md#d13--settings-persist-in-localstorage).

### `timeupdate` → `requestVideoFrameCallback`
The original updated the highlight on `timeupdate`, which browsers fire only ~4 times per
second — the highlight visibly lagged the pen. Tracking now runs once per presented frame.

### Node-to-node linking
An early version of the streaming clusterer linked a new node against the cluster's
*accumulated bounding box*. That box grows as the cluster merges, making linking
progressively greedier — producing fewer, fatter activities than the Python original. This was
**our** bug, introduced in the port, and it was a real contributor to results "not feeling
one-to-one". Linking is now node-to-node, faithful to `roi.py`'s edges.

---

## What was dropped

Study scaffolding, with no replacement: prompt-to-click experiment mode, `logAction`
telemetry, the ding audio cue, module/task/step orchestration, Firestore persistence, the
admin pages, HTTP basic auth, and the YAML-driven participant permutation logic.

Also dropped: **OCR** (EasyOCR / torch — the player never used its output) and **activity type
classification** (see [D8](decisions.md#d8--activity-type-classification-is-deferred)).
