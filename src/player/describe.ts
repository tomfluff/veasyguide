// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// Wording the geometry: turn an Activity's box into plain words.
//
// The analyzer computes where change happened, and until now spent all of it on paint.
// Wording it serves the whole audience at once: screen-reader users get a mental map
// instead of bare timestamps, the sidebar becomes a table of contents you can read, and
// the Markdown export carries it.
//
// We describe WHERE and HOW BIG, not WHAT. A verb tier (Writing/Pointing/Motion) inferred
// from growth and consecutive-IoU was tried and removed: it was wrong often enough that a
// confident wrong word costs more than no word — a learner who cannot see the frame has no
// way to catch the error. Box geometry is measured, not guessed, so it stays. Naming the
// act needs the analyzer research parked in proposals-parked.md, not a threshold.
//
// Duration is not composed in here: every call site already prints it from a.start/a.end.

import type { Activity } from "../analyzer/types";

// 3×3 grid by box center, with spans called out: a box wider than 2/3 of the frame is not
// "center", it is "across" — the center of a full-width sweep is a lie about its extent.
export function momentPlace(a: Activity, frameW: number, frameH: number): string {
  const wide = a.box.w >= frameW * (2 / 3);
  const tall = a.box.h >= frameH * (2 / 3);
  if (wide && tall) return "most of the slide";

  const cx = a.box.x + a.box.w / 2;
  const cy = a.box.y + a.box.h / 2;
  const col = cx < frameW / 3 ? "left" : cx < (2 * frameW) / 3 ? "center" : "right";
  const row = cy < frameH / 3 ? "top" : cy < (2 * frameH) / 3 ? "middle" : "bottom";

  if (wide) return `across the ${row === "middle" ? "middle" : row}`;
  if (tall) return `down the ${col === "center" ? "middle" : col}`;
  if (row === "middle" && col === "center") return "center";
  if (row === "middle") return col;
  return `${row} ${col}`;
}

// Size in thirds of intuition, not decimals: under 1% of the frame is a small mark, past
// 8% it dominates a slide region. Measured chem-clip writing bursts land 0.3%–5%.
export function momentSize(a: Activity, frameW: number, frameH: number): "small" | "medium" | "large" {
  const frac = (a.box.w * a.box.h) / (frameW * frameH);
  if (frac < 0.01) return "small";
  if (frac < 0.08) return "medium";
  return "large";
}

// The spoken/exported form: "top right, medium size".
export function momentDescription(a: Activity, frameW: number, frameH: number): string {
  return `${momentPlace(a, frameW, frameH)}, ${momentSize(a, frameW, frameH)} size`;
}
