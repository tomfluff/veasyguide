// thumbRect feeds the sidebar thumbnails: every crop must stay inside the frame (the
// snippet worker draws exactly this rect), contain the activity, and never be a sliver.
import { describe, it, expect } from "vitest";
import { thumbRect, THUMB_MIN_WFRAC } from "./snippets";
import type { Activity, AnalysisMeta } from "./types";

const meta = { videoWidth: 1280, videoHeight: 720, scale: 1 } as AnalysisMeta;
const act = (x: number, y: number, w: number, h: number) =>
  ({ box: { x, y, w, h } }) as unknown as Activity;

const inside = (r: { x: number; y: number; w: number; h: number }) =>
  r.x >= 0 && r.y >= 0 && r.x + r.w <= 1280 && r.y + r.h <= 720;

describe("thumbRect", () => {
  it("blows a tiny mark up to the minimum window, still inside the frame", () => {
    const r = thumbRect(act(600, 300, 20, 12), meta);
    expect(r.w).toBeGreaterThanOrEqual(THUMB_MIN_WFRAC * 1280);
    expect(inside(r)).toBe(true);
    // the mark itself is inside the crop
    expect(r.x).toBeLessThanOrEqual(600);
    expect(r.x + r.w).toBeGreaterThanOrEqual(620);
  });

  it("shifts (not shrinks) a corner activity into frame", () => {
    const r = thumbRect(act(1250, 5, 24, 24), meta);
    expect(inside(r)).toBe(true);
    expect(r.w).toBeGreaterThanOrEqual(THUMB_MIN_WFRAC * 1280);
  });

  it("caps a frame-sized activity at the frame", () => {
    const r = thumbRect(act(0, 0, 1280, 720), meta);
    expect(inside(r)).toBe(true);
    expect(r.w).toBeLessThanOrEqual(1280);
    expect(r.h).toBeLessThanOrEqual(720);
  });
});
