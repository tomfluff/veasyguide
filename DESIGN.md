# DESIGN.md

The design system for veasyguide-app. Every number here is checkable — for a tool built
for low-vision users, contrast and target size are correctness properties, not taste.

## The one rule

**This app is used by people who cannot see it well.** Every decision defers to that.
When legibility and elegance disagree, legibility wins and we don't discuss it.

---

## Color

Brand purple. Light and dark themes are both first-class — a low-vision user may need
either, and many need light-on-dark specifically.

```
--brand-100  #F3E3FD   lightest tint     (dark-theme text on brand, hover wash)
--brand-300  #D27CF7   the brand          (dark-theme accent, fills, active states)
--brand-500  #A94AE0   mid                (borders, focus rings on light)
--brand-700  #7B2CBF   deep               (light-theme accent — passes 4.5:1 on white)
--brand-900  #4C1D95   deepest            (light-theme text on brand tints)
```

**`--brand-300` (#D27CF7) fails contrast on white** (~2.1:1). It is a dark-theme color.
Light theme uses `--brand-700` (#7B2CBF, ~6.4:1 on white) for anything carrying meaning.
Never use a brand color as the sole carrier of information — pair it with text or shape.

### Neutrals

```
             DARK THEME           LIGHT THEME
--bg         #0D0F13              #FFFFFF
--surface    #171B22              #F5F6F8
--surface-2  #21262F              #EAECF0
--line       #333A45              #D3D8E0
--text       #F2F4F7              #14181F
--muted      #A7B0BD (7.0:1)      #55606E (5.9:1)
```

Every `--muted` pairing above meets 4.5:1 against its `--bg`. If you change one, re-check it.

### Semantic — NOT brand

The highlight and magnifier overlay colors are **user settings**, not brand tokens. They
default to the study's values (amber fill `#ffcc00`, red border `#ff0000`) and the user can
change them. They must never be swapped for the brand purple: the brand is chrome, the
overlay is content the user tuned for their own vision.

```
--activity   #FF5A4D   moment ACCENTS: the sidebar's Now row, moment cards
--ok         #7EE3A4   privacy promise, success
--warn       #FFB020   partial failure
--danger     #FF6B6B   fatal error
```

The timeline lane's moment marks are **slate `#7e8b9e`, not `--activity`**, and only the
*current* mark is coloured (amber `#ffc233`). Red is the colour of a problem, and a lecture
with 141 moments rendered as 141 red alarms — while the moments are the single best thing
the analyzer produces. The lane is a map; only the current mark is an answer. (This
originally shipped as a deviation from the table above; it is the contract now.)

### The always-dark player

The player and its control bar are dark in both themes and keep their own neutral tier
(`#0f1319`, `#151921`, `#21262f`-family greys, declared in player.css) alongside the shared
`--d-*` tokens. That tier is sanctioned: the player is a distinct dark surface, not page
chrome, and forcing its ~10 tuned greys into the six-token page palette would flatten real
distinctions (bar vs. track vs. analyzed-range vs. lane). The rule that carries over
unchanged: every text pairing ≥4.5:1, every component boundary ≥3:1 — measured, not assumed.

## Typography

**Atkinson Hyperlegible.** Designed by the Braille Institute specifically for low-vision
readers: unambiguous letterforms, high character differentiation (the 1/l/I and 0/O
problem). Self-hosted — the app is offline-first and never calls a CDN. This is a
functional choice, not a style one, and it is the most on-brand decision available to us.

Never `system-ui`. Never a default stack.

**Browser zoom is the magnification path.** A low-vision user scales the whole page with
their browser (Ctrl+/−, or a persistent zoom level), so every font size is in **rem** — zoom
scales rem cleanly, while px sizes fight it. No `font-size` in px, anywhere. The default is
1rem (the browser's 16px unless the user changed it — and if they changed it, that's them
telling us what they need, so we inherit it rather than overriding).

Because zoom does the magnifying, the UI itself can stay compact: secondary text and dense
panels below 1rem are fine, as long as they are rem-based and scale with the page.

```
--font: "Atkinson Hyperlegible", sans-serif;

Body / controls   1rem / 1.5        the default; inherits the browser's base size
Secondary / meta  0.875–0.9375rem   chips, nav, timestamps
Dense panels      down to 0.75rem   the Appearance sheet, the footer byline; scales with zoom
Section titles    1.25rem / 650
Page headline     1.6875rem / 700
Numerals          font-variant-numeric: tabular-nums  (timecodes must not jitter)
```

## Space, radius, targets

```
--r-sm 6px   --r-md 8px   --r-lg 12px   --r-pill 999px
Spacing: 4 / 8 / 12 / 16 / 24 / 32 / 40
```

**Targets: 44×44px for the primary player controls** (play/pause, seek, volume, fullscreen,
Prev/Next — the things used constantly, often while looking at the video rather than the
button). Panel and chrome controls (sidebar switches, scene headers, dialog buttons, the
Appearance sheet) may be compact: they are rem-sized, so browser zoom — the magnification
path — grows them together with everything else, and a keyboard/screen-reader path exists
for each.

One named exception stays: the timeline's moment markers are time-positioned, so their width
encodes duration and cannot be 44px without lying about the timeline. **Every marker is
reachable by an equivalent full-size control** — the `[` / `]` keys, the Prev/Next buttons,
and the moments sidebar. That is WCAG 2.5.8's *Equivalent* exception, used honestly.

## Layout

The page is an **ordinary scrolling document**. The moments sidebar gets a `max-height` and its
own internal scroll; the page scrolls normally around it.

Not a `100vh` overflow-hidden shell — that would make the `?debug=1` / `?research=1` panels
(params, analyzer canvas, activity gallery) physically unreachable, since they are a tall stack
below the player.

## Icons

**`@tabler/icons-react`** — already a dependency. Prefer an icon to a word wherever the icon
is unambiguous: expand/collapse are chevrons, not the words "Expand"/"Collapse". Every
icon-only control carries an `aria-label`. Never an icon alone for something a user must
understand cold (Moments keeps its word; the chevron does not need one).

## Motion

**The default never moves.** No preset enables an animation. Motion helps some low-vision
users localize and actively harms users with vestibular disorders or photosensitivity, so it
is opt-in, and every animation honors `prefers-reduced-motion` by falling back to a static
stronger state rather than silently dropping the cue.

One documented exception: the highlight **pulse** ignores `prefers-reduced-motion`, because
it is only ever running when the user explicitly turned it on in the Appearance sheet — an
explicit per-feature choice outranks the OS-wide default it contradicts. Everything that
moves *without* being asked (control bar, scene notice, sidebar follow-scroll, the
magnifier's pan/zoom) honors the setting.

Transitions are functional only: 150ms ease-out on the control bar's show/hide, 200ms on
sidebar open. Nothing decorative.

## Banned

- `system-ui` / default font stacks as the primary face.
- Three-column feature grids. (The landing had one. It was cut.)
- Icons in colored circles, decorative blobs, wavy dividers, gradient backgrounds.
- `font-size` in px — everything is rem, or browser zoom breaks. Body text under 1rem,
  or any text under 4.5:1 contrast.
- Placeholder-as-label in a form field.
- Hover as the only way to discover or reach anything.
- Auto-hiding UI that does not also reveal on keyboard focus, on pause, and on keypress.
