// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// The highlight moves along one curve, whether CSS is driving it or we are. If these two
// paths diverge, turning on an enhance filter changes how the mark travels — and the whole
// reason this module exists is that it should not.
import { describe, it, expect } from "vitest";
import { easeInOut, tweenActivity } from "./activityTween";
import type { PlayerActivity } from "./types";

const A: PlayerActivity = {
  id: 1, start: 0, end: 9,
  pos: { x: 100, y: 200 }, dim: { width: 300, height: 120 },
};
const B: PlayerActivity = {
  id: 2, start: 9, end: 18,
  pos: { x: 700, y: 400 }, dim: { width: 500, height: 220 },
};

describe("easeInOut", () => {
  it("is pinned at both ends", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(-1)).toBe(0);
    expect(easeInOut(2)).toBe(1);
  });

  it("is symmetric about the midpoint, like the curve it is solving", () => {
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 6);
    for (const t of [0.1, 0.25, 0.4]) {
      expect(easeInOut(t) + easeInOut(1 - t)).toBeCloseTo(1, 5);
    }
  });

  it("matches cubic-bezier(0.42, 0, 0.58, 1) — the CSS the other path uses", () => {
    // Solved independently (bisection to 200 iterations) rather than recalled, so this is a
    // check on the implementation and not a copy of it.
    const expected: Array<[number, number]> = [
      [0.05, 0.004830],
      [0.1, 0.019722],
      [0.25, 0.129162],
      [0.5, 0.5],
      [0.75, 0.870838],
      [0.9, 0.980278],
      [0.95, 0.995170],
    ];
    for (const [t, y] of expected) expect(easeInOut(t)).toBeCloseTo(y, 5);
  });

  it("only ever moves forwards", () => {
    let last = -1;
    for (let i = 0; i <= 100; i++) {
      const y = easeInOut(i / 100);
      expect(y).toBeGreaterThanOrEqual(last);
      last = y;
    }
  });

  it("starts and ends slowly — that is what ease-in-out is for", () => {
    expect(easeInOut(0.05)).toBeLessThan(0.05);
    expect(easeInOut(0.95)).toBeGreaterThan(0.95);
  });
});

describe("tweenActivity", () => {
  it("is the moment it is heading for, not the one it left", () => {
    // The id is what the pulse rewind and the moment list key on: a rectangle in transit is
    // still the NEW moment, or the throb would restart every frame of the journey.
    const mid = tweenActivity(A, B, 0.5);
    expect(mid.id).toBe(B.id);
    expect(mid.start).toBe(B.start);
    expect(mid.end).toBe(B.end);
  });

  it("lands exactly on each end", () => {
    expect(tweenActivity(A, B, 0)).toMatchObject({ pos: A.pos, dim: A.dim });
    expect(tweenActivity(A, B, 1)).toMatchObject({ pos: B.pos, dim: B.dim });
  });

  it("carries the size across as well as the position", () => {
    // The box, the ink canvas and the crop are all derived from this rectangle, so a tween
    // that moved the highlight without resizing it would stretch the copy over the frame.
    const mid = tweenActivity(A, B, 0.5);
    expect(mid.pos.x).toBeCloseTo(400);
    expect(mid.pos.y).toBeCloseTo(300);
    expect(mid.dim.width).toBeCloseTo(400);
    expect(mid.dim.height).toBeCloseTo(170);
  });

  it("clamps rather than overshooting", () => {
    expect(tweenActivity(A, B, 1.5)).toMatchObject({ pos: B.pos, dim: B.dim });
    expect(tweenActivity(A, B, -0.5)).toMatchObject({ pos: A.pos, dim: A.dim });
  });

  it("never leaves the rectangle between the two", () => {
    for (let i = 0; i <= 20; i++) {
      const m = tweenActivity(A, B, i / 20);
      expect(m.pos.x).toBeGreaterThanOrEqual(A.pos.x);
      expect(m.pos.x).toBeLessThanOrEqual(B.pos.x);
      expect(m.dim.width).toBeGreaterThanOrEqual(A.dim.width);
      expect(m.dim.width).toBeLessThanOrEqual(B.dim.width);
    }
  });

  it("shrinks as readily as it grows", () => {
    const m = tweenActivity(B, A, 0.5);
    expect(m.dim.width).toBeCloseTo(400);
    expect(m.id).toBe(A.id);
  });
});
