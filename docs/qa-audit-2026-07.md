# QA audit — July 2026 (branch `qa/multi-agent-audit`)

Three parallel auditors (bugs, usability/a11y, design-vs-DESIGN.md) ran against the live
app, twice: a first round accidentally audited the pre-design `main` tree; a second round
audited the real product at `a1fde56` (`ui/moment-navigation`), which this branch builds on.
Every finding below was independently reproduced in the running app before any fix, and every
fix was verified in the running app after. One commit per fix; see `git log` for the
commit-level evidence.

## Fixed on this branch

| Finding | Severity | Fix commit |
|---|---|---|
| Seek during analysis fabricated scenes, collided activity ids, unsorted list → 84 phantom sidebar rows for 39 moments, 28k React key errors, false scene notices | critical | "Seek during analysis no longer fabricates scenes…" (+ D16 in decisions.md) |
| Global hotkeys hijacked focused bar controls (Space on Mute played the video; arrows on the volume slider also seeked) | high | "Keys pressed on a focused bar control…" |
| Control bar faded out under keyboard focus and stayed clickable while invisible | high | "The control bar no longer hides under keyboard focus…" |
| Timeline scrubber was a mouse-only div (no role/tabindex/value/keys) with a 16px hit strip | high (structural) | "Make the timeline scrubber a real slider…" |
| Mute/Fullscreen exposed no state; volume slider unnamed, raw 0–1 values | medium | "Expose control state to AT…" |
| Preview-jump notice rendered behind the control bar (illegible at every zoom) | medium | "Anchor the preview-jump notice…" |
| Transient notices mounted with their content (never announced); Play silently ate presses while gated | medium | "Announce transient player notices…" |
| Webcam veto leaked at the inset's lower-left rim (zone ~6px short; highlights on the presenter's chest) | medium (core promise) | "Pad the webcam zone…" (verified on the full 59-min entropy run) |
| Debug params 0/NaN locked playback forever | minor | "Floor analysisWidth and sampleInterval…" |
| No way to load a second video without F5; stale "open clusters"; dark-theme debug table white-on-white | minor | "Top bar gets Change video…" |
| Design-contract misses: missing tabular-nums, 11px tile names, UA-blue avatar link, 1.76:1 track boundary, 1.4:1 analyzed-range distinction, 14px mark hit area, px font in debug | minor | "Design-contract conformance batch…" |
| Hex-named color swatches; fullscreen moments overlay ignored Escape and didn't take focus; unnamed aside, no h2; magnifier motion not reduced-motion-gated | minor | "A11y interactions…" |
| DESIGN.md described a design the code had deliberately outgrown (slate marks, player color tier, pulse exemption, footer scale) | doc | "DESIGN.md catches up…" |

## Reported but NOT fixed — with reasons

- **About dialog "non-modal, Escape dead, focus not returned"** (two auditors, contradicting
  each other) — **not reproducible.** Verified live: `showModal()` in use, `:modal` matches,
  focus lands on Close, Escape closes, focus returns to the About button.
- **CPU/GPU pipelines disagree on activity counts** (25 vs 23 on the 30s chem clip; both
  deterministic) — **real, deferred.** Needs a dedicated parity investigation (grayscale
  rounding, dilation edge behavior); no user-visible defect beyond count drift, and the CPU
  path remains the documented reference. Known issue.
- **GPU path ~2× slower than CPU in the audit environment** — headless Chromium likely runs
  SwiftShader; on real GPUs the GPU path is expected to win. A slow-GL fallback heuristic is
  a feature proposal, not a bug fix. Not actioned.
- **Volume slider thumb 16px (44px target)** — thumb named and re-domained (fix above), size
  left: a slider thumb is a precision control inside a hand-tuned 44px bar row, the adjacent
  Mute button is 44px, and a full keyboard path exists. Residual, accepted.
- **List/By-scene toggles, scene headers ~32px tall; footer links small** — sanctioned by
  DESIGN.md's targets section (panel/chrome controls may be compact; rem-based so browser
  zoom grows them; keyboard path exists).
- **Off-scale radii census (2/3/4/32px)** — cosmetic, small chrome, no legibility impact.
  Not actioned.
- **Round-1 findings against `main`** — superseded: the audit was re-run against the real
  product tree; main-only findings (missing font/tokens/themes/etc.) are simply the
  unmerged `ui/moment-navigation` work and were not re-fixed here.
