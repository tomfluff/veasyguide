# Decisions

Every significant call, why it was made, and what we rejected. Newest concerns at the
bottom of each entry. If you are about to change one of these, read the "why" first — most
were made against a real constraint, and a few were made against a real bug.

---

## D1 — The analysis runs in the browser, not on a server

**Decision.** No backend. The video is loaded as an object URL and analyzed by a Web Worker
on the user's machine. The only network request is fetching the app itself.

**Why.** The pipeline is frame differencing and graph clustering — no ML model, no GPU
requirement. Once you notice that, the server stops earning its keep: it costs money, it
becomes a privacy liability (someone's unpublished lecture recording sitting on a disk),
and it adds an upload wait longer than the analysis itself. Client-side, the strongest
possible privacy claim is also the *literally true* one: the video never leaves the device.

**Consequences.** Deployment is a static site. There is no "analyze once, share the link"
without adding a backend later (the analysis JSON can be exported/imported instead). The
compute bill lands on the user's laptop, which is why performance is measured, not assumed
(see D6).

---

## D2 — No YouTube ingestion

**Decision.** v1 accepts local video files only. Pasting a YouTube link is not supported.

**Why.** Analysis needs the actual pixels. YouTube's embedded player is a cross-origin
iframe: you cannot read its frames, so you cannot analyze it, and you cannot magnify it
either (magnification needs `drawImage(video)` on a canvas). The only way to get the pixels
is to pull the stream (yt-dlp or equivalent), which is squarely against YouTube's Terms of
Service — and browsers can't do it anyway (no CORS headers on `googlevideo.com`), so it
would require a server proxy, i.e. a ToS violation *plus* the backend we just deleted.

**Rejected alternatives.**
- *Server-side download.* ToS violation. Also resurrects D1.
- *Client-side fetch of the stream.* Blocked by CORS, and still a ToS violation.

**Future option, if wanted.** `getDisplayMedia` tab capture: the user plays the video in
YouTube's own player and shares that tab. Playback stays inside YouTube's player, so it is
not "accessing content by other means" — the user is sharing their own screen. Clunky UX
(permission prompt, analysis runs at playback speed) and not built.

---

## D3 — Pure TypeScript pipeline, no OpenCV.js

**Decision.** The image operations (grayscale, absdiff, threshold, dilate, connected
components, moments) are ~200 lines of plain TypeScript in `analyzer/pipeline.ts`.
OpenCV.js is not a dependency.

**Why.** The original Python used exactly four OpenCV features: the frame-diff chain,
`findContours`, `matchShapes`, and (optionally) OCR. OCR is cut. `matchShapes`'s only
consumer was the activity **type** classification, which is also cut from v1 (see D8) —
so the one operation that genuinely needed OpenCV had no caller. Everything left is
element-wise arithmetic and a flood fill, and at 480p analysis resolution it is fast in
plain JS. OpenCV.js would have added ~8 MB of WASM to buy nothing.

*(We later reimplemented Hu moments by hand anyway — see D9 — which is the mathematical
core of `matchShapes`, about 40 lines.)*

---

## D4 — Mediabunny for demux + decode

**Decision.** Use [Mediabunny](https://github.com/Vanilagy/mediabunny) to demux the
container and drive WebCodecs, rather than hand-rolling it.

**Why.** This is the one part of the pipeline where hand-written code dies: container
parsing (MP4/WebM/MKV variants), codec configuration, and the "give me a frame at time *t*
without decoding the whole file" problem. Mediabunny's `samplesAtTimestamps()` does exactly
what the analyzer needs — an optimized monotonic decode that visits each packet once — and
hardware-accelerated decode is what makes the whole thing 10–20× realtime instead of 1×.

**Rejected.** `@doedja/scenecut-web` for scene detection (see D7): it demuxes and decodes
the video *itself*, meaning we would pay for decode twice. Decode is the expensive part;
everything else is a rounding error.

---

## D5 — Streaming analysis with watermark finalization

**Decision.** Analysis is a forward stream, not a batch job. Activities are emitted to the
player as soon as they can no longer change, and playback begins after a short analyzed
lead (10s) rather than waiting for the whole video.

**Why it's possible.** Look at the edge criterion in the original `roi.py`: two detection
nodes can only be connected if they are within `spanTh` (1s) of each other in time. There
is no criterion anywhere that spans the whole timeline. Therefore a cluster whose newest
node is older than `frontier − spanTh` **can never gain another member** — it is final, and
can be emitted immediately. This is the standard watermark pattern from stream processing,
and it falls straight out of the algorithm's own locality.

**Why it matters.** A 6-minute lecture at ~15× realtime still takes ~25 seconds to analyze
fully. Making the user watch a progress bar for 25 seconds before playback is a worse
product than starting in 3 seconds and racing ahead. It also bounds memory: only nodes
inside the `spanTh` window need to be held.

**Bonus.** This also kills the O(n²) graph build of the Python version by construction —
edge candidates are only the nodes in the current window.

---

## D6 — Performance is measured, never assumed

**Decision.** A ×-realtime meter is a first-class part of the app, not a debug afterthought.
Debug instrumentation is off by default (even in dev) so a development run measures the
same thing a production run does.

**Why.** The target users — low-vision learners — skew toward weak hardware (school-issued
Chromebooks, older laptops, often already running a screen magnifier). "It's fast on my
M-series MacBook" is not evidence. An early cross-model review flagged the throughput
assumption as the single riskiest thing in the plan, and it was right to.

**What we found.** On a dev laptop, 720p → 480p analysis runs at ~16–20× realtime. Debug
tooling itself is free (16.6× vs 16.7×); **frame capture** — the WebP encoding for the
analyzer view — costs **+51% wall time**. Any benchmark reading taken with capture on
understates the machine by ~35%.

![Run comparison table](media/perf-runs.png)

**Still open.** The gating benchmark on genuinely low-end hardware has not been run. The
degradation path if it's slow is already parameterized (lower analysis width, longer sample
interval, or an "analyze first, then play" mode), so this is patchable, not architectural.

---

## D7 — Scene detection: how much changed, not how much the average pixel changed

**Decision.** Declare a cut when more than `sceneChangeFrac` (8%) of the frame changes between
two sampled frames — the occupancy of the diff mask we already compute.

**Superseded:** this used to be a port of PySceneDetect's `ContentDetector` (mean HSV
hue+saturation+luma delta per pixel, thresholded at 27). *It never fired on a real lecture.*

**Why the port failed, and why it took so long to notice.** `ContentDetector` is built for
film, where a cut replaces the whole frame and the mean delta spikes. A lecture deck is the
opposite case. Consecutive slides share a background, a header and a layout; only the text
differs. So a slide change moves perhaps a fifth of the pixels a very long way and leaves the
other four fifths **pixel-identical** — and averaging over all of them washes the signal out.

Measured on a 59-minute lecture: **every slide change scored under 2.5 against a threshold of
27.** The 7 cuts it did find were all in the first 17 minutes and were not slide changes at
all — they were the presenter dropping out of presentation mode to his desktop, which really
does replace the whole frame. Forty-three minutes of slides produced not one cut.

It went unnoticed because nothing downstream *depended* on scenes: the analyzer emitted them,
the debug scene strip drew them, and no user-facing feature read them. A detector that
silently returns nothing looks exactly like a video with no cuts. It only surfaced when the
moments sidebar tried to group by scene and got one group.

**Why occupancy works.** The same footage separates by an order of magnitude at each end:

| | share of frame changed |
|---|---|
| typical frame (writing, webcam) | 0.4% (median) |
| noise ceiling | 2.1% (p99) |
| **slide changes** | **20–30%** |
| cut to the desktop | 70%+ |

8% sits in the gap. It is also free: the mask is computed for change detection anyway, so this
is one pass over a byte array, no extra decode, and it let ~40 lines of HSV code (and the
matching GLSL) be deleted from the pixel pipeline.

**Calibration caveat.** The threshold was fitted to **one** lecture and sanity-checked against
a whiteboard recording (peak 0.68% changed → correctly no cuts). Unfamiliar footage may move
it. Verified by eye against the source frames: of the sampled cuts, all were real — including
a burst of four in nine seconds that turned out to be the lecturer genuinely flipping back and
forth between two slides.

**Why not a library.** Unchanged from the original decision: the only browser-side option,
`@doedja/scenecut-web`, does its own demux and decode — paying twice for the expensive step
(see D4). We already have the frames.

**The parity behavior that mattered.** In the Python version, frame pairs were generated
*per scene*, so no frame difference ever crossed a cut. We reproduce this: a cut's own frame
pair produces no detection nodes, and all open clusters are flushed at the boundary.
**Activities can never span a scene change.** On a 3-slide test video this is the difference
between one bogus activity smeared across all three slides and three correct ones — and it
was very likely part of the "results don't feel one-to-one with Python" that prompted the
investigation.

![Scene strip](media/scene-strip.png)

---

## D8 — Activity *type* classification is deferred

**Decision.** v1 does not classify activities as `pointing` / `marking` / `sketching` /
`animation` / `add_sub`. Activities are type-less; the player highlights and magnifies
them all the same way.

**Why.** The original classifier was a stack of hand-tuned thresholds on shape difference,
duration and aspect ratio (`RoIActivity._calc_type`) with a `TODO: Maybe improve type
recognition in the future` comment on it. The player never used `type` for anything the
viewer sees — only the research inspector colored by it. Cutting it removed the only
consumer of `matchShapes` (see D3) and cost nothing user-facing.

**The plan instead.** Capture the data a *learned* classifier would need, and revisit
(see D9 and [research-data.md](research-data.md)). An LLM or a clustering model over
activity features is a better answer than more thresholds.

---

## D9 — Capture ML-ready data now, because it is unrecoverable later

**Decision.** Three layers, deliberately separated:

| Layer | What | When |
|---|---|---|
| **A — Features** | ~14 aggregate numbers per activity (IoU, trajectory, growth, shape-consistency, density, intensity) | **Always on.** Cheap, tiny, useful today. |
| **B — Node logs** | Every detection node with bbox, mass, centroid, 7 Hu moments, change intensity | **Opt-in** (`?research=1`) |
| **C — Snippets** | Native-resolution image crops of each activity region | **Opt-in** (`?snippets=1` / toggle) |

**Why now.** Almost all of this exists *inside the flood fill* for a few microseconds and is
then thrown away when we keep only the bounding box. Computing it later means re-analyzing
the video — and the video may be gone (we don't store it). Whatever we don't capture at
analysis time is lost. Features and moments cost almost nothing to compute alongside the
work already being done.

**The privacy line.** Layers A and B are *derived measurements* — numbers about pixels.
Layer C is *pixels*: snippets are literal fragments of the video. That's a different
category, so:
- Snippets are **generated lazily on the client, for display only**, from the video file the
  user already has open.
- They are **never included in any export**, even in research mode. Exporting image data
  would need its own explicit consent, and is deliberately not built.
- The claim "we don't store your video" stays literally true.

![Activity gallery](media/activity-gallery.png)

*Research mode. Note that the two natural classes are already visible to the naked eye —
blue ink (writing/sketching) vs. translucent cursor arrows (pointing) — and their feature
vectors differ accordingly (`iou`, `gr`, `sh`). That's the signal a future classifier will
learn from.*

---

## D10 — Snippets are sequences, generated post-hoc in one decode pass

**Decision.** Each activity gets a **sequence** of native-resolution crops
(`before → start → every 0.5s → end`, capped at 12, fixed crop window), generated *after*
analysis by a dedicated worker doing **one monotonic decode pass** over all requested
timestamps.

**Why a sequence, not one frame.** A single crop shows what an activity ended up being; a
sequence shows *what kind of thing it was*. Writing accumulates ink; pointing stays static;
an animation changes without ink. That temporal signature is the discriminative signal — the
thing a learned classifier is supposed to pick up on ([D8](#d8--activity-type-classification-is-deferred)).
A "before" frame is included as the baseline: what the region looked like with nothing there.

**Why the crop window is fixed** (the activity's box, not each node's): same window every
frame means the frames are spatially registered, so the stroke visibly grows inside a stable
frame. Per-node crops would jitter and be useless to both a human and a model.

**Why post-hoc, not during analysis.** Capturing crops inside the analysis loop would slow
the thing we most want to protect, would only capture downscaled 480p frames, and would run
even when nobody looks at them. Post-hoc costs analysis **nothing**, gives **native
resolution**, and only runs when snippets are on.

**Why a worker and not `<video>` seeks.** The obvious post-hoc implementation seeks a hidden
`<video>` once per crop. That's ~275 random seeks for a 5-minute lecture, each flushing the
decoder — minutes of work, and far worse on a long lecture. Instead we collect every
timestamp across all activities, sort them, and run **one** `samplesAtTimestamps()` pass
(the same optimized path the analyzer uses; each packet decoded at most once), cropping every
activity that needs a given frame from that single decode.

Measured: **275 crops in ~5 s, 0.4 MB** on the 5:32 RL lecture.

---

## D11 — The player was ported with fixes, not copied

**Decision.** The study player (VideoPlayer, HighlightIndicator, MagnificationOverlay, both
settings suites) was carried across, but reviewed on the way in.

**Why.** It was study code: it worked well enough to run an experiment. That is a lower bar
than "runs on a stranger's Chromebook". The review found real bugs — most notably a
per-frame video→canvas readback that ran **forever, even when the magnifier was invisible**,
taxing every second of playback on precisely the hardware we're worried about.

Full list in [porting-notes.md](porting-notes.md).

---

## D12 — Segment-based analysis, so seeking always wins

**Decision.** Analysis coverage is a **set of ranges**, not a single frontier. Seeking into
unanalyzed video makes the worker abandon its current segment and restart at the viewer's
position; when a segment runs into already-analyzed video, the worker backfills the earliest
remaining gap.

**Why.** With a single forward pass, seeking ahead put the viewer somewhere the analyzer
wouldn't reach for minutes, with no highlights and no way to hurry it. The viewer's position
is the only thing that matters in the moment, so it preempts everything.

**Accepted cost.** Each segment is independent (fresh clusterer, its start treated as a
scene start), so an activity straddling a segment boundary can appear as two. This is
cosmetic and only at a boundary the user themselves created by seeking. Stitching is
possible (the edge rule is local) but not built.

**A bug this design produced, and its fix.** A segment stopping at an already-analyzed
boundary left behind a sliver shorter than one sample interval; the gap-filler then re-picked
that sliver forever without ever producing a sample — the worker hung at "analyzing" and
never finished. Segments now claim coverage right up to the boundary, plus a no-progress
guard. Worth knowing about if you touch `ranges.ts`.

---

## D16 — Webcam suppression is a pre-pass, not streaming accumulation

**Decision.** The talking-head inset is located *before* analysis starts, by diffing ~24
frames sampled minutes apart (`pipeline.ts: webcamZone`), and detections inside the zone are
dropped at detection time. A streaming approach — accumulating a global churn map during
analysis and vetoing retroactively — was designed first and rejected.

**Why the existing veto wasn't enough.** The per-pixel occupancy veto (D-adjacent to
`persistFrac`) judges pixels individually. The inset's *rim* — silhouette edges that move
only when the head does — churns too rarely per-pixel to trip it. Measured on a 59-minute
lecture with a corner webcam: **171 of 602 valid moments were the webcam** (the veto caught
79); the leaked ones showed `flaggedFrac` 0–0.37 against the 0.5 threshold, exactly the rim
signature. The veto is also per-segment, so every seek/backfill re-learns the webcam blind.

**Why pre-pass beats streaming accumulation.** Timing. A zone known before the first
activity exists means the veto happens *before clustering* — no webcam activity is ever
created, nothing is ever retracted, and the sidebar never shows a row that later vanishes.
The streaming design needed confidence gating ("the zone may tighten but not jump") and
retroactive invalidation, both of which are state machines with edge cases. The pre-pass is
24 sparse decodes: **1.5 s on a 59-minute video**, before playback unlocks.

**Why sparse sampling works at all.** A person in an inset has always moved between two
frames minutes apart → webcam pixels churn in ~every consecutive pair. Slide pixels change
only in pairs straddling a slide turn; ink only in pairs straddling its writing. The churn
heatmap (visible under `?debug=1`) shows the head silhouette at ~100% of pairs against
everything else far below. This is broadcast TV's logo/PiP detection trick inverted: find
what never stays, instead of what never changes.

**Why churn alone could not find the inset's EXTENT — and edges could.** The first,
churn-only zone was tight around the silhouette, and 110 user-facing moments still leaked
from the inset's quiet side — webcam background the person only occasionally leans into.
Reading churn levels off the heatmap: that quiet side sits at **0.13** of pairs while the
slide sits at **0.44**. The churn ordering is inverted — any threshold loose enough to take
the halo takes the slide first, so no flood can work. What separates them is not how often
they change but whether they are inside the inset's rectangle, and the rectangle's border
is a *persistent edge* (present in ~every sampled frame). So the pre-pass accumulates an
edge map alongside the churn map and grows the zone to the enclosing persistent-edge
rectangle — the original un-inverted TV-logo trick. Both signals were proposed at the
design stage; the measurement is what proved BOTH are needed: churn for the core (edges
alone can't tell the inset's border from the slide's border) and edges for the extent
(churn can't reach where the person rarely moves).

**Deliberate refusals.**
- A churn blob above ~20% of the frame is **not** a zone: a camera video of an instructor at
  a board looks exactly like a giant webcam, and vetoing where they write would be the worst
  possible behaviour. Verified: the whiteboard test video yields no zone.
- **No face detection.** It would work, but needs a model, and "no model, no training,
  nothing to download" is a load-bearing product claim (About dialog). Revisit only if the
  model-free signal fails on real footage.
- **No skin-colour heuristics.** Fragile across skin tones and lighting — an accessibility
  tool whose suppression works better for some instructors' skin than others is not shipping.

**Known limitation.** An inset present for only part of the video dilutes the pair-churn
signature below threshold (a 50%-of-video webcam changes in ~50% of pairs). The per-pixel
occupancy veto remains as the second line of defense for that case.

---

## D15 — Enhance filters run as WebGL shaders, not CSS/SVG filters

**Decision.** `EnhanceCanvas` and `MagnificationOverlay` render through a small WebGL
renderer (`glEnhance.ts`) that implements the enhance effects as fragment shaders. The
SVG filter defs remain, but only as the **fallback** when WebGL is unavailable.

**Why.** `sharpen` was visibly loading the CPU. Simple CSS filter *functions* (`contrast`,
`blur`) are GPU-accelerated, but a **reference filter** — `filter: url(#…)` — drops the
browser into its **software SVG-filter path**. `feConvolveMatrix` is a per-pixel 3×3
convolution executed on the CPU, and because the canvas beneath updates every frame, it was
re-run on every frame, forever. Same for the `feMorphology` in the "bolder ink" filters.

A fragment shader does the identical maths on the GPU in microseconds. Everything moved:
- `bold-dark` / `bold-light` → 3×3 min/max (erode/dilate) with the same contrast stretch and
  saturate, folded into one pass (the stretch is monotonic, so it commutes with min/max)
- `sharpen` → the same `[0 −1 0; −1 5 −1; 0 −1 0]` unsharp kernel
- `invert`, and the magnifier's `contrast` → point ops in the final pass

**The second win, independent of the GPU:** redraws are now driven by
`requestVideoFrameCallback` — once per **new video frame** — instead of
`requestAnimationFrame`. A 30 fps lecture on a 144 Hz display was being re-filtered 144×/s to
show 30 distinct images. It also stops entirely while the video is paused, where the old loop
kept running forever.

**Fallback.** No WebGL → the 2D canvas + `filter: url(#…)` path from D14, unchanged. The SVG
defs are still the reference implementation, and the shaders are written to match them.

**Not verified here:** the CPU saving was measured by the user on real hardware, not by us —
the headless Chromium used for automated checks runs software GL (it even logs *"GPU stall due
to ReadPixels"*), so any performance number taken there would be meaningless. What *is*
verified in the browser: WebGL is selected, no CSS filter is applied, and the shader output is
correct (an `invert` magnifier renders fully inverted).

---

## D14 — Enhance filters copy the video into a canvas instead of filtering the backdrop

**Decision.** The highlight's "enhance" filters no longer use `backdrop-filter: url(#…)`.
Both the highlight and the magnifier now draw the relevant video region into a canvas and
apply a **regular** `filter: url(#…)` to that canvas (`EnhanceCanvas.tsx`).

**Why.** `backdrop-filter: url(#svg-filter)` is **unsupported in Firefox *and* Safari**
([mdn/browser-compat-data#24110](https://github.com/mdn/browser-compat-data/issues/24110)),
and Firefox does not degrade gracefully — the element fails to render at all, appearing at
`opacity: 0` ([bugzilla 1787623](https://bugzilla.mozilla.org/show_bug.cgi?id=1787623)). So
the study player's highlight filters were broken for roughly a third of users, *destructively*.
The original README noted "Firefox has issues with feMorphology over backdrop-filter" and
worked around it in prose rather than in code.

The asymmetry that makes the fix easy: a **regular** `filter: url(#…)` works in every current
browser. `MagnificationOverlay` already relied on that (it filters a canvas), so the highlight
just adopts the same technique. One approach, both features, no browser caveats.

**Cost.** A per-frame `drawImage` of the highlighted region — but only while filters are
enabled *and* an activity is highlighted. Off by default, zero cost.

**Consequence.** The highlight's box no longer animates its geometry while an enhance filter
is on: the canvas holds a fixed crop of the video, so tweening the box it lives in would smear
it against the frame underneath. Opacity still fades.

**Also cleaned up here:**
- Filter names were `thicker` / `thicker-[dark]` — describing what they do to *pixels* rather
  than *when to use them*, and the `[...]` was fragile inside `url(#…)`. Now `bold-dark`
  ("Bolder ink" — thickens dark writing on a light slide), `bold-light` (same for dark slides),
  `sharpen`, `invert`, each with a hint in the UI.
- The magnifier's **"Sharpen" slider never sharpened anything** — it drove CSS `contrast()`,
  and its label printed `sharpness − 1`, so "1x" actually meant contrast 2. Renamed to
  **Contrast** with an honest label. Real edge enhancement is now a separate `sharpen` filter
  (an `feConvolveMatrix` unsharp kernel).
- Unknown filter ids persisted from older builds are dropped on load (`sanitizeFilters`).

---

## D13 — Settings persist in localStorage

**Decision.** Highlight and magnification settings moved from `sessionStorage` (the study's
choice) to `localStorage`.

**Why.** In a study, every participant should start from identical defaults — sessionStorage
is correct there. For a real user, an accessibility configuration is *theirs*: a low-vision
learner who has tuned border width, fill opacity and zoom strength to their vision should
not have to redo it every visit. Different product, different default.

---

## D16 — Scenes are a global cut partition, not per-segment spans

**Decision.** The worker keeps one global list of content cuts and posts the full scene
partition (`{type:"scenes"}`, replace-not-append) whenever it changes. Activity ids are
assigned by the run, not by the per-segment clusterer, and App inserts streamed activities
in start order.

**Why.** Analysis is segmented — a seek abandons the current segment and restarts at the
playhead (D5). The old code posted each segment's span as a "scene" and let each segment's
clusterer restart ids at 0. On a straight run the two models coincide, so nothing looked
wrong. Under seek-spam they diverge violently: a cut-less 5.5-minute video produced 19
overlapping "scenes", false "Possible scene change" notices during playback, and 46
colliding activity ids — which React, keying sidebar rows by id, amplified into 84 rendered
rows for 39 real moments (28k duplicate-key errors) with permanently missing thumbnails.
A segment boundary is a coverage artifact; only a content cut is a scene boundary.

**How.** `addCut(t)` dedupes within `sceneMinLen` (two segments can rediscover the same cut
with fresh local debounce state), sorts, and re-posts the partition `[0, …cuts, duration]`.
The partition is also posted at `done`, so a cut-less video still ends with its single
whole-lecture scene. The player tracks the current scene by `start` rather than `id` —
partition ids shift by one when a backfilled segment finds an earlier cut, and an id
changing under a stationary playhead is not a scene change.

**Rejected.** Reconciling per-segment scene spans on the App side (merge overlaps, dedupe):
treats the symptom; the worker still emits records that are not scenes. Keeping per-clusterer
ids with a segment offset: still collides after any out-of-order flush.

**Limitation.** A cut lying exactly on a segment boundary is invisible (neither segment
diffs across it) — pre-existing, unchanged by this.

---

## D17 — The five persona features (July 2026 deliberation)

**Decision.** Five personas (low-vision learner — final word on conflicts, instructor,
sighted learner, blind learner, content creator) each used the app and proposed four
features; twenty proposals were debated on user value, feasibility, and architectural fit
and converged into five. Everything excluded is preserved with rationale in
proposals-parked.md — parked, not discarded.

The five, and the convergences that chose them:

1. **Pinned snapshot** (low-vision #1 + sighted #4): pin a magnified crop of a moment's
   finished ink over the playing video; sidebar thumbnails enlarge on demand. The core
   user's top need — "give me time to READ it" — and the crammer's "let me read the final
   board state" are the same artifact.
2. **Study pace** (low-vision #2 + sighted #1 + sighted #2 + blind #3): a playback-speed
   control, plus a moment-aware tempo mode with two directions on one engine — wait (pause
   at each moment's end; the blind learner's audio-scoped playback and the low-vision
   "don't outrun me") and skim (jump the gaps; measured 67% of a real lecture is
   moment-free dead air).
3. **Moments file** (instructor #1 + creator #2 + sighted #3 + blind #4 + creator #1):
   serialize the analysis once, spend it three ways — an IndexedDB cache keyed by file
   fingerprint (auto-restore on reopen), an exportable/importable .veasyguide.json sidecar
   (analyze once, share with 300 students; the architecture-honest answer to "embed it"),
   and a Markdown export (the blind learner's notes skeleton, the creator's pacing data).
4. **Spatial descriptions** (blind #2 + instructor #3): word the geometry the analyzer
   already computes — "Writing · top right · large" from box + features — in sidebar
   labels, announcements, and exports. The blind persona's key finding: the data to
   describe moments in words exists today; it is only ever spent on paint.
5. **Visible magnifier** (creator #4 + low-vision #4): an on-screen zoom toggle with
   pressed state and a persistent "ON · 1.7×" chip, touch-reachable, plus a full-frame
   fallback when the zoom target is empty (the fullscreen black-screen trap). The app's
   core interaction was a keyboard-only toggle whose state was invisible to its core user.

**Why these five.** Every persona lands at least one direct win; the low-vision learner
(the product's reason to exist) lands her top two; the blind learner's honest verdict —
"every unit of added value is paint" — is answered with data, not paint (descriptions,
wait-mode playback, Markdown export); and nothing violates the client-side, no-upload,
no-account, offline-first promises. The instructor's biggest ask (parked-pen detection) is
deliberately NOT here: it is analyzer research with false-positive risk against the app's
"never highlight the wrong thing" promise, and it is parked with a cost estimate rather
than rushed.

---

## D18 — The moments file: one serialization, three consumers

**Decision.** A finished analysis serializes to a single JSON shape (`momentsFile.ts`,
`format: "veasyguide-moments"`, versioned): video identity (size + duration + frame size —
rename-proof; the name is carried for humans, never matched on), analyzer params, meta,
webcam zone, scenes, activities. It is consumed three ways: an IndexedDB cache keyed by
that identity (reopening a video restores instantly; newest 20 kept), an exportable /
importable sidecar (drop video + `.veasyguide.json` together on the landing to skip
analysis), and a Markdown export (scene-grouped, worded, timestamped moments with gaps
≥ 15 s called out).

**Why.** Four of five deliberation personas independently asked for some face of this:
no-cache re-analysis burned every reopen (~25 min for a 90-minute lecture, times 300
students for an instructor), and the analysis data had no accessible artifact. The sidecar
is the architecture-honest redesign of the parked "paste a link / embed" proposal: what the
creator hosts is a few kilobytes of coordinates; the video never moves (D1/D2 intact).

**Trust boundary.** A sidecar is an untrusted file from a forum. Parsing returns human
error STRINGS, not exceptions; a wrong or corrupt file degrades to a normal fresh analysis
with the reason shown in a dismissible strip — a bad import must never mean a broken player.
Matching is by file size at import (cheap, pre-demux); an explicit Re-analyze bypasses the
cache and overwrites it, so debug parameter runs stay fresh.

**Rejected.** localStorage (5–10 MB quota vs multi-MB activity lists); hashing file bytes
for identity (reading a 2 GB file to fingerprint it costs the time the cache exists to
save); CSV export (the JSON is the machine-readable form; Markdown is the human one).

---

## D19 — Moments are described by geometry, not by a guessed verb

**Decision.** The spatial description (`describe.ts`) says WHERE and HOW BIG only — "top
right, medium size". The verb tier shipped in D17 (Writing / Pointing / Motion, inferred
from `growth` and `meanConsecIoU`) is removed, along with `momentLabel`, which was left a
pure alias of `momentPlace`. Duration is unchanged: every call site already prints it from
`start`/`end`, so composing it into the description string would only double-speak it.

**Why.** The verb was wrong too often to earn its place. A confident wrong word costs more
than no word at all: the user who most needs the description is the one who cannot glance
at the frame to catch the error, so a mislabelled "Writing" is not noise, it is a false
statement they have to act on. Box geometry is measured; the verb was inferred from two
features that turned out not to separate the classes cleanly outside the calibration clips.
Size stays for the same reason location does — it is measured, not guessed.

**What this does not close.** Naming the act is still worth doing; it needs the analyzer
research parked in proposals-parked.md (activity clustering — what the `features` block was
always collected for), not a pair of hand-tuned thresholds. The removal note in
`describe.ts` records the thresholds tried, so the next attempt starts from the failure
rather than reinventing it.

---

## D20 — The pinned snapshot's corner and size belong to the reader

**Decision.** The pin panel gets two cycle buttons in its caption — size (small /
medium / large) and corner (top right → bottom right → bottom left → top left) — both
persisted in `ViewSettingsStore`. Corners reuse the vocabulary `momentPlace` speaks, so
the panel's position and the moments' descriptions agree on words. Persisted, because a
reader who needs it large needs it large on every video; re-enlarging it each time is the
tax this app exists to remove.

**Why cycles, not a picker.** A menu would open over the very video the panel is already
covering. One button each, and each label names where the next press lands ("Snapshot
size: medium. Change to large."), so the choice is knowable without sight and without
having to try it first. No new hotkeys: the buttons are in the tab order, and the
keyboard map is already dense.

**Rejected: `resize: both`.** Free, native, one line — and pointer-only. Unusable by
keyboard, which is precisely the audience. Laziness that excludes the user is not
laziness, it is a bug.

**Two layout facts the browser had to teach us.** (1) `max-width` did nothing: the panel
is absolutely positioned, so it shrink-to-fits its image, and any crop narrower than the
cap made all three sizes render identically — the control was inert for every ordinary
moment. The size classes set `width`. (2) The control bar is z-50 and the panel is z-35,
so a tall panel grew UNDER the bar and the bar swallowed the panel's own caption
controls. The panel's height is now capped at the space the measured bar leaves
(`calc(100% - barHeight - 24px)`), the same trick the fullscreen moments overlay uses,
with the image shrinking (`min-height: 0`) rather than pushing the caption out of reach.
Verified across all 12 size×corner combinations: each clears the bar, stays in the
viewport, and keeps every button hittable.

*Later (D32):* windowed, the bar now sits below the video, so the bar-height cap applies only
in fullscreen. D31 also gave the two cycles keys (C and S) after all, at the user's request.

---

## D21 — A pin holds the moment you pinned; it does not follow the lecture

**Decision.** While the pin panel is open, a newly finished moment no longer replaces its
contents. The panel shows what you pinned until you dismiss it or pin again (dismiss +
pin, or P twice, gives you the latest). Captures keep accruing in the background exactly
as before, so pinning between moments still shows the ink that just finished.

**Why.** The panel's whole reason to exist, from the low-vision persona's #1 need in D17,
is "give me time to READ it" — the reader takes their time while the lecture takes its
own. Following the newest capture handed the instructor's pace straight back: pin
something, and the lecture rolling on would swap it out from under you mid-read, caption
and all. The feature was quietly cancelling itself. Auto-follow was never a decision, it
was a default nobody questioned; D17's own wording called for the opposite.

**Cost, accepted.** There is no longer a "live latest writing" panel. Nobody asked for
one; the sidebar and the now-line already say what is happening now, and both track
playback. The pin is the one surface whose job is to NOT track playback.

**Why it was a five-line deletion.** The object-URL ownership guards this needed were
already in place from the original implementation: each new capture revokes the previous
one unless the pin owns it, and dismissing revokes the pin's url only when it is no longer
the latest. Once a pin outlives the newest capture, exactly one of the two owns each url.
Verified live: a pin held across 12 s and several moment-ends with its image intact
(naturalWidth 250, not broken), and dismiss + re-pin correctly jumped to the newest.

---

## D22 — The notes export lists every moment, including the ones the player won't show

**Decision.** `momentsMarkdown` lists all activities, each marked shown or not, with the
reason: `size outside the range the analyzer accepts` (the analyzer's own `isValid`
verdict) or `shorter than the ${minDuration}s minimum` (the display floor). The header
counts both ("3 moments · 2 found but not shown"). Gaps are measured between SHOWN moments
and renamed "no moments" from "no visual activity".

**Why.** Two things were wrong, and they pulled in opposite directions. The export filtered
on `isValid` alone while the player shows `isValid && duration >= minDuration`
(select.ts `validActivities`) — so the notes listed moments the sidebar does not, and a
note-taker comparing the two would find entries that don't exist in the app. And it dropped
rejected activities silently, so a creator asking "did it miss my pen stroke?" got a
shorter list rather than an answer. A file that says "not shown: size outside the range"
answers the question; a file that omits the line pretends there was nothing there.

**Ordering.** Entries carry their timestamp and are sorted, rather than pushed as
encountered. A gap is only discovered when the next shown moment arrives, so emitting it
at that point printed it after the not-shown entries lying inside it — a document claiming
"no moments 00:14–01:10" underneath the two it had just listed at 00:40 and 00:50. This
was invisible while rejected moments were unlisted; listing them exposed it.

**Why "no moments", not "no visual activity".** A rejected blip is still something the
analyzer saw. Letting one close a gap would claim the screen was busy when the viewer had
nothing to follow; calling the stretch activity-free contradicts a not-shown entry printed
inside it. Gaps describe what the viewer gets; the not-shown entries say what was there
anyway.

**Trust boundary.** `params` is read as `f.params?.minDuration ?? 0` — `parseMomentsFile`
does not require the field, so a hand-edited sidecar must not crash the export it is being
read for (D18).

---

## D23 — A moments file can arrive at any time, and it asks before it lands

**Decision.** Drop a `.veasyguide.json` on its own, onto a video that is already open — even
one mid-analysis — and it takes over after a confirm. The video element, the file and the
viewer's playhead are untouched; only the analysis is replaced (`applySidecar`, which is
`hydrateFrom` plus the same reset the drop-both path does, minus everything about the
video). The whole player screen becomes a drop target while a file is over it.

**Why.** Before this, `loadFiles` was wired only to `<Landing>`, which unmounts the moment a
video loads — so there was no drop target at all on the player screen, and a dropped file
made the browser navigate away, losing the analysis outright (the same bug the Landing zone
was written to fix, on the screen with more to lose). A sidecar alone was answered with
"drop it together with its video", which asked a viewer who had just realised a classmate
sent them the file to throw away what they were watching in order to save time. Nobody
takes that trade. The common case IS mid-analysis: that is when the file is worth most.

**Why confirm.** Applying discards an analysis the viewer may have waited twenty minutes
for. Cancel is autofocused and is what Esc and the backdrop both do — the risk is
destroying that work with a stray Enter, not the cost of one more click. The wording names
the actual cost, which differs by state: mid-analysis you stop waiting; finished, you
replace a complete run.

**The veil is the drop target, not the shell.** `dragleave` on a container fires every time
the pointer crosses a child boundary, so the flag would flicker. A veil covering everything
is the one element whose `dragleave` means "actually left"; its card is
`pointer-events: none` for the same reason.

**A native `<dialog>`**, like About: `showModal()` brings focus trapping, Esc and a backdrop.
A confirm that can be tabbed behind is worse than no confirm.

**Caught in review.** The dialog first counted `activities.filter(isValid)` and said "26
moments" where the sidebar showed 20 — the same drift D22 had just fixed in the notes
export, reintroduced within the hour. It now calls `validActivities`, which is the one place
that owns the rule. A confirm that misstates what you are about to get is worse than none.
The mismatch notice says "Nothing changed" rather than naming a state ("still analyzing")
that is wrong half the time it fires.

---

## D24 — Speed becomes an icon menu; Pace is removed

**Decision.** The control bar's two `<select>`s are gone. Speed is an icon that opens its
rates in a menu, showing the rate beside the icon only when it is not 1×. Pace — the
moment-aware tempo engine (continue / pause-after-each-moment / skip-to-next) — is removed
entirely: the select, the engine in the per-time update, `tempoActedRef`, and
`atMomentEnd` / `MomentEndBehavior` / `setAtMomentEnd` from `ViewSettingsStore`.

**Why.** The bar had run out of room. Two labelled selects, each sized to its widest option
("Pause after each moment"), spent roughly a third of the bar's width on every frame to
advertise two settings. Speed now costs 44px idle.

**The cost, stated plainly.** D17 records the tempo engine as the convergence of four of
five personas — the low-vision "don't outrun me", the blind learner's audio-scoped
playback, and the crammer's skim over a measured 67% of moment-free dead air. Removing it
removes all of that. This was the owner's call with that history in view; it is recorded
here so the next person reads a decision, not an oversight. `[` / `]` (previous / next
moment) still serve the skim case by hand.

**What was lost with the `<select>`.** The old code chose native selects deliberately:
"keyboard and screen-reader behavior come built in, and the bar is the one place a popup
must never fight the video." Mantine's Menu carries the roles, arrow keys, Escape and focus
return, but the native mobile picker and the select's "1×, 3 of 7" announcement are gone
for real. The trigger's `aria-label` carries the current rate instead, and `Shift+<` /
`Shift+>` are untouched.

**`withinPortal={false}` is load-bearing.** Portalled to `<body>`, the dropdown is invisible
in fullscreen — the same reason the Appearance popover sets it. Verified open inside the
fullscreen element.

**The rate is visible when off-default.** Icon-only at every rate would hide a setting that
silently changes how the whole lecture plays — the exact bug the visible-magnifier work
already fixed once ("keyboard-only, state invisible"). At 1× it is a bare icon; off-default
it goes amber with the rate, the same state language as the magnifier toggle and the NOW
mark.

*Later (D34):* the rate is now always shown, "1×" included, in a fixed-width button, so a rate
change cannot wrap the bar. Off-default still goes amber.

---

## D25 — The typecheck was checking nothing, and it was hiding a dead feature

**What was wrong.** The root `tsconfig.json` is solution-style (`"files": []` plus
references), so `tsc --noEmit` against it checks **zero files**; only `tsc -b` follows
project references. `npm run build` (`tsc -b && vite build`) had been exiting 2 on 11
pre-existing errors, so the build script was red and the errors sat unread.

**The real bug it was hiding.** `ActivityGallery` posted `{type:"start", file, reqs}` to the
snippet worker, which only handles `open` and `batch`. The message matched no branch and was
dropped in silence: the research gallery has been generating **zero** snippets. It also
listened for `progress` and `done`, neither of which exists — the worker sends `batchDone` —
so its readout sat at "generating snippets… 0/599 frames" forever and its stats line could
never render. Measured before/after on a 170 s clip: 0 → 749 crops, and the frozen counter
became "599 crops · 1.8 MB in memory · 3.6s".

**Why TypeScript could not save us.** `Worker.postMessage` takes `any`. The outbound half of
the protocol was typed (`MessageEvent<SnippetOutMsg>`) and duly produced 7 errors narrowing
to `never` — the inbound half was not, so the `start`/`open` drift was invisible. The
gallery now sends through `const send = (m: SnippetInMsg) => worker.postMessage(m)`, which
is the whole fix: a typed door the compiler can watch.

**Ordering moved into the worker.** `open` must precede `batch`, and that was the caller's
job by convention — a contract no caller can keep, because there is no ack to wait for. An
`async` onmessage does not serialize: `batch`'s handler starts the moment `open`'s first
await yields. App.tsx got away with it only because its two posts sit in different effects
with real time between them. The worker now chains messages through a promise, so the order
holds for every caller.

**The other three.** `momentsFile.ts` imported `Range` unused. `App.tsx` (×2) hit the same
narrowing wall documented in D23: `parseMomentsFile`'s union discriminates on `error:
string`, and a non-literal type cannot narrow it, so `parsed.file` stays possibly-undefined
however you check — destructuring narrows. `ViewSettingsStore` inferred `groupByScene: true`
as the literal `true`, so the persist initializer never type-checked against
`TViewSettings`; it is annotated now.

**Result.** `tsc -b` reports 0 errors and `npm run build` exits 0, for the first time on
this branch. Use `tsc -b`, never `tsc --noEmit`, in this repo.

---

## D26 — The highlight's border is measured on the screen, not in the video

**What was wrong.** `border_width` — the number the Appearance sheet displays as "10px" —
was multiplied by `scaleRatio`, the video-pixels-to-CSS-pixels conversion, and the whole
border-bearing element was then scaled again by the Size setting's `transform`. Measured in
a headless browser at `deviceScaleFactor: 1`, a configured 10px border was painted:

| Lecture, in a 960px-wide player | `scaleRatio` | Painted border |
|---|---:|---:|
| 1920×1080 | 0.5 | 5.25px |
| 1280×720 | 0.75 | 7.35px |
| 640×360 | 1.5 | 15.75px |
| 640×480 in a 320px player | 0.375 | 3.15px |

Same setting, same monitor, same window; five times the thickness, decided by which file
the viewer happened to open. The optional pulse swung it a further 25% three times per
moment. The pointer had the same defect, and the fixed circle's diameter came out quadratic
in the Size setting (`base_scale` was multiplied in *and* carried by the transform), so 50%
drew 13.75px, 100% drew 52.5px and 200% drew 205px.

**Decision.** Two coordinate spaces, named and kept apart in `player/indicatorMetrics.ts`.
The **box** is video-space: where the highlight sits and how much ink it covers must track
the lecture, or it stops sitting on the instructor's pen. The **decoration** — border,
pointer, fixed-circle diameter — is screen-space: it is not a property of the lecture, it is
what this viewer told us their eyes need. Ten means ten.

**Why no `transform: scale()` may sit between the border and the viewport.** Dropping
`* scaleRatio` is only half of it: a CSS transform scales everything the element paints,
borders included. Counter-scaling the declared width — asking for `10 / 1.05` so it lands at
10 — was tried and **measured to fail**: Blink floors a used `border-width` to a whole CSS
pixel, so `9.52px` is painted as `9px` and lands at 9.45. Only the structural rule holds. The
box is therefore centred with `translate: -50% -50%` (a translation, which moves the box
without touching what it paints) and sized with width/height, and `@keyframes pulse` grows
those lengths instead of a transform.

**And the ring is an inset `box-shadow`, not a `border`.** A border is part of the box, and
this is not. Under the global `box-sizing: border-box` a border eats the interior, and when
the box is narrower than two borders CSS refuses to go negative and grows the BOX instead —
measured: with a 12px setting, a 20.1px annotation and a 5.0px one both rendered as a 24px
square, losing the distinction between them and drifting off the ink while the enhance canvas
stayed where it was. An inset shadow is painted, not laid out: the box stays exactly the size
the activity says, a ring too thick for it simply fills it, and it follows `border-radius` so
the fixed circle still gets a round ring. Re-measured after the change: 20.14px and 5.03px,
with a 12px ring on both.

The one thing a `border` did that a shadow does not: survive forced-colors mode. Windows
High Contrast sets `box-shadow: none`, so the highlight would have lost its outline entirely
for the viewers most likely to be running it — measured, and then measured again with
`forced-color-adjust: none` on `.highlight-indicator`, which keeps the ring at 10px in both
modes. Opting out is the same contract the pulse has with `prefers-reduced-motion`: the
OS-wide preference sets the default, and this viewer went into the Appearance sheet and chose
these colours for their own vision. It is scoped to the mark; every other surface still
honours the OS.

Clamping the ring to fit a small box was rejected. It is the original bug wearing a different
hat: it makes 10 mean something else again, and it does so by way of the activity's size,
which is a video-space quantity.

**Cost.** The pulse is a layout animation now, not a compositor one. It is one absolutely
positioned element whose parent cannot resize, and it only runs when a viewer has gone and
switched the pulse on — which is off by default (see the Motion section of DESIGN.md).

**Why CSS pixels and not physical device pixels.** "Pixel-perfect with the monitor" has a
second reading that is a trap. Dividing by `devicePixelRatio` to reach hardware pixels would
make the border *thinner* on exactly the high-density screens where it is hardest to see, and
would shrink it when a low-vision viewer zooms in — the one action they take to make things
bigger. DESIGN.md commits to browser zoom as the magnification path for the same reason.

**The dynamic square's size stays a percentage of the wrapper**, not a baked pixel value:
the wrapper tweens its own width and height over 350ms when the highlight moves to the next
moment, and a percentage re-resolves against it every frame of that tween. Pixels computed at
render time would snap while the wrapper was still gliding, tearing the border off the box.

**Consequences.** Existing persisted settings keep their names and ranges but change meaning
— a stored `border_width: 10` now paints 10px where it used to paint 5. That is the point,
so there is no migration. The four presets were **not** retuned: their numbers are now honest,
and on a typical downscaled 1080p lecture every preset's border roughly doubles in apparent
thickness. `enhanceSource()` also derives the enhanced crop from the box's CSS extent rather
than from the analyzer rectangle, which fixes fixed-circle mode enhancing an activity-sized
rectangle underneath a 52px circle. Verified by `player/indicatorMetrics.test.ts` and by
measuring the real components in a headless browser at five video/player combinations, three
Size settings and four points on the pulse timeline: 10.0px in every one.

**Four bugs found while verifying this, since fixed.** Three predate D26; the fourth was
introduced while fixing the first, and is here because of how it was caught. All four surfaced
because measuring the pulse properly meant driving it in a browser.

*The pulse only ever ran once.* `animation: pulse ... forwards 3` reads as three throbs per
moment, and that is what the first moment got. But `selectActivity` hands one moment straight
to the next whenever they fall within lead+linger of each other — most of them, on a real
lecture — so the wrapper never unmounts, React reuses the element, and a finished CSS
animation does not restart because the styles around it changed. Measured: `pulse` sat
`finished` at t=3000ms and every subsequent moment was silent. The feature quietly stopped for
exactly the viewer who went and switched it on.

The fix rewinds rather than remounts, in an effect keyed on the moment: `key={currActivity.id}`
would restart the animations, but it would also tear down and rebuild `EnhanceCanvas` — a
fresh WebGL context per moment (`GLEnhancer.create`/`dispose`) on the weak hardware this app
is built for. Re-measured: `running` at t=117ms after a handover.

It rewinds in a `useLayoutEffect`. The hazard is a frame where the box has already moved to
the new moment while the throb is still at the old one's phase: hand over near the top of a
throb and that is a 25%-oversized box, on the one element whose job is to be the calm thing a
viewer can find. React explicitly permits the browser to paint before a passive effect runs,
so that frame is an allowed scheduling path.

Measuring it properly — box width sampled per frame, handover timed to land at the peak — did
**not** reproduce it: React flushed the passive version before paint in every run. (An earlier
phase-only measurement appeared to show the stale frame and did not; it was sampling before
React had committed, so the box was still the old one too, and D26 briefly claimed a flicker
on that basis. It is recorded here because "measured" and "measured the right thing" are not
the same claim.) A layout effect is the one that promises, and the promise costs one
`getAnimations` call.

The dependency list is deliberately narrow: the moment, an entry counter, whether the ink
canvas exists, and the ink's shape. Those are the edges that MOUNT a fresh animation at phase
zero against a border already mid-cycle. `animation_speed` is not one — both durations change
together and stay in phase on their own, while rewinding on it would snap the box back to rest
on every tick of a slider the viewer is dragging. The entry counter exists because the id
alone is not enough: leaving a moment and scrubbing back into it inside the 350ms fade-out
never unmounts the wrapper and never changes the id, so the returning highlight would arrive
with its throbs already spent.

*`getAnimations()` returns more than CSSAnimations.* The first version of that effect read
`.animationName` off everything the call returned. It also returns the wrapper's
`CSSTransitions` — the 350ms glide of left/top/width/height, which is running at precisely
that instant, because the highlight just moved. Transitions have no `animationName`, so this
threw inside an effect and took the player down on **every moment handover**. It never reached
a commit, but nothing in the unit suite could have seen it: it needed a real browser driving a
real handover. What the unit suite covers instead is `isThrobAnimation`, which is where the
decision now lives — fed a transition, an unnamed scripted animation, the wrapper's own fade,
and a same-family impostor.

*The ink and the border drifted apart.* `pulse` and `ink-spread` are two animations describing
one throb, and the clip only lines up with the ring if they share a phase. Switching an enhance
filter on mid-throb mounted a fresh canvas at phase zero against a border already 1117ms into
its cycle. Whether the ink canvas exists at all is a dependency of the rewind effect for that
reason — the canvas appearing, and the ink swapping between its square and round clips, are
the two edges that mount an animation at phase zero. Measured after: 83ms and 83ms.

*The pointer stood in the middle of the circle.* For the square the pointer's tip anchors to
the box's bottom-left corner and the hand hangs down and away. A circle has no corner there,
so anchoring to its bounding box's would have left the pointer floating in the empty quadrant
outside the disc — and the code compensated by translating it up by its own height, which on a
52.5px circle is 35px. That put the tip in the MIDDLE of the disc, with the hand covering the
one thing the circle had been drawn around. The honest analogue of a corner on a circle is the
point of its circumference facing the same way: 225 degrees, down and to the left. The tip
walks out from the centre by the radius less the usual overlap, along that diagonal, and the
`translate` is gone.

*The round mark had a square patch under it.* In fixed-circle mode the enhanced region was
the right size but clipped with `inset()`, so the four corners got bolder ink with nothing
pointing at them — worse than no enhancement, when the whole job of the mark is "look here".
`round 50%` on a square inset box is a circle, so the same 10%-to-0% inset drives it:
`inset(10% round 50%)` reveals a 52.8px circle against the ring's 52.5px at rest, and the full
66px against 65.625px at the peak. `clip-path: circle(50%)` covers the pulse being off, at 53px
against 52.5px. Those sub-pixel gaps are the enhance canvas rounding its backing store to whole
pixels (EnhanceCanvas.tsx) and are left alone: closing them would mean giving the canvas a CSS
size different from its bitmap size, which resamples a picture of the lecture to save a third
of a pixel.

---

## D27 — The enhance canvas is measured in device pixels, and the highlight moves under it

Three bugs the author found testing D26's work in the running app.

**The ink was not sitting 1:1 on the frame.** `EnhanceCanvas` set its bitmap to
`Math.round(width)` and gave it no CSS size, so the browser displayed it at the rounded width.
The crop is drawn to fill the whole canvas, which means every copied pixel was stretched by
`round(width) / width` — 0.57% on a 65.625px circle. Under half a pixel at the centre, but it
accumulates outward, so the edges of the enhanced patch slid off the writing they were copied
from. The same rounding left the ink clip revealing 52.8px inside a 52.5px ring.

The canvas is now sized twice, deliberately: its CSS box is the exact unrounded extent, and
its backing store is that box in **device** pixels. Measured before: 0.4px and 0.3px of
clip-versus-ring mismatch. After: 0.00px, at devicePixelRatio 1, 1.25, 1.5 and 2.

The backing-store half also fixes a HiDPI defect nobody had reported: a CSS-sized bitmap on a
150% or 200% display is upscaled by the compositor, so the enhanced patch was a *blurred* copy
of the lecture laid over the sharp original — the opposite of what an enhance filter is for.
The bold and sharpen kernels step one texel, so they now take a `pixelRatio` and scale that
step, or "one pixel of thickening" would have quietly become a third of a pixel on the
displays where it was already hardest to see.

**With a filter on, the highlight teleported.** The geometry transition was disabled whenever
an enhance canvas was showing, because the canvas holds a copy of the video from one position
and a CSS tween would slide that copy across the frame showing pixels borrowed from where the
box used to be. That traded a smear for a flinch, and a viewer tracking the mark across a
slide is exactly who loses it when it jumps.

It now tweens the **activity rectangle** instead of the CSS (`player/activityTween.ts`). The
wrapper's geometry, the box's size, the canvas's size and the canvas's source crop are all
derived from one rectangle, so interpolating that rectangle keeps all four in agreement by
construction — the copy is re-cut from the video every frame at wherever the box has got to.
Measured through a move: the crop stays locked to the box within 0.016 video px. The curve is
`cubic-bezier(0.42, 0, 0.58, 1)` solved by Newton, not approximated, so the mark travels
identically whether CSS or this is driving it — measured, the two agree to 0.1px per frame.
It costs a re-render per frame for 350ms, which is why it is only used when a filter is on.

**And then it jittered.** The first version started the journey in a passive effect. That left
one render — the render in which the moment changed — with no journey yet, so the geometry
fell through to the destination and the browser painted it there. Captured off a screencast of
actually-painted frames: `167 - 365 - 365 - 167 - 168 - 170 - 176 ...`. The mark appeared at
the far end for two frames, jumped back, and only then travelled.

Seeding progress 0 inside a `useLayoutEffect` fixes it, because the resulting re-render is
flushed before paint. Re-measured on painted frames: `167 - 167 - 170 - 176 - 181 - 190 ...`,
strictly monotonic, zero backward steps, in all three of square-with-ink, circle-with-ink and
the CSS path without. The journey also resumes from where the mark *is* rather than from the
moment it was heading for, so stepping quickly through moments does not send it back to
collect one it never reached.

The lesson worth keeping: `getBoundingClientRect()` inside a `requestAnimationFrame` callback
reported the destination for those two frames in BOTH paths, including the CSS one where the
browser never painted it. It cannot tell a committed style from a painted pixel. The screencast
could, and that is what caught this.

---

## D28 — The scene-change notice is the viewer's to switch off

**Decision.** "Possible scene change" — the pill that appears at the top of the video when
playback crosses a cut — is now a setting, `sceneNotice` in `ViewSettingsStore`, defaulting to
on. The control is a Notify/Quiet pair in the moments sidebar, next to the arrangement switch.

**Why it is in ViewSettingsStore and not HighlightSettingsStore.** A preset is a COMPLETE
snapshot of the highlight and magnification stores (D-note in presets.ts), applied wholesale.
A notice preference kept there would be switched back on the first time the viewer tried a
preset — by a control that says nothing about notices, and with no way to tell that is what
happened. The same reasoning already keeps `groupByScene` out of that store.

**Why the default is on.** It is a cue some viewers rely on to know the slide changed under
them, and turning it off by default would remove that from everyone to spare the people who
find it noisy. A feature that never appears is also one nobody discovers well enough to want
off.

**It is a switch in the footer, not a segmented pair in the header.** It shipped first as a
Notify/Quiet pair beside the arrangement switch. On/off is what this is, though, and a
segmented control renders both states as buttons — so a viewer has to read two words to work
out which one is current, where a switch says it by position. It also is not a control over
the rows above it; it is a standing preference about the video, which is why it sits under the
list rather than in a header already carrying the heading, the position readout, Export and
the arrangement switch. Mantine's `Switch` gives it `role="switch"` and wires the label to the
input, so pressing the words works.

**No description line under it.** There was one — "A pill at the top of the video when the
slide or camera cuts". Under 900px the sidebar is capped at 40vh, and three wrapped lines
pushed the footer past that cap, where the panel's `overflow: hidden` cut the switch off
entirely. Measured. The sentence moved to the `title`, which is a hint rather than the only
way to understand a control that already says what it does.

That cap also grew a floor: `max(40vh, 15rem)`. 40vh is a share of the WINDOW, and on a short
one it drops below what the panel's own fixed chrome needs — at 320x320 the switch vanished
outright. The floor is in rem so it grows with the reader's font size, and the page scrolls
normally around a taller panel, which is what an ordinary scrolling document is for.

**Gated in two places.** The trigger reads the store through `getState()` — it runs from the
frame loop, which outruns re-render — and the render gates the pill as well. Only doing the
first would leave a notice already on screen there for the rest of its 2500ms after the viewer
asked for quiet.

**Only when there is more than one scene**, matching the arrangement switch: with a single
scene there is no cut to cross, so the notice can never fire and the control would be a switch
for nothing.

**Not covered.** The "Analyzing this part…" cue is a different thing — it reports that the app
is not ready yet, rather than commenting on the lecture — and it stays unconditional.

---

## D29 — "Change" opens a file picker, and only a running analysis asks before it goes

**Decision** (747b91f). The top bar's Change button no longer calls `reset()`. It opens a file
picker that feeds the same `loadFiles` a drop does, so dismissing the picker changes nothing and
picking a file is the decision. Loading a different video while an analysis is still running
goes through a confirm first (`ConfirmSwitch`). Dropping a video on the player screen goes
through the same gate, because it goes through the same `loadFiles`.

**What was wrong.** Change sent the viewer straight back to the landing screen. One click,
and the lecture, its playhead and any analysis in progress were gone, with nothing to go back
to: the landing screen has no "return to what I was watching". A user reported exactly that.
The button's label promised a choice and its behaviour made the choice for you before you had
seen any alternative.

**Why the confirm is only mid-analysis.** A finished analysis is already in the IndexedDB
cache (`utils/analysisCache.ts`, keyed by size, duration and frame size), so opening that
video again restores it at once and nothing is lost by switching. A running one is not cached
until `done` arrives, and switching away throws away every minute it has spent. The dialog
asks only when there is something to lose, and its second paragraph says what: "Only a
finished analysis is kept. Open this video again later and it starts over." A confirm on
every switch would train the viewer to click through it, which is how a confirm stops working
the one time it matters.

**Same pattern as D23.** A native `<dialog>` for focus trapping, Esc and a backdrop; Esc and
the backdrop both mean cancel; "Keep watching" is autofocused, because the risk is a stray
Enter destroying twenty minutes of work, not the cost of one more click. The picker's value
is cleared after each pick, or choosing the same file twice in a row would fire nothing the
second time.

**Rejected: keep `reset()` behind a confirm.** That would make the loss deliberate without
making it necessary. The landing screen exists to get a first file in; once a video is open,
the only reason to go back there was to pick another one, and a picker does that without
unloading anything first.

**Space on the dialog's buttons did nothing** at first; Enter worked. The player's document-level
Space hotkey took the key. Found by the Codex review and fixed in the same round (dda1bdb, see
D31).

**Verified** (headless Chromium 145, 1366x768). Dismissing the picker leaves the file and the
analysis untouched. A pick or a drop mid-analysis opens "Switch to another video?" with "Keep
watching" focused, and Esc, the backdrop and Enter all keep the lecture. Once the analysis has
finished (a 12s clip, done in 4.4s), a pick switches with no dialog.

**A hole in "finished means cached", fixed in the same round** (2a6e16f). It predates this
entry. An analysis that came from a moments file was finished (`done` is set by `hydrateFrom`)
but never cached, because only the worker's `done` path called `cachePut`. Switching away from
one asked nothing, which this entry's own reasoning allows only for cached analyses, and
reopening the video re-analyzed from scratch. The `.veasyguide.json` was still on the viewer's
disk, so dropping it again would have recovered the moments, but "nothing is lost" was not true.

`cachePut` now also runs in `applySidecar` and in the video-plus-sidecar branch of
`loadFilesNow`. It does not run in `hydrateFrom`, because a cache hit restores through
`hydrateFrom` too, and would rewrite its own entry on every reopen.

The fix exposed a second bug. The cache keeps the newest 20 entries, ordered by a `savedAt`
index, and that `savedAt` was the **file's**: the time the analysis was made, not the time it
was cached. For a sidecar a classmate made months ago, the entry just written was the oldest in
the cache and the first one evicted. The record's `savedAt` is now the time it was cached (an
ISO string, the same type as before, so it orders correctly against existing entries). The
file's own `savedAt` is untouched inside `file`.

Measured on a fresh headless profile with a 12s clip and its sidecar: the cache entry exists
right after the video and sidecar load. After a reload, opening the video alone restored the
analysis in 923ms, where a fresh analysis of it takes about 4s or more.

**Still open.**
- `cachePut` is best-effort and swallows failures (a full quota, storage blocked). If the
  write failed, a finished analysis is gone after a switch, with no confirm.
- The cache restores the analysis, not the playhead. Reopening a finished video started at
  0:00. *Later in the same round:* D33 offers to resume where the viewer left off.

---

## D30 — The fill pair reads Fill / Opacity, and the magnifier gets its own way in

**Decision** (03c963e). In the Appearance sheet's box group, the fill colour comes first, labelled
"Fill", with the slider under it labelled "Opacity". The sheet's root has two rows where it had
one: "Fine-tune the highlight" (showing the active preset) and "Fine-tune the magnifier"
(showing the current zoom, e.g. "2.0×"). The tab and the screen title say "Magnifier" rather
than "Zoom", and the tabs run Box, Pointer, Motion, Ink, Magnifier — the highlight's groups
together, the magnifier last, with Ink between them because it spans both.

**"Fill" was read as an amount.** The slider was labelled "Fill" and sat above "Fill colour",
so a percentage beside the word "Fill" read as how much of the box is filled, not how strongly
the colour shows. A user asked for it to say Opacity. Putting the colour first makes the two
rows a pair — what colour, then how strong — and "Opacity" under "Fill" reads that way without
repeating the noun.

**Rejected: "Fill opacity" as the visible label.** It is the accurate name, but at the label
size it would wrap in the 62px column, pushing the slider onto its own line and breaking the row
rhythm of the group. That was the reasoning when the change was made. The width of "Fill
opacity" itself was never measured. "Opacity" alone renders at 44px and "Fill" at 17px, so with
a space between them they add up to about 65px, over the column's 62px. That sum is arithmetic
on two measured words, not a measurement of the label. The accessible names were already "Fill
colour" and "Fill opacity" and are unchanged, so a screen-reader user hears the full name either
way; only the visible label is shortened.

**The magnifier was there and nobody found it.** Its settings were a tab inside the box's
Fine-tune screen. The root's only row said "Fine-tune" and opened the box, so a viewer looking
for the magnifier's strength had to guess that the box's screen also held it. A user reported
not knowing it could be adjusted at all. Both rows lead to the same tabbed screen; each just
opens its own group, so nothing is duplicated and nothing moved. "Zoom" became "Magnifier"
because the control bar's toggle already says "Magnify (Z)" and "Magnify the highlighted
area", so the sheet was the one place calling the feature something else. The store keys
(`zoom_strength`, `zoom_motion`) and the screen id `zoom` are unchanged; only words a viewer
reads moved.

**Cost, measured** (headless Chromium 145, 1366x768, DSF 1, Atkinson Hyperlegible loaded). The
root's content grows from 289.42px to 320.83px with the second row; the sheet's outer box, with
its border, goes from 291.4px to 322.8px. Every drill screen (Box, Pointer, Motion, Ink,
Magnifier) is 351.1px outer, the same as before, so the root is still shorter than the screens
under it. The promise the sheet was built on, "you go DEEPER, not longer, so the band of video
it occludes never changes", still holds.

The header comment's "a fixed 340x260" is wrong on both axes. The sheet renders 398px wide
(396 plus a 1px border each side) and 351.1px tall on the drill screens. That predates this
entry and is recorded rather than fixed here.

Rendered label widths in the 62px column: Border 37, Colour 37, Fill 17, Opacity 44, Shape 36,
Size 25. All fit on one line. The five tabs end at 293px of a 372px row (79px spare), with no
horizontal scroll. The Ink screen's "The highlight" / "The magnifier" choice renders both
options on one line, 30px tall, in a 300px control. On the old layout "Fill colour" also fitted
in the column, so the reorder was about how the pair reads, not about room.

---

## D31 — Four player buttons name themselves on hover and focus, and get keys

**Decision** (aac5b37). Appearance, the moments list, Snapshot size and Move snapshot show a
styled tooltip, `PlayerTip`, with the control's name and a keycap. It opens on pointer hover
and on keyboard `focus-visible`, and it replaces the native `title` those buttons had (or the
nothing they had). New keys: A opens Appearance; L is the moments list; C and S move and resize
the pinned snapshot. A "Single-key shortcuts" switch in the moments sidebar's footer turns off
every printable-character key (`letterShortcuts` in `ViewSettingsStore`, default on). Space and
the arrow keys stay on regardless. The other bar controls are deliberately left for later
(TODOS.md, "Keyboard reach for every player control").

**What was wrong.** A user on Windows saw no names and no shortcuts on these controls. Appearance
and the moments list had no visible name at all, only an `aria-label` that a screen reader
announces and a sighted viewer never sees. Size and corner had a native `title`, which uses a
small system font that ignores page zoom, arrives after a slow fixed delay, never shows on
keyboard focus, and did not appear for the user on Windows. It also does not appear over a
fullscreen element.

**This partly reverses a rule.** `AppearanceSheet.tsx` says "No tooltips: a hover tooltip is
invisible to a keyboard user, a screen-reader user and anyone driving a magnifier". That rule's
reason was tips shown only on hover. This tip also opens on keyboard focus, so a keyboard user
gets it on Tab. The screen reader already has the name from the `aria-label`, and gets the key
from `aria-keyshortcuts`. A magnifier user who tabs to the button finds the tip beside the focus
ring, where their view already is. The rule still governs the sheet's own hints, which stay
visible text inside the sheet, and the comment there now says so and points here (625956a).

**It also reverses D20's "No new hotkeys".** D20 left the snapshot cycles without keys because
"the keyboard map is already dense". The user asked for keys. C and S act only while something
is pinned, and they do not reveal the bar (they are in `NO_REVEAL_KEYS`, like Z and P), so
moving the snapshot does not put the bar over the video.

**L does different things in the two modes, because there is different work to do.** In
fullscreen it toggles the moments overlay, like the button. Windowed, the list is always on the
page, so there is nothing to open, and L moves focus to the list's current row instead.

**Where the tip is drawn.** It portals into the player container, which is shared through a
React context (`player/tipRoot.ts`) holding the element from a callback ref merged with
`containerRef`.
- Rejected: portal to `<body>`. In fullscreen only the fullscreen element's subtree is drawn, so
  the tip would vanish exactly where the bar is most used. D24's Speed menu sets
  `withinPortal={false}` for the same reason.
- Rejected: render inline. `.pin-panel` has `overflow: hidden`, which would clip the tips on the
  snapshot's own buttons.

**Details the library forced.**
- The `Tooltip` wraps **outside** `Popover.Target`. `Popover.Target` forwards its props to its
  child, and `Tooltip` spreads unknown props onto its floating box. Nested the other way, the
  popover's anchor ref and ARIA land on the tip instead of the button.
- `events: { hover, focus, touch: false }`. Mantine passes `visibleOnly` to floating-ui's
  `useFocus`, so a Tab shows the tip and a mouse click does not. Touch is off because on touch
  the tap is the click; a tip would flash on top of the popover it just opened.
- The tip is disabled while its own popover or overlay is open, and while the bar is
  auto-hidden. A hidden bar has `pointer-events: none`, so it never receives the `mouseleave`,
  and the tip would stay over the video.
- `aria-describedby` is suppressed. floating-ui's tooltip role would make a screen reader read
  the name twice, since the `aria-label` already says it.
- 200ms open delay, immediate close (300ms since the 1.4.13 fix below). Font 1rem, not Mantine's
  default 0.875rem, because the people who need the tip are the people who need it bigger. Dark
  `#12161d`, like the bar.

**Names changed with it.** Appearance is now "Appearance: highlight and magnifier"; plain
"Appearance" read as the app's theme. The corner button's `aria-label` now starts "Move
snapshot: now top right. Move to bottom right.", so it contains the words its tip shows
(WCAG 2.5.3, Label in Name). A voice-control user says what they see.

**Why the switch (WCAG 2.1.4, Character Key Shortcuts).** A one-character shortcut must be
possible to turn off or remap. Speech-input users trigger it by saying an ordinary word, and the
player's keys are registered with Mantine's `useHotkeys`, which listens on the whole document,
so they fire wherever focus is. Adding A, L, C and S grew the set to F M Z P A L C S [ ] < >,
and all of them are gated. Space and the arrows are not character keys, and they are the only
non-pointer way to drive the player at all. When the switch is off, the tips drop their keycap
rather than advertise a key that does nothing. The setting lives in `ViewSettingsStore`, not
`HighlightSettingsStore`, for the same preset reason as D28, and a test asserts that.

**The sidebar footer now always renders.** It used to exist only for the scene-notice switch,
which is gated on more than one scene (D28). The shortcuts switch applies to every video, so the
footer is always there, as a flex column with an 8px gap. The scene-notice switch keeps its gate.
About lists A, L, C and S, with a note that single-key shortcuts can be switched off.

**Rejected: scoping the letter keys to player focus** instead of a switch. That is 2.1.4's third
option, and it needs no setting, but a key pressed after clicking into the sidebar would stop
working for everyone. It is recorded in TODOS.md as something to weigh, not done here.

**Two older keyboard bugs, found while testing these keys.** Both predate this entry.
- The bar's `onKeyDown` stopped propagation of every key, so every letter shortcut was dead
  while focus sat on a bar control. That is the normal state right after clicking one: F did
  nothing right after clicking Fullscreen. It now stops only what `stopPlayerHotkeys` says to
  stop, the rule the sidebar already used, so `hotkeys.ts`'s "keys work wherever focus sits" is
  true for the bar as well (8883cbd). video-lead found it while recording D31's keys.
- ← and → seeked from `currTime`, a throttled state copy of the playhead, not from the video.
  After a seek while paused that copy can be far behind: three presses of ← right after seeking
  to 60s landed at 0.0s on main, and land at 45.0s now. They read `video.currentTime`, as the
  comment on `handleStepMoment` already said they should (ba12eb9).

**Measured** (headless Chromium 145, at aac5b37 plus 8883cbd).
- Open delay: the tip is in the DOM 212-217ms after hover over three runs, against 200ms
  configured, and fully opaque at 335-350ms once the fade has run.
- Tab focus shows the tip on Appearance, windowed and in fullscreen, and on the Moments list
  button in fullscreen (it exists only there). Snapshot size and Move snapshot were checked on
  hover, at size small in all four corners. Every tip landed inside the player container and
  the viewport, and in fullscreen inside the fullscreen element. **Not checked:** Tab focus onto
  the two snapshot buttons.
- A mouse click on Appearance opens the sheet with no tip. Clicking again closes it, and the
  tip shows only while the pointer is still over the button. Once the pointer leaves, there is
  no tip, though focus stays on the button. That is `visibleOnly` doing its job: the focus came
  from a mouse, so it is not `focus-visible`.
- With the switch off, A, F, M, Z, P, L and ] changed nothing (time, fullscreen, mute, sheet,
  pin and magnifier all unchanged), while → still seeked 0 to 5s and Space still played. The
  tip dropped its keycap and `aria-keyshortcuts` went to null. The off state survives a reload.
  **Not pressed with the switch off:** C, S, [, < and >. They go through the same gate, but
  that is read from the code, not measured.
- Auto-hide in fullscreen with the pointer resting on Appearance: the tip shows from 0 to 1.2s
  and is gone at 1.6s, the same moment the bar's opacity reaches 0. This was first reported as
  a pass ("no tip left hanging"). The measurement was right and the reading was wrong: it was a
  WCAG 1.4.13 failure, fixed below.
- 320x320: the sidebar is 240px, D28's 15rem floor. "Notify scene changes" sits at 713-737px and
  "Single-key shortcuts" at 745-769px, both inside the panel (540 to 780). The page scrolls to
  them (`scrollHeight` 852), and both are reachable. Same at 320x568, 600x400, 899x500 and
  899x700, where the cap is 40vh = 280px.
- A real screen reader was not run.

**Fixed in the same round: the tip failed WCAG 1.4.13** (dda1bdb). Content that appears on hover
or focus must be hoverable, persistent and dismissible, and the first version met only the
third.
- Not persistent. In fullscreen it vanished at 1.6s with the auto-hiding bar while the pointer
  was still resting on the button: the auto-hide measurement above, first misread as a pass and
  caught by an independent Codex review. The fullscreen idle-hide now skips while the bar or a
  tip is hovered. Measured: resting 3.5s in fullscreen keeps both the tip and the bar.
- Not hoverable. The tip had `pointer-events: none`, so it could not be reached: walking the
  pointer from the button toward it in 6px steps, it was present up to y=623 and gone from
  y=617, before the pointer arrived. A magnifier user, who has to move across a tip to read it
  at their zoom, lost it on the way. It now has `pointer-events: auto` and a 300ms close delay,
  and floating-ui cancels the close when the pointer enters the tip. Measured: the same 6px walk
  never loses it.
- Dismissible: Escape closes it, through Mantine's `useDismiss`.

Re-measured independently. On the 6px walk from the Appearance button onto its tip, the tip is
present at all 8 steps and still there 400ms after landing on it. In fullscreen, with the
pointer resting on the button, the bar's opacity is 1 and the tip is shown at every 500ms sample
from 0 to 4.0s; once the pointer moves onto the picture, both hide. Escape dismisses a hovered
tip, windowed and in fullscreen (fullscreen is kept), and a keyboard-focused tip. The tip lingers
400ms after the pointer leaves the button, the 300ms close delay plus the transition. Tab still
shows it, and a click followed by leaving still shows none.

The close delay changes the timing reported above, which was "immediate close". The open delay
is unchanged.

**Fixed in the same round: Space was taken by the player.** Buttons outside the player that did
not call `stopPlayerHotkeys` let Space bubble to the player's document-level hotkey, which
played or paused the video instead of pressing the button. Space on D33's Resume played from
0:00 and dismissed the offer; Space on D29's "Switch video" did nothing. Enter worked in both,
which is why nobody had noticed. Now guarded: the resume strip, the strips' ✕ buttons, the
header's Change and Moments file buttons, and all three modal dialogs (both confirms and About).
The dialogs stop every key, because the player is inert behind a modal anyway (dda1bdb).
Re-measured independently: Space on Resume lands at 124.00s from a stored 124, playing; Space on
"Start from the beginning" stays at 0, paused, and removes the strip. Space on "Switch video"
switches, Space on "Keep watching" closes the dialog and keeps the current video, and Escape and
Enter still work. About blocks F, M, Z, A, L, ], Space and →. Space on the header's Change and
Moments file buttons opens the picker and leaves the video paused.

**And two tests that could not fail.** The "on by default" tests for `letterShortcuts` and D28's
`sceneNotice` asserted the value their own `beforeEach` had just set. They now read
`getInitialState()`, so flipping a default fails them (dda1bdb).

**Still open.**
- Previous moment, Next moment, Playback speed, the Magnify toggle, the Pin toggle, the
  sidebar's Export, and both footer switches still use a native `title`. The Single-key
  shortcuts switch's `title` is where the list of keys it covers lives. Fullscreen, Mute and
  Collapse/Expand have only an `aria-label`, with no visible name at all. All of these are the
  same defect this entry fixed for four buttons. TODOS.md has the plan.

---

## D32 — The control bar sits below the video, except in fullscreen

**Decision** (9e5fdbf). In the windowed player, the control bar is laid out under the video and
never hides. In fullscreen it overlays the picture as before, but it now auto-hides even while
paused, and it starts collapsed. Collapse exists only in fullscreen: the windowed bar is always
expanded, and leaving fullscreen returns it to expanded. That last part was revised within the
round (c1785ae); see "Revised: no collapse in the window" below. The bar's contents were then
cut to one slim row (D34), which is what finally made its height stop depending on its width.

**What was wrong.** A user reported that the bar covered the bottom of the video. On a lecture,
that is where the instructor writes last, at the foot of the slide, so the bar masked the
newest writing, and the highlight and magnifier could sit under it. Measured on main@d2e19c3 at
1400x900: on a 1062x597.4 video, the overlaid bar covered the bottom 139.8px expanded (23.4% of
the picture) and 53px collapsed (8.9%). After the change it covers 0px. Windowed, the bar's top
minus the video's bottom is 0.00px at 1366x768, 1920x1080, 1536x864 at DPR 1.25, and 320x640.

**The cost: a smaller picture on short windows.** The bar's height now comes off the height
available to the video, not off the video. At 1366x768 with moments, the expanded bar is 139.8px
(scrubber, moment lane, now-line, controls), and the video drops from 1028px to 832px wide, 19%
narrower. With the bar collapsed it was 987px, until collapse was removed from the window
(below). At 1400x900 the video stays 1062px wide, because there the available width limits it
before the height cap does: the new cap works out to about 1067px there. The user chose the bar
below the video; this is the price of that choice, recorded here so it is a known trade and not
a surprise. As first shipped, collapsing the bar got most of the size back; that is no longer
offered in the window. Moving the now-line into the sidebar was weighed as another way back and
rejected (below), so the cost is accepted, not pending. The 832px is exact arithmetic for a
139.8px bar. It has to be re-checked once the feedback loop under Still open is fixed, because
the loop makes the bar taller than that on some windows. After the fix (eaceeb5, below) the cap
subtracts a constant 140px, which gives the same 832px by arithmetic. D34 then cut the constant
to an 89px bar, and 50ac023 (below) replaced the guessed 160px of page chrome with the measured
chrome, so neither 832 nor any later arithmetic for 1366x768 describes the current build.
Re-measured at cb3c512: the video is 992px wide at a 1366x768 viewport.

**Why fullscreen still overlays.** In fullscreen the video fills the screen. Making room for the
bar means shrinking the video, and doing that only while the bar shows re-lays out the picture
on every reveal (rejected below). So the bar overlays, and the cost is kept small instead: it
starts collapsed (54px measured at 1400x900), and it hides after a short idle even while paused,
because a paused frame is one someone is reading. The idle delay is still 2000ms, and the bar
still never hides while keyboard focus is inside it, or, since dda1bdb, while the pointer is
over the bar or one of its tips (D31). Measured: opacity 0 by 2.6s idle while paused, the 2000ms
delay plus the fade. **That measurement holds only when fullscreen was entered by key, or when
something has blurred focus since** (see Still open). Entering fullscreen always collapses the
bar. As first shipped, leaving restored the windowed state both ways, measured expanded to
expanded and collapsed to collapsed; since c1785ae there is no windowed collapsed state to
restore. The `clear` class is now `hideControls && isFullscreen`, where it was `&& isPlaying`,
and the `.paused` force-visible rule is gone.

**Rejected.**
- Hide the bar only while paused. A viewer pauses to read, moves the mouse, and the bar comes
  back over the very line they paused for.
- Keep the overlay and start it collapsed. Shorter, but it still covers the bottom of the frame,
  and the bottom is where the writing is.
- In fullscreen, shrink the video whenever the bar shows. Every reveal changes the video's box,
  so the highlight and magnifier recompute and jump under the viewer's eye each time the mouse
  moves.
- Move the now-line (the status line) into the sidebar's header, to win back windowed picture
  size. Considered after collapse left the window, as the way to shorten the bar without a
  control that resizes the player. The owner kept the line in the bar. The smaller windowed
  picture (832 against 1028px wide at 1366x768) is an accepted trade, not an open defect.
- Move the bar after the video in the DOM. The bar stays first in the DOM, and CSS `order: 2`
  places it below. Moving it would change a tab order viewers already know, and would put the
  pin panel's buttons ahead of the bar.

**It resolves the geometry landmine.** TODOS.md carried a warning: the overlay layers were 100%
of `.video-container`, and the letterbox math held only because the video was that container's
only in-flow child. "Do it before any change that puts a second element in the player
container's flow". This is that change. Every layer drawn on the picture now lives in
`.video-stage` (`position: relative`), whose box is the `<video>` box. That covers
`.video-highlights`, `.video-magnification`, `.video-overlay`, the pin panel and the fullscreen
moments overlay. Left where they were, they would have stretched over the bar. Highlights and
magnification also got an explicit `top: 0; left: 0`. Static position inside a block parent
would have put them below the video, not on it.

The highlight math did not change. It already measured the `<video>` element
(`useElementSize` on the video), not the container, so the half of the TODOS fix about
measuring is already done. The `object-fit: contain` change it proposed was not needed.
Windowed, `aspect-ratio: 16/9` stays. In fullscreen the video is `height: 100%` with
`aspect-ratio: auto`, and the browser letterboxes it, which is what `computeLetterbox` expects.
The video is now `display: block`. An inline video leaves a baseline gap under itself, which
would have offset every overlay by a few pixels.

Measured at 1400x900: the stage, the video and all overlay layers share one 1062x597.4 box.

**Alignment, measured from screenshots** against main@d2e19c3. The painted video rectangle was
found from pixels. The highlight's box came from a with/without-overlay diff. The magnifier was
compared by normalized cross-correlation against a synthetic zoom of the unmagnified frame.
- 1920x1080, DPR 1, where the video's size is the same before and after: every number is
  identical to 0.01px. Highlight edge outsets (left, top, right, bottom) are
  6.83/1.04/6.31/3.31px windowed and 11/2.39/10/3.84px in fullscreen. The magnifier residual is
  (−1, −4)px windowed and (0, −2)px in fullscreen, before and after alike.
- 1366x768, DPR 1, where the picture shrinks: before, the outsets were 5.11/1.24/5.88/2.51px on
  a 1028px picture. Scaled to 832px that predicts 4.14/1.00/4.76/2.03px, and after they are
  4.27/0.83/5.00/2.55px, at most 0.5px from the prediction. Magnifier residual (−1, −2) before,
  (0, −3) after. Fullscreen identical.
- 1536x864, DPR 1.25: after, outsets are 5.76/0.96/6.48/3.36px windowed and 5.44/1.84/7.28/2.87px
  with the bar collapsed; fullscreen identical to before. The magnifier residual is (1.6, −1.6)
  after against (0, 0) before, on different picture sizes. At zoom 1, as a control, it is
  (0.8, −0.8) after and (0, −0.8) before.

Largest change against before: the highlight within 0.5px at DPR 1 and 1.1px at DPR 1.25, the
magnifier within 2 device pixels. All of it is inside the residual main already shows, up to
4px at 2.5x zoom, which looks like a bias in the measurement from the dark bottom rows of the
test frame rather than a real offset. Nothing here moved the overlays off the picture.

**Offsets that assumed the bar was on the picture.** The pin panel's `bottom` and `max-height`
(D20's `calc(100% - barHeight - 24px)` and `barHeight + 12`) and the preview-jump pill now
subtract the bar height only in fullscreen (`barOverlap = isFullscreen ? barHeight : 0`).
Windowed, they become `calc(100% - 24px)` and a 12px inset, the same as the top corners.
The moments overlay exists only in fullscreen, so it keeps `barHeight`. D20's note that "a tall
panel grew UNDER the bar" now describes fullscreen only.

**Player sizing.** The width cap was `calc((100vh - 160px) * 16/9)`, which assumed the bar sat on
the video. It is now `max(20rem, calc((100vh - 160px - var(--bar-h, 0px)) * 16/9))`, where
`--bar-h` is the measured bar height set inline (0 in fullscreen), so the video and the bar
together fit the window. That measured height turned out to be a feedback loop, and was replaced
by a constant within the round (eaceeb5, "Fixed: the width cap fed on itself" below). The
flat 160px was itself a guess, replaced by measured chrome (50ac023, "Fixed: the cap guessed
the page chrome" below). The 20rem floor exists because at 320x320 the formula alone gives a
video under 20px wide. Below the floor the page scrolls, which is what a page is for.
Measured at 1400x900: the player's bottom edge is at 802px, inside the 900px window, and the
sidebar spans the player's full 737.2px height. At 1366x768, 1920x1080 and 1536x864 at DPR 1.25
nothing scrolls, and the player causes no horizontal overflow. At 320px wide the player is
264px and fits. At 320x320 with the bar expanded it runs to 397px, past the window: that is the
20rem floor, by design.

*Correction, same round:* these "fits the window" checks measured that the player's bottom edge
was inside the viewport. A video that has shrunk always passes that test, so they could not
catch the player sizing itself too small, and they did not: the owner found the feedback loop
under Still open on a desktop window. They prove that nothing overflows, not that the video is
the right size.

The old `@media (max-width: 520px)` block that already put the bar in flow (the WCAG 1.4.10
reflow case) is now the default everywhere, and it is gone.

**Revised: no collapse in the window** (c1785ae, the user's decision). As first shipped, the
windowed bar kept its collapse button. With the bar in flow, the player's width cap subtracts
the bar's measured height (`--bar-h`), so collapsing or expanding resized the whole player, and
the interface jumped under the viewer.
The collapse button now exists only in fullscreen, where the bar overlays the picture and its
height moves nothing. Fullscreen still starts collapsed and the viewer can expand it. Leaving
fullscreen always returns to the expanded bar. The refs that restored the windowed collapsed
state on exit (`collapsedRef`, `windowedCollapsedRef`) are gone, and the `collapsed` class is
also gated on `isFullscreen`, so a stray state cannot collapse a windowed bar. The state is
never persisted. Opening the moments overlay still collapses the bar, which only ever happened
in fullscreen. Measured at 1400x900: the windowed player is 1062x737 before fullscreen and after
leaving it, with no collapse control in the window. Re-measured independently: no collapse
control in the window, and the player held at 1062x737.17 through load, the Appearance sheet,
a pin, the magnifier and a fullscreen round trip. Fullscreen enters collapsed at 54px; Expand
gives 140.8px and Collapse 54px.

**Fixed in the same round: the bar still resized the player on its own** (d3d2108). Removing
collapse left two jumps. The moment lane and the now-line mounted only once the analysis had
found a moment, and the now-line wrapped onto more lines as its text grew. The windowed bar is
in flow and the width cap subtracts `--bar-h`, so each of these resized the player while the
viewer was watching. Now the lane and a single now-line render from the first frame. The
now-line reads "Looking for moments…" before any moment, and "No annotation moments found…"
once an analysis finishes empty; the separate empty-state line is merged into it. The now-line
is held to one line (`nowrap` and an ellipsis on the sentence, in CSS only, so its
`role="status"` still announces the full text). The empty lane is `aria-hidden`. Previous and
Next are always rendered, disabled until there is a moment, so their arrival cannot wrap the
controls row.

Bar height over a whole session (analysis, playback, magnifier, speed), before and after, on a
clip with moments: 1400px wide, 81 then 140px became a constant 140px; 800px, 81 then 140 became
140; 560px, 128 then 187 became 187; 400px, 128 then 259 then 234 became 234. A clip with no
moments holds 140px and 234px. The price is that the player is sized for the full bar from the
start, so before the first moment the picture is smaller than it was, and it no longer grows
and then shrinks. The truncation applies only where wrapping actually changed the height:
it did at 400px, and wider windows never truncate. Also fixed on the way: "1 moments so far"
now reads "1 moment".

**Correction: d3d2108 did not hold the player still.** The numbers above are real, but they
come from one clip at four widths, where the bar did settle at one height. An independent
re-measure found the player shrinking on other windows, at d3d2108:
- 800x600: the player went from 744 to 533.7 to 450.1px wide as the analysis started, and the
  bar from 140 to 186.8px.
- At 200% zoom (683x384 CSS px at DPR 2): 398 to 320px wide.
- At 400% zoom (341x192 at DPR 4): the bar went from 233.8 to 280.8px when the magnifier or
  speed was used mid-playback.
- Stable, as reported: the clip with moments at 400, 560 and 1400px wide (233.8, 186.8 and
  139.8px), and the clip with none at 400 and 1400px.
This is the bug the owner hit, below under Still open. "Constant through a whole session" was
true only for the cases measured.

**Corrected in the same round: the ellipsis hid text** (cd5a242, replacing d3d2108's
one-line rule). Truncating the now-line at 400px held the bar still, but it did so by hiding the
end of the sentence from exactly the reader who sees the app at that width, someone zoomed in.
WCAG 1.4.10 (Reflow) does not allow losing content to reflow, and the screen reader getting the
full text does not cover the sighted reader who doesn't.

The now-line wraps freely again, and its height still does not change. It shares a CSS grid
cell (`.now-slot`) with sizers that are `visibility: hidden` and `aria-hidden`, holding the
longest content the line can ever show: a moment sentence with a three-digit moment number,
"most of the slide" and this video's own duration as the timecode, plus the magnifier chip and
"Next at". The cell is as tall as the tallest of them, so the row reserves the worst case at
the current width from the first frame, with no JavaScript measuring anything.
- Rejected: a fixed two-line height, team-lead's first suggestion. At 320px and 400px the worst
  case needs about four lines, so two lines would clip it, which is the bug being fixed.
- The empty-video sentence was shortened from "No annotation moments found in this video — the
  highlight and magnifier have nothing to follow." (96 characters) to "No moments found — nothing
  for the highlight to follow." The long one was itself the worst case, and reserved two extra
  lines on every video for a state most videos never reach. It was later cut to just "No
  moments found", at the owner's wording, and its sizer removed (9830653). The moment sentence
  with both chips is now the only worst case. Heights are unchanged.

Bar height, constant through a whole session with zero clipped samples: 140px at 1400 and 800
wide, 222px at 560, 312px at 400, 393px at 320. With the ellipsis it was 140, 140, 187 and 234.
The cost is empty space under a short sentence at narrow widths, and a smaller picture there.
Nothing is hidden. "Nothing moves" was claimed for these widths, and it has not been
re-checked against the feedback loop below, which the sizers are suspected of making worse.
Whether the reserved space is acceptable is not decided (Still open).

**Fixed: the width cap fed on itself** (eaceeb5). Introduced in this round, by 9e5fdbf's sizing
formula, and found by the owner on his desktop: a video a quarter of the window wide, under a
bar wrapped into three rows. The cap subtracted the bar's **measured** height, `--bar-h`. But the
bar's height depends on the player's width, since a narrower bar wraps into more rows. So a tall
bar made a narrower player, which made a taller bar, and the loop converged small. cd5a242's
worst-case sizers made it worse, because they wrap sooner. The "fits the window" checks could not
see it (see the correction under Player sizing), and d3d2108's "constant" numbers happened to
come from windows where the loop settled at once.

The cap now subtracts a constant: one row of bar, `108px + 2rem`, which is 140px at a 16px root
font size. `--bar-h` is gone. The lesson worth keeping: **a size must not depend on something it
causes.** Measured video width, before and after: 1366x650, 477 to 622px; 1280x600 at DPR 1.5,
320 to 533px (it had hit the 20rem floor); 1920x960, 2048x1030, 1707x840 and 1600x700 unchanged.

Re-measured independently at eaceeb5: zero size changes across 10 cases, so the loop is gone.
But at 1366x650, 1280x600 at DPR 1.5 and 800x600 the controls wrapped into two rows (a 220px
bar), taller than the 140px the cap assumed, and the page scrolled by 41-43px. D34's one-row bar
removed that.

**Fixed: the fullscreen bar never hid after a mouse click** (eaceeb5). Any focus inside the bar
blocked the idle hide, so clicking the Fullscreen button parked focus on "Exit fullscreen" and
the bar stayed up for good. Now only `:focus-visible` focus blocks it, plus an open Appearance
sheet or speed menu, which live inside the bar. Re-measured independently: after a mouse click
on Fullscreen the bar hides at 2176ms. Keyboard focus in the bar keeps it at opacity 1, and so
does an Appearance sheet opened with the mouse.

**Fixed: the cap guessed the page chrome** (50ac023). The owner reported about 100px of empty
window under the player and the sidebar. The cap subtracted a flat 160px for everything around
the player, and the real chrome is 126px: a 4px hairline, the 45px top bar, 16px and 24px of
page padding, and the 37px footer. The top bar and footer now publish their measured heights as
`--chrome-top` and `--chrome-foot` (a `ResizeObserver` in `Shell.tsx`), and one `--video-cap`
in `index.css` derives the video's width from them, the page padding and the 89px one-row bar
(D34). This is not the eaceeb5 loop again: neither bar's height depends on the player's width,
so measuring them cannot feed back.

The same commit replaces `.app.with-side`'s fixed `max-width: 1560px` with `--video-cap` plus
the sidebar and padding. 1560 was wrong both ways. On tall windows it held the video narrower
than the height allowed (1222px at 1920x1080). On short windows the page grew wider than the
height-bound video, and the sidebar was stranded at the far edge, as in the owner's screenshot.
The video and the moments list are now one centred block.
- Rejected: counting the transient strips (resume, notices) in the cap. They would resize the
  player as they appear and go, the jump this entry has spent the round removing. They push the
  player down instead, and the page scrolls by their height while they are shown.

Video width before (1605098) and after: 1920x960, 1222 to 1333px; 2048x1030, 1222 to 1458;
1707x840, 1051 to 1120; 1600x700, 802 to 871; 1366x650, 713 to 782; 1280x600 at DPR 1.5, 624 to
693. The owner's 1333x750 at DPR 1.5 gives 960. In every case the player ends 24px above the
footer. Over the whole round, at a 1366x650 viewport (what a 1366x768 screen leaves after the
browser's own chrome): 477px with the loop, 622 after eaceeb5, 688 without the now-line, 713
with the 28px bar, and 782 with the measured chrome. Re-measured independently at cb3c512 (where
both were measured, 50ac023 gave the same widths): 1333.3px at 1920x960, 782.2 at 1366x650,
693.3 at 1280x600 at DPR 1.5, 960 at 1333x750 at DPR 1.5. Also 992 at 1366x768, 1457.8 at
2048x1030 at DPR 1.25 and 1937.8 at 3440x1300. At every size the video's width is exactly the
smaller of the stage width and the height bound (ratio 1.000), and the page does not scroll
vertically. Unlike the earlier "fits the window" checks, that test fails if the video comes out
smaller than the space allows. The resume strip pushed the page down by 78px (68px of strip
plus the gap) while the video stayed
992px wide: nothing was resized. Since c8ec242 the offer is a card on the video and pushes
nothing (D33); the notices still push. "Ends 24px above the footer" and
the sidebar's centring were not measured separately; both are consistent with the numbers above.

**Narrow windows scroll, by design.** At 560px wide and below the page scrolls vertically:
86px at 560x700, 67px at 320x640, 0 at 400x800, and 252px at 800x600 and 900x600, where the
sidebar stacks below the player. That is page content arriving below, not overflow. The bar
still wraps there (121px at 400px wide, 153px at 320px), taller than the 89px the cap assumes.

**Fixed: the bar term did not follow the font size** (3c3dfe5). The cap's one-row bar was a
fixed 89px. With a 20px root font the bar is 96px, and at 1707x880 at DPR 1.5 the page scrolled
by 7px: the only desktop case found, and it fell on the reader who had enlarged the text. The
term is now `--bar-one-row`, which the player publishes only while its controls fit on one row.
This measures the bar again, which eaceeb5's lesson warns about, so the condition matters: the
one-row height depends on the font size but not on the player's width, and a wrapped bar
publishes nothing, so the player's width cannot feed back into it. At a 20px root it is 96px
and the page no longer scrolls.

Re-measured independently, with the browser's font size at 20px: at 1707x880 at DPR 1.5 the bar
and `--bar-one-row` are both 96px, the page does not scroll, and the video is 1169.8px, exactly
its stage (ratio 1.000). 1312px at 1920x960 and 970.7 at 1366x768, both ratio 1.000 with no
scroll. At 16px every width is unchanged from cb3c512. At 20px there is exactly one width change
per session (for example 983.1 to 970.7px, between 842 and 878ms after load), while the video's
`readyState` is still 0, so it lands before the first frame is shown. After that, zero changes
through analysis and playback.

**Fixed after the third Codex review** (cba52ad). Leaving fullscreen with the bar expanded
briefly published the fullscreen bar's height (90px), and the video went from 992 to 990.2px
wide for 32ms. The bar's measured height (a `ResizeObserver`) and `isFullscreen` (an event)
settle at different times, so for a frame the one did not match the other. Here it corrected
itself; near the wrap threshold, a 1.8px narrowing could have tipped the bar into two rows and
stuck. `--bar-one-row` is now read from the DOM at the one-row check itself, and never while in
fullscreen.

Re-measured independently, frame by frame through a fullscreen round trip with the bar expanded
to 90px: at 1366x768 the video goes straight from 1366px (fullscreen) to 992, and at 1366x650
from 1366 to 782.2, with no frame in between, and `--bar-one-row` stays 89px. A case within 1.8px
of the wrap threshold was not constructed. At a 20px browser font the one width change before the
first frame (above) is gone too: the video is 970.7px from its first measured frame, with
`--bar-one-row` at 96px.

**Closed by D35.** The horizontal page scroll at 320px and 800px wide, which predates this entry
and came from the top bar rather than the player, is fixed there (cb3c512).

**Closed by D34.** Two items that were open here were settled by the owner after trying cd5a242.
The empty space reserved under the now-line at narrow widths (393px of bar at 320px wide) is gone
with the now-line itself (482f7eb). The two-row controls on short windows, where the owner was
to choose between a pillarboxed video and accepting two rows, no longer happen: the slimmer bar
fits one row down to a 486px player, and every desktop size measured is one row (1605098).

**Still open.**

- `.preparing` in App.css still reserves a 16:9 box with no room for the bar, so the page grows
  by the bar's height when the player replaces it. It grows downward and does not shift what the
  viewer was looking at, but it is a jump.

---

## D33 — Reopening a video offers to resume; it never resumes on its own

**Decision** (91a9849, revised in c8ec242). When a video opens and a saved position exists for
it, the player asks "Resume at 12:34?" with two buttons, Resume and Start from the beginning. The
player never jumps to the saved place without being asked. The question first shipped as a strip
above the player, and now is a card centred on the video ("Revised: a card on the video",
below).

**Why.** D29 made switching videos safe for the analysis, but the place in the lecture was still
lost: reopening any video started at 0:00, so coming back to a 90-minute lecture meant scrubbing
to find where you were. That is a needle-in-a-timeline task, and it is hardest for a low-vision
viewer reading a tiny timestamp next to a thin scrubber.

**Why offered, not automatic.** Someone reopening a lecture may be continuing it, or starting
over to revise for an exam, and the app cannot tell which. Guessing wrong in the automatic
direction is the worse error. A sighted viewer sees the playhead mid-lecture and can drag it
back. A screen-reader user gets silence, or speech, at a timestamp nobody explained. Asking costs
one press.

**A strip, not a modal** (as first shipped; see the revision below). It reused the amber `.strip`
above the player. A modal would block the
video for a question that can be ignored, and would take focus the viewer did not offer. Pressing
play, seeking anywhere, or either button all count as an answer and remove the strip; the viewer
does not have to deal with it before doing what they came to do. Focus is not moved to it, but
Resume comes first in the tab order. Both buttons are at least 44px; Resume is filled
(`var(--accent)`) and Start is outlined, so the likelier answer is the more visible one. When
the buttons unmount, focus goes to the player's Play/Pause button. Left alone, it would fall to
`<body>`, and a keyboard user would have to tab back into the page from the top.

**Only once the video can play.** On a fresh analysis the strip waits for `canPlay`, which is
true once the analysis is done or has covered the first 10s (`PLAYBACK_LEAD`). An offer to jump
somewhere you cannot play yet is a dead button. Resuming far ahead on a fresh analysis seeks
into video that has not been analyzed yet, and D12's segment restart already handles that.

**Announced.** The strip renders inside a `role="status"` region that is always mounted. A live
region inserted together with its content is not announced, which is the same rule the player's
notices follow.

**Storage: localStorage, not the analysis cache.** Key `veasyguide.resume`, holding
`{ [videoKey]: { t, at } }`, with the newest 50 kept by last-saved time.
- Rejected: storing it in the IndexedDB analysis cache (D29). The entry is two numbers. It has to
  exist for videos whose analysis never finished and was never cached. And the most important
  write happens on `pagehide`, where an async IndexedDB transaction may never commit, while a
  `localStorage` write is synchronous.

**When it writes.** About every 5s of wall time while playback advances, and also on pause, on
`pagehide`, on `visibilitychange` to hidden, and before any switch or reset
(`leaveVideoForResume`). `pagehide`, not `beforeunload`, because `pagehide` fires on mobile and
when the page goes into the back/forward cache. `visibilitychange` too, because a backgrounded
mobile tab can be killed without ever getting `pagehide`.

**What it refuses to save.** Nothing is saved for a video until the viewer has played or seeked
in it. Otherwise opening a lecture to check something and closing the tab would save 0:00 over
the real place. Within 10s of the start (`RESUME_EDGE`) nothing is offered, and a save there
clears the entry: someone who rewound to rewatch the introduction is no longer at their old
place. Within 10s of the end the entry is cleared too, because there is nothing left to resume.

**Tests and measurements.** `player/resume.ts` is a pure module with 9 unit tests: round-trip,
both edges, newest wins, keep-50 eviction, eviction by last watched, tolerance of garbage in
storage, and a quota error on write. Measured in headless Chromium: after saving at 61.9s, the
reopened video offered "Resume at 01:01?". Resume took it to 62.2s, playing, with focus on
Pause. Opening and closing the video without touching it kept the old entry. Seeking to 3s
before the end and pausing cleared it.

Checked again independently, at 8883cbd. The `role="status"` slot is in the DOM 50-64ms after
load, and the strip is inserted into that existing node at 279-328ms, which is the order a live
region needs. The accessibility tree shows status, polite, atomic. Resume is 90x44px and "Start
from the beginning" 213x44px. Focus stays where it was (on `<body>` after a load), as intended.
After a seek to 124s and a reload, the stored entry held 124 and the strip read "Resume at
02:04?", and Enter on Resume landed at exactly 124.00s. The strip is 68px tall at 1366x768. A
real screen reader was not run, so "announced" rests on the tree, not on hearing it.

**Two defects found by the Codex review, fixed in the same round** (dda1bdb).
- Space on Resume played from 0:00. The player's document-level Space hotkey took the key, and
  pressing play counts as an answer, so the strip went away with the saved place unused: a
  keyboard user who activates buttons with Space got the opposite of what they chose. Enter
  worked. The strip now stops player hotkeys (D31 has the full list of what was guarded).
- Opening and closing Appearance erased the saved place. Paused at 0:00, between moments, the
  sheet's preview jump went through `onSeeked` like a viewer's seek: it dismissed the offer,
  marked the video as touched, and leaving afterwards saved 0:00 over the bookmark, turning
  `{t: 20}` into `{}`. The guard "nothing is saved until the viewer has played or seeked" was
  fooled because the player could not tell its own seeks from the viewer's. It now marks them
  (`byViewer = false`), and if the page goes away mid-preview, App saves the position from before
  the preview. Measured: `{t: 21.2}` survives opening and closing Appearance and leaving
  mid-preview, and a viewer at 15s who leaves mid-preview saves 15, not the preview's 25.8.
Re-measured independently with `{t: 20}` stored and the video reopened at 0:00: Appearance's
preview jumps to 25.77s with the strip still shown, closing it returns to 0 with the strip still
there, and the stored entry stays `{t: 20}`. Leaving mid-preview without touching anything keeps
`{t: 20}`. A viewer at 15s who leaves mid-preview saves 15; at 4s the entry is cleared, which is
the 10s start edge working as designed.

**Fixed after the third Codex review** (cba52ad). The preview fix above went one step too far.
Pressing ] from inside the Appearance sheet was undone when the sheet closed, and leaving then
saved the position from before the preview (`{t: 30}`) instead of the moment the viewer had
stepped to (52.8s). A seek by the viewer during a preview now cancels the preview's restore, and
the stored entry is `{t: 52.8}`. Re-measured independently: paused at 30s, the preview jumps to
47.8s, ] goes to 52.8s, and leaving stores `{t: 52.8}`.

**Fixed after the fourth Codex review** (f2f2374). cba52ad's cancel was in the wrong place.
- It ran on `seeked`, which is too late. A click on the scrubber is also a click outside the
  Appearance sheet, and closing the sheet restored the pre-preview time before `seeked` arrived,
  undoing the viewer's own seek. ] followed by Escape raced the same way. Paused at 30s with the
  preview at 47.8s, a scrubber click at 100s ended at 30s and stored `{t: 30}`, confirmed in the
  browser; a jump from a sidebar row happened to survive. Every viewer seek now goes through one
  `viewerSeek()`, which cancels the preview synchronously, before the seek. The `onSeeked` check
  stays as a backstop.
- The preview's target (moment start plus the lead plus 0.2s) was not clamped. For a moment in
  the last fraction of a second it pointed past the end, the browser clamped the seek, the
  landing time fell outside the 0.05s match that marks a seek as the player's own, and the
  player's own jump was taken for the viewer's, dismissing the resume offer. Found from the code,
  not reproduced. The target is now clamped inside the moment and the video.

Measured (code-lead's): during the preview, a scrubber click at 100s lands at 100.0s and stores
100.0; ] then Escape lands at 52.8s and stores 52.8; closing the sheet without seeking still
restores 30.0s. Re-measured independently, paused at 30s with the preview at 47.8s: a scrubber
click at the 100s point lands at 99.95s with the sheet closed and stores 99.946; ] then Escape
stores 52.8; closing the sheet by clicking Appearance again returns to 30.0s and stores 30; a
sidebar row stores 120.9. ArrowRight inside the sheet does not seek at all, because the sheet's
key guard takes the arrows; that is intended.

**An older scrubber bug, found on the way.** A click on the scrubber seeked to the pointer's
position as of the last render (`useMouse`'s state), not the click's own. A click without a
mouse movement just before it landed wherever the pointer had last been seen: measured, at 0:00.
It now reads the click's coordinates. This predates the round. Re-measured independently, with
no preview open: a real click at the 200s point lands at 199.89s, and a synthetic press and
release at the 60s point with no mouse movement first lands at 59.9s.

**Revised: a card on the video** (c8ec242, the owner's decision after watching the demo). The
strip pushed the whole player down when it appeared, which is the layout jump this round removed
everywhere else (D32). At 320x320 it wrapped to 154px and pushed the video's top to 237px, so the
picture started mostly below the fold. The offer is now a card centred on the video, inside
`.video-stage`, and the player's box is identical with and without it, measured at 1366x650 and
320x640. At 320px the card fits inside the 264px-wide picture.
- Rejected: the strip, because it moves the page.
- Rejected: a toast at page level. It would be detached from the player it is about, and
  invisible in fullscreen.
- Rejected: bottom left, above the bar. It would collide with the preview-jump pill and the
  pin's two bottom corners.

Centred keeps it clear of the notices at the top centre and of every pin corner. It is a
near-opaque dark card with an amber edge, so its contrast is the same on a white slide and a black
one. It sits above the pin (z 35) and the fullscreen moments list (z 40), and under the bar (z 50).
It now works in fullscreen too, which the strip did not. The cost is that it covers the middle of
the picture until the viewer answers, presses play or seeks.

What was promised above still holds: offered, never automatic; Resume first; no focus taken, with
the buttons in the tab order after the bar (on the strip they came before the player); the live
region mounted before the card arrives; Space and Enter press its buttons; play, a seek or either
button dismisses it. Clicks on the card stop there, so they cannot toggle playback underneath.
The buttons are now 36px tall, not 44px, so the card fits a 180px-tall picture at 320px wide.
That is above 2.5.8's 24px, and below the 44px the strip had.

**Re-measured independently** (stored position 20s).
- The player's box takes one value per session, sampled every frame from load, card or no
  card: 782.2x529.0 at 1366x650, 992x647 at 1366x768, 264x301.5 at 320x640.
- The card sits inside the picture at all three sizes: 339x100 and centred at 1366px wide. At
  320px it fits within the video's box, and its content scrolls by 11px inside the card; the page
  itself does not scroll either way.
- In fullscreen it shows inside the fullscreen element. Its slot is at z 45, between the
  fullscreen list (40) and the bar (50), and at 1366px the card and the list do not overlap.
- Contrast, with the computed colours composited over the slide. On white: text 15.25:1, the
  time 10.41:1, Resume 6.88:1, Start's label 15.25:1. On black: 17.52, 11.96, 6.88 and 17.52:1.
  Start's 1px border is 2.97:1 against the card on white (3.41:1 on black), just under 1.4.11's
  3:1. The button is identified by its label, not its border.
- Space or Enter on Resume both land at 20.5s, playing, with focus on Pause. On Start, both stay
  at 0, paused, with focus on Play. A click on the card's text leaves the video paused and the
  card up. Space with focus elsewhere on the page plays from 0 and dismisses; → seeks to 5s and
  dismisses; a click on the video plays and dismisses.
- The `role="status"` slot is mounted at about 850ms, and the card is inserted into it about
  3.3s later (4.15-4.28s).
- Buttons are 86x36 and 209x36px. Tab order: the header, the scrubber, Play, Volume, Speed,
  Magnify, Pin, Appearance, Fullscreen, then Resume, then Start.

**Two fixes from that re-measure** (27a0859).
- At 320px wide the picture is about 149px tall and the card was 11px taller than its room, so
  it scrolled inside itself with its second button half hidden. Below 30em the card now packs
  tighter: 32px buttons and less padding. Re-measured independently: at 320x640 the card is
  256x120.8 inside a 264x148.5 picture, at 375x700 it is 311x121 inside 319x179, and nothing
  scrolls inside it at either. The buttons there are 82x32 and 205x32px.
- Start's border is now `#8a95a6`: 5.54:1 against the card on a white slide and 6.37:1 on
  black, where it was 2.97:1.

**Fixed after the fifth Codex review** (37535ac).
- `viewerSeek()` cancelled the preview but left the player's own-seek marker set. Ownership is
  matched by landing time, so a viewer seek landing within 0.05s of the pending preview target,
  before its `seeked`, would be taken for the player's own: the resume offer stayed up and the
  bookmark went stale. `viewerSeek()` now clears the marker before it seeks.
- **The card was last in the tab order, which made it hard to reach by keyboard.** It came after
  the whole bar, and the moment lane gives every mark a tab stop, so a keyboard user on a long
  lecture tabbed through dozens of marks to reach Resume. This reverses c8ec242's "after the bar"
  above. The card's live region is now the player's first child, positioned over the picture's
  box (the container less the bar where the bar sits below it, the whole of it in fullscreen), so
  it draws exactly where it did. Re-measured independently on a lecture with 32 lane marks:
  Resume is tab stop 8 at 1366px wide, right after the header's links, and stop 2 at 320px, right
  after Menu, with Start next. The card's centre is the picture's centre within 0.1px, and the
  player's box still takes exactly one value per session at 1366x650, 1366x768 and 320x640. In
  fullscreen the slot covers the whole screen and the card is centred. The live region is mounted
  about 3.4s before the card. A click on the picture outside the card plays and dismisses it; the
  Space, Enter and click-on-card results are unchanged.

**Fixed after the sixth Codex review** (7fc8c45).
- In fullscreen the bar could cover the card. At 1280x720 at 400% zoom (a 320x180 screen) the
  expanded bar is 122px of the screen's 180, and it overlapped the card by 91.4px, so neither
  button could be clicked. In fullscreen the card now stacks above the bar (z 55). Rejected:
  reserving room above the bar, which left 53px, too little for the card. This was described as
  fullscreen-only, with "windowed, the card and the bar never meet". That was wrong on both
  counts: the slot is z 55 in every mode, and windowed the bar's popovers do meet the card
  (Still open).
- Leaving the page about 50ms after closing Appearance stored the preview's position (47.8s)
  instead of the viewer's (30s); at 0ms or 300ms it stored 30s. A save in the window before the
  restore landed read the preview's time. The preview jump now carries the playhead's
  destination, so a save in that window records 30s.

Re-measured independently. At 320x180 at DPR 4 in fullscreen with the bar expanded (bar from
y 59 to 181, card from y 29.6 to 150.4), the element at each button's centre is the button.
Leaving at 0, 50 and 300ms after closing Appearance stores `{t: 30}` every time. Geometry, zero
layout shift, every key, click and dismissal path, the tab order and the preview paths are
unchanged from 37535ac.

**Fixed after the seventh Codex review** (d3d32ca). 7fc8c45 put the card's slot at z 55 in
every mode, above the bar (50), and the bar's popovers live in the bar's layer. At 320x640
windowed the card covered the popovers that opened under it: 3 of the Appearance sheet's 6
controls, the volume range, and 4 of the 7 speed items. Nothing was covered at 1366px wide. The
card is back under the bar (z 45) and rises above it (z 55) only in fullscreen, and only while
none of the bar's popovers is open.

Re-measured independently. At 320x640 windowed with the card up, none of the 6 Appearance
controls, the 2 volume controls (range and Mute) or the 7 speed items is covered: the element at
each one's centre is the control itself, and the slot is z 45. The same at 1366x768 and 1366x650.
In fullscreen at 320x180 at DPR 4 with the bar expanded, both card buttons are hit with the slot
at z 55, and at 375x667 and 667x375 at DPR 2 the card does not meet the bar. In fullscreen with
the Appearance sheet, volume or speed open, the slot drops to z 45 and no popover control is
covered; after Escape it returns to z 55 with the card's buttons reachable.

**Still open.**
- In fullscreen the card (z 55) covers the moments list (z 40): 2 of 3 visible rows at 320x180
  at DPR 4, and 2 of 8 at 375x667 at DPR 2. Nothing is covered at 667x375 or 1366x768. Found by
  the eighth Codex review, reproduced; with code-lead.
- In fullscreen at 320x180 at DPR 4 with the bar expanded, Play, Previous and Next moment and
  Volume take keyboard focus while hidden under the card, which fails WCAG 2.4.11 (Focus Not
  Obscured). Found by the eighth Codex review, reproduced; with code-lead.



- The position lives in one browser's `localStorage`. A different browser, a private window or
  cleared site data starts at 0:00, with no offer.
- The key is `videoKey` (size, duration, frame size), the same as the cache. Two different files
  that match on all of these would share a position. The cache already accepts that collision.

---

## D34 — The bar is one slim row: no visible status line, 28px buttons

**Decision** (482f7eb, 1605098; the owner's call on both). The now-line, the status line in the
bar, is no longer shown. It said which moment is current, where on the slide it is (the worded
geometry from D19), its timecode and length, then "Magnifier on · 2.0×" when magnifying and
"Next at" the following moment. Its announcement stays, as a visually hidden `role="status"`. The
bar's buttons go from 44px to 28px, and volume moves from an always-visible slider into a
popover. The bar is now one row at every desktop size measured.

**The owner's words, after trying cd5a242:** "Remove this, I think it makes things bad." Earlier
he had said that low-vision viewers cannot read the line well anyway.

**Why the now-line went.**
- It cost a row. In the windowed player the bar's height comes off the picture (D32), so every
  row of bar is a strip of lecture the viewer does not get.
- It made the bar's height depend on how its sentence wrapped. That dependency fed D32's width
  cap loop, and cd5a242's worst-case sizers existed only to fight it, at the price of empty
  space on narrow windows.
- It repeated what is already on screen: the lit mark in the moment lane, the current row in the
  moments list, the timecode, and the magnifier button's amber state.

**This reverses a rule, and it should be read as reversed.** The removed code said the
magnifier's state was shown "as persistent TEXT, not just the transient on-video icon: a
low-vision user cannot be asked to notice a subtle glyph to know what mode their player is in."
After this change the visible signal is the amber Magnify button, and the text is spoken but
not shown. The owner's judgement is that the line was not readable for that same reader, so it
was not doing the job the rule asked of it.

**What is kept.** The same sentence, the magnifier state and "Next at" go into a visually hidden
`role="status"`, mounted from the first frame so it is announced (a live region inserted with
its content is not, D33). It is now announced in fullscreen with the bar collapsed too. Before,
the collapsed bar hid the line with `display: none`, which also silenced it for screen readers.
"No moments found" moves to the moments list's empty state, and the position readout stops
repeating it.

**Why 28px buttons, and what that gives up.** The owner set the sizes. Buttons go from 44px to
28px and icons from 22px to 20px. 28px meets WCAG 2.5.8 (Target Size, Minimum, AA, 24px). It
gives up 2.5.5 (Target Size, Enhanced, AAA, 44px), deliberately. The code comments say "28px by
the owner's call; 2.5.8 AA met", so a later reader does not mistake it for an oversight. The
people this hurts most are those with tremor or low motor precision, and those using a magnifier
at a high zoom, where a small target is also a small thing to find. What it buys is the one-row
bar, and the picture height that comes with it.
- The row gap goes from 3px to 4px. The focus ring reaches 5px out and the icon sits 4px inside
  its button, so 4px keeps one button's ring off its neighbour's icon.
- The pin caption and the bar's bottom padding are 6px, so `overflow: hidden` or the screen edge
  cannot clip a focus ring.
- The scrubber's hit zone and the moment marks' hit areas are unchanged.

**Volume becomes a popover.** The 84px slider was always visible, and it was made that way on
purpose, to avoid the usual hover-to-reveal slider. The popover opens on click, Enter or Space,
never on hover, so that reason still holds. It holds a vertical native range and Mute. M still
mutes, and the button has a "Volume" tip (D31).

**Speed is a fixed width and always shows its rate**, "1×" included, where D24 showed the rate
only when it was off-default.
- Rejected: auto width. A rate change would change the button's width, which could wrap the row
  and resize the player, the jump D32 spent the round removing.
- Rejected: hiding "1×" in a fixed-width button. The room would be reserved anyway and sit empty.

**Numbers** (code-lead's). One row of controls now fits down to a 486px player; before, it
needed about 672px. The one-row bar is 89px, and D32's width cap subtracts that constant (it was
140px, then 103px after the now-line went). At 1280x600 at DPR 1.5 the video went from 533px
wide (eaceeb5) to 599px (482f7eb) to 624px (1605098). Bar height at 1400, 560, 400 and 320px
wide: 89, 89, 121 and 153px, against 140, 222, 312 and 393px with the now-line's reserved space.

**Re-measured independently** (at cb3c512). Bar height held constant through analysis,
playback at 4x, the magnifier on and off and a speed step, with zero size changes in every
case: 89px at 1400 and 560px wide and at every desktop size, 121px at 400px wide and at both
zoom cases (683x384 at DPR 2, 341x192 at DPR 4), 153px at 320px. The narrowest player confirmed
as one row is 504px, at a 560px window; the exact 486px threshold was not searched for.
- The hidden status is `role="status"` (polite by role), 1x1px, with no hidden ancestor. At 4x
  it announced 5 updates in 9s windowed, and 4 in fullscreen with the bar collapsed. Those
  counts include the end-of-moment updates later removed (below).
- Every bar and pin button is 28x28px (speed 80x28), with no overlaps. No focus ring is clipped
  by an `overflow` ancestor or the viewport, at 1366px and 320px wide.
- Volume: hover does not open the popover; Enter and Space do. Focus lands on the range, which
  is vertical with up as louder (its top gives 1.0, its bottom 0).

**Fixed after the second Codex review** (3c3dfe5).
- The volume tip never showed on hover, and on focus it was drawn at (46, 65) for a button at
  (152, 678). It wrapped the `Popover` component, which renders no element of its own, so it had
  nothing to anchor to. It now wraps `Popover.Target`, the rule D31 recorded for `PlayerTip`
  and that this one missed.
- The vertical range had no fallback. Engines from before about 2024 (Chromium before 124)
  draw a `writing-mode` range horizontally. A one-time probe measures an unstyled vertical range,
  and if it is not taller than wide, the popover lays the slider out flat and
  `aria-orientation` says horizontal. Rejected: `CSS.supports`, because `writing-mode` is
  supported everywhere; only the form control's rendering differs.
- The hidden status spoke at each moment's start and again at its end, so at speed two updates
  landed about 100ms apart and a screen reader could cut the first off. It now speaks once, at
  each moment's start. The "Next at" moment is taken from the list, because the playhead sits a
  little before the start and would otherwise name the current moment as next. The magnifier
  state is its own text node. Measured: 6 updates for 6 moments over 77s at 4x.

Re-measured independently: the volume tip reads "Volume M" at (112, 632), above its button at
(152, 678), on hover and on keyboard focus alike. The status gives exactly 6 updates for 6 moment
starts over 77s at 4x, windowed and in fullscreen, none at moment ends; toggling the magnifier
adds or removes a suffix. With the probe forced to fail, the popover shows a 120x24 horizontal
range with `aria-orientation="horizontal"`. Clicking its right end gives 1.0 and its left end 0,
and the keys work.

**Fixed after the third Codex review** (cba52ad).
- Re-entering a moment was silent. Coming back into the same moment after a gap, paused or not,
  produced identical text, and identical text is no change for a live region. The status now
  speaks on entering a moment: it is keyed on the moment itself, so its text node remounts on
  each entry. A backfill that renumbers moments stays quiet.
- The magnifier has its own live region. `role="status"` is atomic, so the shared region
  re-read the whole moment sentence on every Z, and turning the magnifier off said nothing about
  it. It now says "Magnifier on, N times." or "Magnifier off.", and announces strength changes
  only while it is on.

Re-measured independently. Paused, seeking from 87s to 100s and back to 88s gave two moment
announcements, on entering and on re-entering, both "Moment 8 of 36…". Playing at 4x over 77s
gave exactly 6 updates for 6 moment starts, windowed and in fullscreen, at least 480ms apart. The
magnifier's region is a second `role="status"`: Z gave "Magnifier on, 1.5 times.", ↑ gave
"Magnifier on, 1.6 times.", and Z again "Magnifier off.", with no change at all to the moment
region throughout. Re-entry while playing, measured later: playing from 83s, "Moment 8" at
84.7s; ← to 83.5s gives
"Moment 7"; playing on re-enters 8 and announces it again. A backfill renumbering staying quiet
could not be exercised as intended (see the older bugs below). Strength changes while the
magnifier is off did not exist as a path: ↑ and ↓ both turned the
magnifier on, as on main. That turned out to be a bug, fixed below (5c4bffd).

**Two older bugs, found by these checks** (5c4bffd). Both are on main too.
- ↓ with the magnifier off turned it on: "zoom out" zoomed in. It now does nothing.
- A moment the analysis found under a paused playhead was never selected until the time moved:
  no status, no highlight. After a nudge it was announced ("Moment 35 of 37…"). The current
  moment is now re-selected when the list grows. This is also why "a backfill renumbering stays
  quiet" could not be measured before.

Re-measured independently. ↓ with the magnifier off leaves the strength at 0.5 and the magnifier
off; main turns it on. ↑ from off still turns it on (0.5 to 0.6 over two presses). Paused at
268s before the analysis reached it, the highlight and the current sidebar row appear once it
does, with the time still 268s and no nudge. A backfill renumbering stays quiet: the moment
region changed twice (cleared, then "Moment 1, bottom right, 04:28, 5.2 seconds.") and not again
through to the end, at 37 moments.

**The moment marks stay under 24px, on purpose.** The lane's marks are 8-23px wide by 14px tall,
under 2.5.8's 24px, which predates this round. They rely on 2.5.8's Equivalent exception: every
moment is also reachable by [ and ], by Previous and Next, and by the sidebar's rows.

**Still open.**
- Low, left by the stop rule: if a moment is first selected while the analysis is still running
  (for example, found under a paused playhead), the status region keeps its first sentence
  ("Moment 1, …") after a backfill renumbers it to 35 of 37. Re-announcing is suppressed on
  purpose, so it is not spoken again, but a screen-reader user reading it in browse mode finds a
  stale number.


- Below about 486px of player the bar still wraps (121px at 400px wide, 153px at 320px). D32
  measured the result: the page scrolls on narrow windows, as page content, not overflow.
- 2.5.5 AAA is given up, as above. If testing with motor-impaired or high-zoom users shows the
  28px targets are a problem, that is the decision to revisit.

---

## D35 — On narrow windows the top bar folds into one menu

**Decision** (cb3c512). Below a measured breakpoint the top bar keeps three things: the mark,
the analysis status as a bare number, and one Menu button. The menu holds the full file name as
a label that is not interactive, then Change video, Load moments file, Dark theme, About,
Project page and Code on GitHub. Above the breakpoint the desktop bar keeps its contents, and
the file-name chip now shrinks first, down to a 6rem floor. It is not pixel-identical to before,
though (below). The avatar is dropped from the narrow bar, since the footer has it. Below 32em
the tagline and the file-name chip go too; the `h1` stays, visually hidden, so headings
navigation still finds it.

**What was wrong.** It predates the round, and it was in TODOS.md. The bar's single row
overflowed below its natural width and pushed the whole page sideways. With a lecture open the
page was 860px wide in a 320px window; on the landing screen, 478px. On a phone the player's
left edge was cut off, as in the owner's screenshot, and so it was at 400% zoom, which is the
case WCAG 1.4.10 (Reflow) is about and the case this app is for. "Moments file" wrapped onto
two lines.

**Keeping what the bar said.** The status chip keeps its full sentence in the accessibility tree,
visually hidden, so a screen reader still hears "Finding moments… 84%" and not "84%". The wide
and narrow variants are switched with `display: none`, so neither is announced twice.

**The menu.** One 44px button opening Mantine's `Menu`, which brings the roles, arrow keys,
Escape and focus return. It calls `stopPlayerHotkeys`, because the player's hotkeys listen on
the whole document and would otherwise take keys meant for the menu (the same fix D31 applied
to buttons outside the player).

**Breakpoints are measured, and set in em** so they move with the reader's font size. With a
lecture open it is 62.5em (1000px at 16px): the full row needs 988px with the file name at its
floor. On the landing screen it is 42em (672px): the row needs 638px, plus about 30px that the
fallback font overshoots by before the web font loads.

**Rejected.**
- Hiding items one at a time at several breakpoints. More states to test, and a long file name
  would still overflow.
- Letting the bar wrap onto two lines. It makes the top bar taller, and since D32's cap now
  measures the top bar (`--chrome-top`), a taller bar is a smaller video.

**Numbers** (code-lead's). Page `scrollWidth` before and after: landing at 320, 375 and 414px
wide, 478, 457 and 478px became 320, 375 and 414; with a lecture at 320 to 800px wide, 860px
became the viewport width; 1280px at 400% zoom (320 CSS px), 860 became 320.

**Re-measured independently** (at cb3c512).
- `scrollWidth` equals the viewport at 320, 375, 414, 600, 800, 1000 and 1280px wide, on landing
  and with a lecture, and at 1280px at 400% zoom (320x180 at DPR 4).
- The Menu button is 44x44px. Enter opens it. The arrow keys go Change video, Load moments file,
  Dark theme, About, Project page, Code on GitHub, and wrap. Escape closes it and returns focus
  to Menu. Space on Dark theme toggles the theme without playing the video. Change video opens
  the picker.
- The chip's accessible text is the full "Finding moments… 1%"; the short form is `aria-hidden`.
- Breakpoints with the browser's font size set to 20px (em media queries follow the browser's
  default, not CSS): the Menu replaces the full bar between 1300 and 1240px (62.5em = 1250px),
  and the file-name chip goes between 650 and 630px (32em = 640px). At 16px: between 1010 and
  990px, and between 520 and 500px. All hold.

**Correction: the desktop bar did change.** The entry first said that above the breakpoint "the
desktop bar is unchanged". It is not: at 1366px wide, 6131 of the header's 61470 pixels differ.
The file-name chip is now a fixed pill about 240px wide, where it used to hug the file name, so
Change and Moments file sit about 150px further right.

That regression came from cb3c512 and was reverted to the old behaviour in 3c3dfe5: the chip
hugs the file name again.

**Fixed after the second Codex review** (3c3dfe5).
- About opened from the Menu lost focus to `<body>` on close. A modal dialog returns focus to
  whatever had it at `showModal()`, which was the menu item, unmounted by then. The item now
  focuses the Menu button before opening About.
- Opening the Menu and pressing F entered fullscreen and left the menu open but invisible,
  outside the fullscreen element. The compact menu now closes on `fullscreenchange`.

Re-measured independently: Menu, About, then Escape returns focus to Menu. Menu open, ↓, then F
enters fullscreen with no menu rendered. The header matches d2e19c3 exactly at desktop sizes:
0 of 61,470 pixels differ at 1366px wide and 0 of 86,400 at 1920px.

**Still open.**
- Low, left by the stop rule: the compact Menu stays open, with its focus trap, if the window is
  widened past 62.5em while it is open, and that hides its trigger (`Shell.tsx`). Found by the
  eighth Codex review from the code; not reproduced.
