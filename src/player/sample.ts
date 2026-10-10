// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// Where to draw the SAMPLE highlight: the stand-in the Appearance sheet tunes when no real
// moment is on screen (Yotam's default for "Preview while tuning"; the other choice jumps the
// playhead to a moment, which moves the viewer's place in the lecture to show a setting).
//
// A square, so a border width or a fill reads the same on all four sides, about a fifth of
// the picture's height. Placed where the open sheet does NOT cover it — a preview hidden behind
// the panel that is changing it previews nothing. The sheet hangs from the bar's right end, so
// the answer is usually the upper left; this tries a handful of spots inside the picture and
// takes the one least covered by anything in the way (the sheet; in fullscreen also the bar,
// which overlays the picture there), preferring the earlier spot on a tie. On a stage too small
// for any clear spot it still returns the least-covered one: visible, if partly covered, beats
// nowhere. Pure, so the choice is unit-tested (sample.test.ts).

export type Rect = { x: number; y: number; w: number; h: number };

// Kept clear of the picture's top edge by more than the side margin: the top centre is where the
// "Analyzing this part…" and scene-change notices appear.
const TOP = 48;
const MARGIN = 16;

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// `picture`: the video's visible frame (letterbox excluded), in the same coordinates as the
// obstacles. Returns the square's rect in those coordinates.
export function placeSample(picture: Rect, obstacles: Rect[], side: number): Rect {
  const s = Math.max(8, Math.min(side, picture.w - 2 * MARGIN, picture.h - 2 * MARGIN));
  const left = picture.x + MARGIN;
  const right = picture.x + picture.w - MARGIN - s;
  const centreX = picture.x + (picture.w - s) / 2;
  const top = picture.y + Math.min(TOP, Math.max(MARGIN, picture.h - MARGIN - s));
  const bottom = picture.y + picture.h - MARGIN - s;
  const middle = picture.y + (picture.h - s) / 2;
  // In order of preference: upper left first (where the sheet usually is not), then around.
  const spots: [number, number][] = [
    [left, top],
    [left, middle],
    [left, bottom],
    [right, top],
    [centreX, middle],
    [right, middle],
    [centreX, bottom],
    [right, bottom],
  ];
  let best: Rect | null = null;
  let bestCover = Infinity;
  for (const [x, y] of spots) {
    const r = { x, y: Math.max(picture.y, y), w: s, h: s };
    const cover = obstacles.reduce((sum, o) => sum + overlap(r, o), 0);
    if (cover < bestCover) {
      best = r;
      bestCover = cover;
    }
  }
  return best!;
}
