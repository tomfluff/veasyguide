# Analysis parameters

Every parameter, what it does, and **why the heuristic exists**. Defaults come from the
VeasyGuide study unless noted otherwise.

These are live-editable in the app under `?debug=1` → *Analysis parameters*, where each one
carries the same explanation as an ⓘ card. The source of truth is `PARAM_FIELDS` in
`src/App.tsx` (docs) and `DEFAULT_PARAMS` in `src/analyzer/types.ts` (values).

![Parameters panel](media/params-panel.png)

A parameter without a documented *why* doesn't get added. That's the rule.

---

## 1 · Sampling — which pixels the analyzer looks at

### `analysisWidth` = 480 px
Frames are downscaled to this width before any pixel work; detected coordinates are scaled
back up for the overlays.

**Why.** Pixel cost scales with area, and slide content is coarse enough to survive
downscaling — 480p is ~4× cheaper than 720p. The Python analyzer ran at native resolution,
so set this to the video's width to reproduce it exactly.
**Lower** = faster but thin pen strokes (1–2 px) can vanish.

### `sampleInterval` = 0.2 s
Time between the two frames that get compared. Also the analysis step.

**Why.** Adjacent frames (~33 ms) differ too little to segment; comparing across 200 ms
accumulates enough change to see a pen stroke, and cuts the work ~6×.
Study value: `sample_fps_ratio = 0.2`.
**Higher** = brief pointing gestures fall between samples. **Lower** = finer timing, more compute.

---

## 2 · Change detection — frame pair → changed regions

### `diffThresh` = 25
Minimum grayscale change (0–255) for a pixel to count as changed.

**Why.** Video compression makes pixels wiggle a few units even in perfectly static regions;
25 sits above codec noise, while ink-on-slide changes are high-contrast and clear it easily.
Python: `threshold(blur, 25)`.
**Lower** = more sensitive, but noise blobs appear. **Higher** = faint cursors and low-contrast marks are missed.

### `dilateIters` = 3
Grows the changed-pixel mask outward ~1 px per pass before regions are extracted.

**Why.** One pen stroke fragments into disconnected specks after thresholding; dilation glues
them into a single region so it's detected as one node instead of ten.
Python: `cv2.dilate(iterations=3)`.
**More** = distinct nearby events merge. **Fewer** = fragments get dropped by the area filter.

### `contourAreaLowFrac` = 0.00015
Changed regions smaller than this fraction of frame area are discarded as noise.

**Why.** Residual compression shimmer survives thresholding as tiny blobs; real activity is
bigger. 0.00015 of 720p ≈ a 12×12 px blob. Python: `contour_area_low`.
**Lower** = keeps tiny marks (the dot on an *i*) plus more noise.

### `contourAreaHighFrac` = 0.5
Changed regions larger than this fraction of frame area are discarded.

**Why.** A slide transition or scroll changes most of the frame at once — that's a scene
change, not instructor activity, and without this cap it becomes one giant bogus "activity".
Python: `contour_area_high`. (Before scene detection existed, this was the *only* thing
standing between us and that failure; now it's a backstop.)

---

## 3 · Scene detection — slide changes / cuts

### `sceneThreshold` = 27
A cut is declared when the HSV content score between two sampled frames (mean hue + saturation
+ luma change, 0–255) reaches this value. The cut's frame pair yields no nodes, and open
activities are closed at the boundary — **activities never span a cut**.

**Why the default differs from Python.** The Python analyzer used PySceneDetect's
`ContentDetector` at **threshold 14**, but scored *every adjacent frame* (~33 ms apart). We
compare frames one `sampleInterval` apart, so more change accumulates and our scores run
higher. Copying `14` would over-trigger. See [D7](decisions.md#d7--scene-detection-ported-not-imported).
**Lower** = more cuts (a big animation may split a slide). **Higher** = slide changes leak into activities.

### `sceneMinLen` = 1.0 s
Debounce: no second cut until this long after the previous one.

**Why.** A transition (fade, wipe, build animation) crosses the threshold on several
consecutive samples and would otherwise register as a burst of cuts. Not in the Python
version, which detected per-frame; at our coarser sampling an explicit debounce is the
simpler equivalent.

---

## 4 · Clustering — regions over time → activities

### `spanTh` = 1.0 s
Two nodes can belong to the same activity only if they occur within this many seconds of
each other. **Also sets finalization lag**: an activity is emitted once analysis passes this
far beyond its last node (the watermark — see [architecture](architecture.md#5-watermark-finalization--why-this-streams)).

**Why.** Writing pauses — the pen lifts between words — and 1 s bridges those pauses without
chaining unrelated events. Study value: `roi_timespan_th = 1.0` (the code's default was 1.5).
**Higher** = longer merged activities *and* more delay before they appear. **Lower** = one gesture splits into several.

### `distRatio` = 0.05
Max spatial gap between two nodes' boxes, as a fraction of the frame diagonal.

**Why.** Consecutive strokes of one annotation land near each other; unrelated activities
happen across the slide. 5% of the diagonal ≈ 73 px at 720p. Python: `roi_distance_ratio`.
Linking is **node-to-node** (not node-to-cluster-bbox — see [porting notes](porting-notes.md)).
**Higher** = neighbouring distinct activities merge. **Lower** = a fast-moving pointer splits into pieces.

---

## 5 · Filtering & display — what the player shows, and when

### `minSizeFrac` = 0.01 / `maxSizeFrac` = 0.7
Validity heuristic: a finished activity's width **and** height must each fall within
[`minSizeFrac`, `maxSizeFrac`] of the frame's, else it is flagged `isValid: false` (hidden,
not deleted — the gallery still shows it, dimmed).

**Why.** Below ~1% of the frame it's usually noise that survived clustering, and too small to
usefully highlight or zoom into. Above ~70% it's a scene-level change (scroll, transition,
camera move) — highlighting it is meaningless and magnifying it impossible.
Python: `roi_area_low` / `roi_area_high` in `RoIActivity._is_valid`.

### `minDuration` = 0 s
Display filter only (no re-analysis): activities shorter than this are hidden.

**Why.** Sub-second blips — a stray cursor flick — can distract more than help. This one comes
from the *player*, not the analyzer: the study player filtered by duration (`atLeast`, up to
1.5 s in some modes) when choosing what to highlight.

### `highlightLead` = 1.0 s
**The pre-activity cue.** The highlight appears this many seconds *before* the activity
starts — but a currently-active activity always takes precedence, so the early cue only shows
when nothing else is highlighted.

**Why this matters most.** A low-vision viewer needs time to orient their gaze *before* the
action happens. Cueing at activity start guarantees they miss the beginning of every action.
The lead is what makes the highlight an anticipatory guide rather than a lagging report.
Study player: `padding[0] = 1.0` in normal mode.

### `highlightLinger` = 0.5 s
The highlight stays this many seconds after the activity ends.

**Why.** Dropping the highlight the instant motion stops feels abrupt and yanks attention away
from what was just drawn — and the *result* of the activity is usually what the viewer wants
to read. Study player: `padding[1] = 0.5`.

---

## Which parameters need a re-analysis?

| Change | Effect |
|---|---|
| `minDuration`, `highlightLead`, `highlightLinger` | **live** — display only |
| everything else | requires **Re-analyze** (the pipeline output changes) |
