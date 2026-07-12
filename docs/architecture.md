# Architecture

How a dropped video file becomes highlights on screen.

![Pipeline](media/pipeline.svg)

## The idea in one line

For slide-based lecture video, **what changed is what matters**. The instructor's pen, cursor
and annotations are the only things moving on an otherwise static slide — so a frame
differencer finds the action without any model, and a graph groups those changes into
*activities*.

## The pipeline, stage by stage

Everything below runs inside a Web Worker (`src/analyzer/`). Every named parameter is
tunable at runtime — see [parameters.md](parameters.md).

### 1. Decode and sample (`worker.ts`)

Mediabunny demuxes the container and drives WebCodecs to decode frames. We do **not** decode
every frame — we ask for one every `sampleInterval` (default 0.2s, the study's value) via
`samplesAtTimestamps()`, which decodes each packet at most once. Each sampled frame is drawn
onto an OffscreenCanvas at `analysisWidth` (default 480px), which is where the
downscaling happens: the pixel work costs a quarter of what it would at 720p.

Sampling is **time-based**, not frame-index-based, so variable-frame-rate screen recordings
degrade gracefully.

### 2. Scene detection (`pipeline.ts: contentScore`)

Each sampled frame is compared against the previous one with an HSV content score (mean
hue + saturation + luma delta) — a port of PySceneDetect's `ContentDetector`. Above
`sceneThreshold`, we declare a **cut**.

A cut does three things: it closes the current scene, it **produces no detection nodes**
(a whole-frame change is a slide change, not instructor activity), and it **flushes all open
clusters**, so no activity can ever span two slides. See [D7](decisions.md#d7--scene-detection-ported-not-imported).

### 3. Change detection (`pipeline.ts`)

Between the two grayscale frames:

```
absdiff → threshold(diffThresh) → 3×3 smooth → dilate(dilateIters) → flood fill
```

The flood fill (4-connectivity) yields **regions**, filtered by area against
`contourAreaLowFrac` / `contourAreaHighFrac`. Each region is a **node**: a detection at a
moment in time.

Crucially, the flood fill computes more than a bounding box — it accumulates **mass**
(changed-pixel count), **centroid**, **raw moments → 7 Hu invariants**, and **mean change
intensity**, all in the same pass. That data is unrecoverable later, so we take it now.
See [research-data.md](research-data.md).

### 4. Clustering into activities (`graph.ts`)

Two nodes belong to the same activity if they are close in **time** (≤ `spanTh`, default 1s)
**and** close in **space** (≤ `distRatio` of the frame diagonal, default 5%). Linking is
**node-to-node**, faithful to the original `roi.py` graph edges.

The connected components of that graph are the activities. A pen stroke, a cursor hovering,
a circle being drawn — each is a chain of nearby-in-time-and-space detections.

### 5. Watermark finalization — why this streams

Because the edge criterion is **temporally local** (nothing links across more than `spanTh`),
a cluster whose newest node is older than `frontier − spanTh` can never gain another member.
It is final. We emit it immediately, and the player can show it while analysis continues.

This is what lets playback start after ~10 seconds of analyzed lead instead of after the
whole video. It is also what bounds memory (only the `spanTh` window is held open) and what
eliminates the O(n²) graph build of the Python original.

### 6. Segments and coverage (`ranges.ts`)

Analysis is **not** one forward pass. Coverage is a set of ranges:

- **Seek into unanalyzed video** → the worker abandons its current segment and restarts at
  the viewer's position. The viewer always wins.
- **Segment runs into already-analyzed video (or the end)** → the worker backfills the
  earliest remaining gap.
- Each segment is independent: fresh clusterer, its start treated as a scene start.

The player's timeline shades analyzed ranges (striped), so the state is legible.
See [D12](decisions.md#d12--segment-based-analysis-so-seeking-always-wins).

## The player (`src/player/`)

Ported from the study app, with fixes ([porting-notes.md](porting-notes.md)).

- **`select.ts`** decides which activity is "current" at time *t*: eligible from
  `start − highlightLead` to `end + highlightLinger`, with a **currently-active activity
  always beating a pre-activity cue**. The lead is the accessibility payoff — a low-vision
  viewer needs time to orient their gaze *before* the action, not after it.
- **`HighlightIndicator`** draws the styled box (fill, border, shape, pointer, animation,
  SVG filters — all user-tunable).
- **`MagnificationOverlay`** mirrors the video onto a canvas and CSS-transforms it to zoom
  into the current activity. It only renders while actually zoomed (a fix — see porting notes).
- Tracking runs on **`requestVideoFrameCallback`**, once per presented frame. The original
  used `timeupdate` (~4 Hz), which visibly lagged the pen.

![Magnification](media/magnification.png)

*Magnification following the instructor's annotation.*

## Coordinate spaces

Three of them, and mixing them up is the classic bug:

| Space | Where | Units |
|---|---|---|
| **Analysis** | everything in `analyzer/` | `analysisWidth`-wide pixels (default 480) |
| **Video** | `player/types.ts: PlayerActivity` | native video pixels (e.g. 1280×720) |
| **Container** | rendered overlays | CSS pixels, via `scaleRatio` + letterbox shifts |

`AnalysisMeta.scale` (= `videoWidth / analysisWidth`) converts analysis → video.
`toPlayerActivity()` is the only place that conversion happens.

## What is *not* here

No server. No database. No video storage. No ML model. No OpenCV. The only network request
the app makes is loading its own JavaScript.
