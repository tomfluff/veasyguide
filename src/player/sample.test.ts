// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { placeSample, type Rect } from "./sample";

const pic: Rect = { x: 0, y: 0, w: 960, h: 540 };
const hit = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("placing the sample highlight", () => {
  it("is square", () => {
    const r = placeSample(pic, [], 108);
    expect(r.w).toBe(r.h);
    expect(r.w).toBe(108);
  });

  it("goes upper left when nothing is in the way", () => {
    const r = placeSample(pic, [], 108);
    expect(r.x).toBeLessThan(pic.w / 2);
    expect(r.y).toBeLessThan(pic.h / 2);
  });

  it("stays clear of the sheet hanging from the bottom right", () => {
    const sheet: Rect = { x: 560, y: 60, w: 380, h: 480 };
    expect(hit(placeSample(pic, [sheet], 108), sheet)).toBe(false);
  });

  it("moves away from a sheet that covers the left side", () => {
    const sheet: Rect = { x: 0, y: 0, w: 420, h: 540 };
    expect(hit(placeSample(pic, [sheet], 108), sheet)).toBe(false);
  });

  it("stays clear of the top centre, where the notices appear", () => {
    expect(placeSample(pic, [], 108).y).toBeGreaterThanOrEqual(40);
  });

  it("stays inside the picture when the picture is letterboxed", () => {
    const boxed: Rect = { x: 120, y: 0, w: 720, h: 540 };
    const r = placeSample(boxed, [], 108);
    expect(r.x).toBeGreaterThanOrEqual(boxed.x);
    expect(r.x + r.w).toBeLessThanOrEqual(boxed.x + boxed.w);
  });

  it("on a stage too small to be clear, still lands somewhere visible and least covered", () => {
    const small: Rect = { x: 0, y: 0, w: 264, h: 149 };
    const sheet: Rect = { x: 0, y: 20, w: 264, h: 129 };
    const r = placeSample(small, [sheet], 30);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y + r.h).toBeLessThanOrEqual(small.h);
  });
});
