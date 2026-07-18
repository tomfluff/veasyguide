// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// Zoom transform for the magnification overlay. Extracted so the edge behaviour is
// testable: the whole point is that the pan is CONTINUOUS as an activity approaches a
// frame edge (it saturates instead of stepping). See selfcheck.

export type ZoomBox = { x: number; y: number; width: number; height: number };

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * With transform-origin pinned at `0 0`, a source point p renders at `f*p + t`.
 * Put the activity's centre in the middle of the frame, then clamp the translation so
 * the scaled image always covers the frame (never pan past an edge).
 */
export function zoomTransform(
  box: ZoomBox,
  frame: { width: number; height: number },
  factor: number
): { tx: number; ty: number } {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return {
    tx: clamp(frame.width / 2 - factor * cx, frame.width * (1 - factor), 0),
    ty: clamp(frame.height / 2 - factor * cy, frame.height * (1 - factor), 0),
  };
}

/** How far to zoom for an activity: enough to fill the frame, capped. */
export function zoomFactor(
  box: ZoomBox,
  frame: { width: number; height: number },
  strength: number,
  cap = 3
): number {
  return (
    1 +
    strength *
      Math.min(frame.width / box.width - 1, frame.height / box.height - 1, cap)
  );
}
