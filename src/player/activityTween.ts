// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// Moving the highlight smoothly while an enhance filter is on.
//
// Without a filter the wrapper's left/top/width/height are CSS-transitioned: cheap, on the
// compositor, and nothing else has to agree with them. With a filter on, the box carries a
// canvas holding a COPY of the video from underneath it, and that copy is only correct at one
// position. Tween the box with CSS and the canvas slides across the frame showing pixels
// borrowed from where the box used to be — the writing under the highlight visibly doubles.
//
// The old answer was to not move at all: with filters on the highlight jumped straight to the
// next moment. That trades a smear for a flinch, and a low-vision viewer tracking the mark
// across a slide is exactly who loses the thread when it teleports.
//
// The answer here is to tween the ACTIVITY RECTANGLE instead of the CSS. Every frame,
// HighlightIndicator derives the wrapper's geometry, the box's size, the canvas's size AND
// the canvas's source crop from one rectangle — so interpolating that rectangle keeps all
// four in agreement by construction. There is no position at which the copy is wrong,
// because the copy is re-cut from the video every frame at wherever the box has got to.
//
// It costs a re-render per frame for the length of the move, which is why it is only used
// when a filter is actually on. The CSS transition stays the path for everyone else.

import type { PlayerActivity } from "./types";

/**
 * CSS `ease-in-out`, which is `cubic-bezier(0.42, 0, 0.58, 1)`.
 *
 * Solved rather than approximated with a quad or a cubic, because the two paths through this
 * component — CSS transition without a filter, this tween with one — should not move the
 * highlight along visibly different curves depending on a setting about ink.
 */
export function easeInOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const x1 = 0.42;
  const x2 = 0.58;
  // x(s) and y(s) for the bezier with p0=(0,0), p3=(1,1); y1 = 0 and y2 = 1.
  const bx = (s: number) =>
    3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
  const dbx = (s: number) =>
    3 * (1 - s) * (1 - s) * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (1 - x2);
  // Newton from s = t; the curve is monotonic and well-behaved, so this converges in a few
  // steps. The bisection fallback is for the flat spots where the derivative nearly vanishes.
  let s = t;
  for (let i = 0; i < 8; i++) {
    const err = bx(s) - t;
    if (Math.abs(err) < 1e-6) break;
    const d = dbx(s);
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
  }
  if (s < 0 || s > 1 || Math.abs(bx(s) - t) > 1e-4) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      s = (lo + hi) / 2;
      if (bx(s) < t) lo = s;
      else hi = s;
    }
  }
  return 3 * (1 - s) * s * s + s * s * s; // y(s), with y1 = 0 and y2 = 1
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * A rectangle partway from one moment to the next, in the same native video pixels both are
 * expressed in. Carries `to`'s identity: it IS the new moment, in transit.
 */
export function tweenActivity(
  from: PlayerActivity,
  to: PlayerActivity,
  progress: number
): PlayerActivity {
  const t = easeInOut(Math.min(1, Math.max(0, progress)));
  return {
    ...to,
    pos: { x: mix(from.pos.x, to.pos.x, t), y: mix(from.pos.y, to.pos.y, t) },
    dim: {
      width: mix(from.dim.width, to.dim.width, t),
      height: mix(from.dim.height, to.dim.height, t),
    },
  };
}
