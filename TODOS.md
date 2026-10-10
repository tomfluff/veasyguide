# TODOS

Deferred work, with enough context to pick it up cold. Newest first.

---

## Horizontal page scroll on narrow windows, from the top nav

**What:** At 320px and at 800px wide, the page scrolls horizontally. The overflow comes from the
top nav, not the player. Measured in a 320px viewport: the analysis chip ends at x=551, the nav
at x=797, and the page's `scrollWidth` is 859. Identical on main@d2e19c3. A second, independent run
measured a `scrollWidth` of 916. The two runs were not compared, so what makes the difference is
not known.

**Why:** WCAG 1.4.10 (Reflow) asks for no two-dimensional scrolling at 320 CSS px, the width a
1280px window has at 400% zoom. That zoom is this app's audience. A viewer who has zoomed in
has to scroll sideways to reach the top bar's controls, Change and Load moments file among them.

**Context:** Found while measuring D32 (9e5fdbf). It predates the feedback round. The player
itself reflows: D32 made the in-flow bar the default, which used to be a `max-width: 520px`
media query, and the player width has a 20rem floor below which the page scrolls vertically.

**Pros:** Closes the last known reflow failure on the player screen.
**Cons:** The top bar is crowded (file name, status chip, Change, Load moments file, About); it
needs a wrapping or overflow-menu decision, not just CSS.
**Blocked by:** nothing.

---

## Keyboard reach for every player control

**What:** Give every control in the player bar the treatment D31 gave the moments list,
Appearance and the snapshot's size and corner buttons: a visible tooltip with its name and
key, shown on hover and on keyboard focus, and a key where it has none. That covers
play/pause, mute, speed, magnify, pin, previous/next moment, fullscreen and collapse. Replace
the remaining native `title` tooltips with the same component: Previous moment, Next moment,
Playback speed, the Magnify and Pin toggles, the sidebar's Export, and both footer switches.
Fullscreen, Mute and Collapse/Expand have only an `aria-label`, so they have no visible name at
all. Add a `?` key that opens a panel listing every shortcut. Consider scoping the letter keys
to the player instead of the document, as an alternative or complement to the "Single-key
shortcuts" switch.

**Why:** The feedback round fixed the four controls a user named, but the same gap is on every
other icon in the bar. A native `title` appears only on hover, after a delay, and never on
focus, so a keyboard user tabbing through the bar sees no name and no key, which is exactly the
failure D31 fixed. The full key list is in About, a dialog away from the player; nothing in the
player itself teaches a key except hovering, which is the one thing the keyboard and magnifier
users this app is for do not do.

**Context:** D31 records the tooltip pattern (portalled into the player container so it shows
in fullscreen) and the WCAG 2.1.4 switch. The hotkeys are registered with Mantine's
`useHotkeys`, which listens on the document, so a letter key fires wherever focus is — that is
what WCAG 2.1.4 is about. Scoping them to "focus is inside the player" would satisfy 2.1.4's
third option (active only when the component has focus) without a setting, but it changes
behaviour for everyone: a key pressed after clicking the sidebar would stop working. The
container's `onKeyDown` and `NO_REVEAL_KEYS` already have to agree with the hotkey table; a
shortcut panel should read from the same table rather than restate it.

**Pros:** One consistent way to learn every control. The `?` panel is the conventional place
for this (YouTube, GitHub, Gmail), so viewers look for it. Scoping could retire the switch.
**Cons:** A tooltip on every bar control is more motion near the video on each Tab press; the
delay needs tuning so tabbing through quickly does not flash a trail of tips. Scoping keys to
the player is a behaviour change that needs its own decision entry. Keys are running out: F, M,
Z, P, A, L, C, S, [, ] and < > are taken.
**Blocked by:** nothing. `PlayerTip` and its portal target (`player/tipRoot.ts`) landed with
D31 (aac5b37) and are ready to reuse.

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
