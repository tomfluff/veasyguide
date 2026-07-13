# TODOS

Deferred work, with enough context to pick it up cold. Newest first.

---

## Measure detector precision on a corpus of real lectures

**What:** Count valid/total activities across several real lectures and look at what the
false positives actually are.

**Why:** The player UI redesign turns the detector's output into a labeled, keyboard-navigable
index the user is invited to trust and jump to. Today a false positive is a box that flickers on
a video — deniable. Afterward it is "Moment 7 · 12:04" in a list. Building that UI raises the
precision the analyzer needs, and nobody has published that number on more than one clip. If a
third of the moments are webcam twitches or compression shimmer, the moments index ships the
analyzer's weakness as a product feature.

**Context:** `App.tsx` already tracks `validCount` / `activityCount` per run and shows the ratio
in the HUD — the instrumentation exists, the corpus doesn't. `?research=1` exports per-activity
region stats and features (`docs/research-data.md`), which is the natural way to look at what the
false positives have in common.

**Pros:** Tells you whether the headline feature is trustworthy before users rely on it.
**Cons:** Needs a corpus of real lectures that hasn't been assembled.
**Blocked by:** nothing. Deliberately deferred during the 2026-07-13 eng review.

---

## Player geometry landmine: the overlays are pinned to the container, not the video

**What:** `player.css:32-35` hard-codes `aspect-ratio: 16/9` on the `<video>`, and the three
overlay layers (`.video-highlights`, `.video-magnification`, `.video-overlay`) are all
`position:absolute; width:100%; height:100%` of `.video-container` rather than of the video's
actual box.

**Why it's a landmine:** The letterbox math in `VideoPlayer.tsx:147-161`
(`leftShift` / `topShift` / `scaleRatio`) works today **only because the container box and the
video element box happen to be the same rectangle** — the video is the only in-flow child. The
real invariant is "measure the box the video actually occupies," not "measure the container."
Any future layout change that decouples them (a docked panel *in flow*, a sidebar, a second
in-flow child) breaks that silently. The symptom is the highlight and the magnifier drifting off
the instructor's pen — worst for exactly the low-vision users this app exists for, and invisible
in any test that doesn't compare pixels.

**Why it's not fixed now:** The 2026-07-13 eng review chose to dock the new panel into
`.video-controls-container` (already `position:absolute; bottom:0`), which sidesteps the whole
problem and touches no geometry.

**The fix when someone needs it:** Measure the `<video>` element itself rather than the
container; replace `aspect-ratio: 16/9` with `height:100%; width:100%; object-fit:contain`;
re-parent the three overlay layers into the video's box. Then the math is invariant to layout.

**Blocked by:** nothing. Do it before any change that puts a second element in the player
container's flow.

---

## Deployment (Phase 4 of docs/design.md)

**What:** A git remote, a static host, and CI/CD. `npm run build` already produces a static
`dist/`.

**Why it blocks more than it looks like:** Two success criteria of the approved UI design are
**unverifiable without it**. "Someone who has never seen the app understands what it does within
five seconds of landing" — there is no landing to put in front of anyone. And the four
personalization presets are, in the design doc's own words, "reasoning, not evidence" and want a
real low-vision reader — who cannot see them. It is also how the Phase 0 low-end hardware
benchmark gets real devices instead of a hypothetical one.

**Context:** `docs/design.md` Phase 4 names it. This entry exists because the UI work made the
cost of *not* having it concrete.

**Blocked by:** nothing.
