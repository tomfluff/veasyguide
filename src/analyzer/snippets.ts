// Planning for activity snippets: which frames to grab, and from where.
// Pure functions — the worker does the decoding, this decides what to ask for.

import type { Activity, AnalysisMeta } from "./types";

export const SNIPPET_INTERVAL = 0.5; // seconds between frames within an activity
export const SNIPPET_MAX_FRAMES = 12; // incl. the "before" frame; long activities spread evenly
export const SNIPPET_PRE_ROLL = 0.3; // seconds before the first node: the clean baseline
export const SNIPPET_PAD = 0.15; // crop padding, fraction of the activity box
export const SNIPPET_MAX_WIDTH = 220; // output px
export const SNIPPET_MEM_BUDGET = 100 * 1024 * 1024; // stop generating past this

// The crop rectangle for an activity, in NATIVE video pixels. Fixed for the whole
// sequence — every frame uses the same window, so the frames are spatially registered
// and you can watch the stroke grow. (Cropping each frame to its own node's box would
// make the sequence jitter and be useless to both a human and a model.)
export type CropRect = { x: number; y: number; w: number; h: number };

export function cropRect(a: Activity, meta: AnalysisMeta): CropRect {
  const s = meta.scale;
  const padX = a.box.w * s * SNIPPET_PAD;
  const padY = a.box.h * s * SNIPPET_PAD;
  const x = Math.max(0, Math.floor(a.box.x * s - padX));
  const y = Math.max(0, Math.floor(a.box.y * s - padY));
  const w = Math.min(meta.videoWidth - x, Math.ceil(a.box.w * s + 2 * padX));
  const h = Math.min(meta.videoHeight - y, Math.ceil(a.box.h * s + 2 * padY));
  return { x, y, w, h };
}

// Timestamps to capture for one activity: a "before" frame (the baseline — what the
// region looked like with nothing there), then start → every SNIPPET_INTERVAL → end.
// Long activities are spread evenly rather than truncated, so the full arc survives.
export function snippetTimestamps(a: Activity, duration: number): number[] {
  const before = Math.max(0, a.start - SNIPPET_PRE_ROLL);
  const span = Math.max(0, a.end - a.start);

  // How many in-activity frames at the nominal interval?
  const nominal = Math.floor(span / SNIPPET_INTERVAL) + 1; // start + steps
  const budget = SNIPPET_MAX_FRAMES - 1; // one slot spent on the "before" frame

  let inner: number[];
  if (span <= 1e-6) {
    inner = [a.start];
  } else if (nominal <= budget) {
    inner = [];
    for (let t = a.start; t < a.end - 1e-6; t += SNIPPET_INTERVAL) inner.push(t);
    inner.push(a.end); // always end on the result
  } else {
    // Too long for the nominal interval: spread `budget` frames evenly, start..end.
    inner = Array.from({ length: budget }, (_, i) => a.start + (span * i) / (budget - 1));
  }

  const clamp = (t: number) => Math.max(0, Math.min(t, Math.max(0, duration - 0.05)));
  // Dedupe (a zero-length activity can collapse) and keep sorted.
  return [...new Set([before, ...inner].map(clamp))].sort((x, y) => x - y);
}
