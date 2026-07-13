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
--activity   #FF5A4D   moment markers in the timeline lane, moment cards
--ok         #7EE3A4   privacy promise, success
--warn       #FFB020   partial failure
--danger     #FF6B6B   fatal error
```

## Typography

**Atkinson Hyperlegible.** Designed by the Braille Institute specifically for low-vision
readers: unambiguous letterforms, high character differentiation (the 1/l/I and 0/O
problem). Self-hosted — the app is offline-first and never calls a CDN. This is a
functional choice, not a style one, and it is the most on-brand decision available to us.

Never `system-ui`. Never a default stack.

```
--font: "Atkinson Hyperlegible", sans-serif;

Body / controls   17px / 1.5      never below 16px, anywhere
Small print       15px            the floor; nothing smaller ships
Now-line          18px
Section titles    20px / 650
Page title        40px / 700 / -0.02em
Numerals          font-variant-numeric: tabular-nums  (timecodes must not jitter)
```

## Space, radius, targets

```
--r-sm 6px   --r-md 8px   --r-lg 12px   --r-pill 999px
Spacing: 4 / 8 / 12 / 16 / 24 / 32 / 40
```

**Targets: 44×44px minimum** (WCAG 2.5.5). One named exception: the timeline's moment
markers are time-positioned, so their width encodes duration and cannot be 44px without
lying about the timeline. They are 24px tall, and **every marker is reachable by an
equivalent full-size control** — the `[` / `]` keys, the Prev/Next buttons, and the moments
sidebar. That is WCAG 2.5.8's *Equivalent* exception, used honestly.

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

Transitions are functional only: 150ms ease-out on the control bar's show/hide, 200ms on
sidebar open. Nothing decorative.

## Banned

- `system-ui` / default font stacks as the primary face.
- Three-column feature grids. (The landing had one. It was cut.)
- Icons in colored circles, decorative blobs, wavy dividers, gradient backgrounds.
- Any body text under 16px, or any text under 4.5:1 contrast.
- Placeholder-as-label in a form field.
- Hover as the only way to discover or reach anything.
- Auto-hiding UI that does not also reveal on keyboard focus, on pause, and on keypress.
