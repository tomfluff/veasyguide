# Parked proposals — persona deliberation, July 2026

Five personas (low-vision learner, instructor, sighted learner, blind learner, content
creator) each used the app and proposed four features; a synthesis round converged on five
to build (see decisions.md). Nothing proposed was discarded: everything that did not make
the five is recorded here with the persona's original rationale and what it would cost, for
a human decision later.

## Excluded for architecture (violates a core promise)

### Paste-a-link ingestion / embeddable player — Lena (content creator, her #3)

**Her rationale, verbatim in spirit:** "It's a *file* app in a *streaming* world. My viewers
watch me on YouTube; to use this they must first download my video — awkward to say on
camera, ToS-gray, and a real barrier for exactly the low-vision folks who need it. An embed
also lets me *ship* the accessibility instead of recommending it."

**Why parked:** Fetching a remote URL breaks the app's literal, printed promises — offline-
first, no server contact, "the only network request is fetching the app itself" (decisions
D1), and YouTube ingestion was already explicitly rejected (decisions D2: ToS, brittle
extractors, and the privacy claim stops being checkable). An embeddable player is a
different distribution model with its own hosting, versioning, and origin-security surface.

**What it would cost architecturally:** a CORS-proxied fetch layer or a browser extension
(both are servers or server-adjacent), or an npm-published player component with the
analyzer split into a reusable package — a build/packaging project, not an app feature. The
honest redesign that FITS the promises is the moments **sidecar** (chosen feature F3): the
creator hosts a tiny JSON next to their video; the video still never moves.

## Excluded from the five for cost/risk — not for architecture

### Parked-pen detection (the hover-point) — Dr. Tanaka (instructor, his #4)

**His rationale:** "'Hover and talk' is the single most common pointing gesture in my
lectures — I rest the stylus on the reagent and explain for thirty seconds. Right now those
are precisely the moments my low-vision students lose." Evidence: a 33-second gap
(04:37–05:10 in rfl001Chris_1.mp4) where the cursor is visibly parked beside the grid under
discussion and nothing is detected.

**Why parked:** This is real and important — arguably the biggest detection gap the app has
— but it is analyzer research, not a buildable feature: a stationary cursor produces zero
pixel change, so detecting it means tracking "small blob arrived, then stopped" across
frames, which needs new state in the pipeline, tuning against false positives (any dust,
compression artifact, or static logo "arrives and stops"), and validation against multiple
real lectures. Doing it in the same batch as five UI features would ship an untested
heuristic into the app's core promise ("must never highlight the wrong thing").

**Cost estimate:** a per-region track table in the worker, a dwell heuristic with two new
parameters, selfcheck fixtures, and a measurement campaign like the webcam pre-pass got
(the webcam feature's commit message shows the bar: "justified by measurement, 171 of 602
valid moments were the webcam"). One focused week, not one afternoon.

### Instructor review mode (verify / prune / patch, then publish) — Dr. Tanaka (his #2)

**His rationale:** "This converts the tool from 'best-effort aid' to something I can stand
behind for accessibility compliance: I spot-check flagged gaps, delete the transition noise,
add the hover-points it missed, and publish."

**Why parked:** A full editing surface (delete/merge/rename UI, drag-a-box manual moment
authoring, an editable coverage timeline) is the largest single proposal made — a second
product mode. Its foundation, however, IS in the chosen five: the sidecar format (F3) is
the publish artifact his edits would live in, and auto-labels (F4) seed the titles he wants
to rename. When review mode is built later, it edits an already-shipped file format.

**Cost estimate:** editing state model + undo, moment CRUD UI, a manual-moment drawing
overlay, sidecar versioning for human edits. Multi-week.

### Moment earcons — spatially panned audio cues — Amara (blind learner, her #1)

**Her rationale:** "Speech announcements collide with the instructor's voice; a tone
doesn't. When she says 'this term cancels with THIS one' and I hear two ticks, left-low
then right-low, I know two locations were pointed at and roughly their relation. That's
spatial information through my working channel."

**Why parked:** Slot pressure, not architecture — it is fully client-side (WebAudio),
off-by-default, and genuinely novel. It lost the fifth slot to spatial descriptions (F4)
because descriptions serve her *and* the instructor's table-of-contents need *and* the
export formats, while earcons serve one scenario (live listening) and need real design
care: tone design that reads under lecture audio, mixing against arbitrary video loudness,
and a vestibular/audio-sensitivity review. It is the natural sixth feature, and F4's
region-to-words mapping is the geometry layer earcons would reuse for panning.

### Moment afterglow + "show me again" key — Marisol (low-vision learner, her #3)

**Her rationale:** "Between moments is when I get lost. He writes on the left board, then
talks for a minute pointing at nothing; my low-acuity survey of the slide can't re-find
small ink. An afterglow means the answer to 'wait, where was that?' is always on screen."

**Why parked:** Her #1 (pinned snapshot, chosen as F1) answers the same need more strongly
— it keeps the writing itself readable, not just its location — and shipping both in one
batch would put two new persistent overlays on the video at once, which deserves separate
evaluation against the "default never moves / nothing decorative" motion rules. Afterglow
is small (display-layer only) and a good candidate to add after F1 has real-user feedback.

### Sidebar thumbnail click-to-enlarge — Dev (sighted learner, part of his #4)

**His rationale:** "The sidebar thumbnail already showed the finished writing at
postage-stamp size — the exact artifact I wanted, just too small to read and not
clickable-to-zoom."

**Why parked:** The rows are `<button>`s, so a clickable thumbnail inside one is invalid
nested-interactive markup, and the stored thumbs are 220px wide — enlarged they would blur
exactly the ink the click was trying to read. The shipped pin panel (P / the bar's pin
button) covers the underlying need at full capture resolution for the playback flow; an
archive-quality per-moment enlarge wants higher-res snippet storage first (a memory-budget
decision), then a proper row layout with a secondary control.

### Multi-video pre-queue — Dev (sighted learner, part of his #3)

**His rationale:** "Exam night = 4 lectures × 90 min. Let me drop 3–4 files at once and
analyze them in the background while I watch the first."

**Why parked:** The painful half of his proposal (re-analysis on every reopen) is solved by
F3's cache; the queue is a concurrency and memory-budget project (multiple decoder
pipelines or a serialized queue, per-video progress UI, object-URL lifetime management)
whose value shrinks a lot once cached results persist. Revisit if cached-analysis telemetry
still shows long first-run waits dominating.
