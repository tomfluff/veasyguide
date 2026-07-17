// Wording the geometry: turn an Activity's box + motion features into plain words.
//
// The analyzer computes everything needed to say "Writing · top right" — box, growth,
// consecutive-IoU — and until now spent all of it on paint. Wording it serves the whole
// audience at once: screen-reader users get a mental map instead of bare timestamps, the
// sidebar becomes a table of contents you can read, and the Markdown export carries it.
//
// The verb thresholds are calibrated against measured feature dumps (Chem30secExmaple,
// rfl001Chris_1): sustained writing runs growth 2.4–51 (union box far outgrows the mean
// node box — "marking grows"), while stationary blips sit at exactly growth 1 with
// consecutive IoU ≈ 1 ("pointing = same spot"). Drifting change that never accumulates
// (cursor sweeps, animations) is called Motion rather than guessed at.

import type { Activity } from "../analyzer/types";

// Growth is unionArea/meanNodeArea: >= 2 means the changed region kept extending — ink.
const WRITING_GROWTH = 2;
// Same-spot threshold for pointing; measured writing runs 0.13–0.56, blips 1.0.
const POINTING_IOU = 0.7;

export function momentVerb(a: Activity): "Writing" | "Pointing" | "Motion" {
  const f = a.features;
  if (f.growth >= WRITING_GROWTH) return "Writing";
  // One or two nodes carry no trajectory; a brief flash at one spot reads as pointing.
  if (f.meanConsecIoU >= POINTING_IOU || a.nodeCount <= 2) return "Pointing";
  return "Motion";
}

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

// The short visible form: "Writing · top right".
export function momentLabel(a: Activity, frameW: number, frameH: number): string {
  return `${momentVerb(a)} · ${momentPlace(a, frameW, frameH)}`;
}

// The spoken/exported form: "Writing, top right, medium size".
export function momentDescription(a: Activity, frameW: number, frameH: number): string {
  return `${momentVerb(a)}, ${momentPlace(a, frameW, frameH)}, ${momentSize(a, frameW, frameH)} size`;
}
