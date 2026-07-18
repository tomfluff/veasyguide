// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// Regression suite. This is the geometry the highlight and the magnifier position through;
// before this file it had zero coverage and lived inside a useMemo where it could not be
// tested at all.
import { describe, it, expect } from "vitest";
import { computeLetterbox } from "./geometry";

describe("computeLetterbox", () => {
  it("fills the box exactly when the aspect ratios match", () => {
    // 1280x720 video in a 640x360 box: half size, no bars anywhere.
    expect(computeLetterbox(640, 360, 1280, 720)).toEqual({
      leftShift: 0,
      topShift: 0,
      scaleRatio: 0.5,
    });
  });

  it("pillarboxes a 4:3 video in a 16:9 box (bars on the sides)", () => {
    // 640x480 in 1280x720: height is the limit, so scale = 720/480 = 1.5.
    // Picture is 960 wide, box is 1280, so 160px of bar on each side.
    const { leftShift, topShift, scaleRatio } = computeLetterbox(1280, 720, 640, 480);
    expect(scaleRatio).toBe(1.5);
    expect(leftShift).toBe(160);
    expect(topShift).toBe(0);
  });

  it("letterboxes an ultrawide video in a 16:9 box (bars top and bottom)", () => {
    // 2560x1080 in 1280x720: width is the limit, so scale = 0.5.
    // Picture is 540 tall, box is 720, so 90px of bar top and bottom.
    const { leftShift, topShift, scaleRatio } = computeLetterbox(1280, 720, 2560, 1080);
    expect(scaleRatio).toBe(0.5);
    expect(leftShift).toBe(0);
    expect(topShift).toBe(90);
  });

  it("collapses to zero for an unmeasured box rather than guessing", () => {
    // useElementSize reports 0x0 before it has measured. A wrong scale here would draw the
    // highlight in the wrong place; a zero scale draws nothing for one frame.
    expect(computeLetterbox(0, 0, 1280, 720)).toEqual({
      leftShift: 0,
      topShift: 0,
      scaleRatio: 0,
    });
    expect(computeLetterbox(640, 360, 0, 0)).toEqual({
      leftShift: 0,
      topShift: 0,
      scaleRatio: 0,
    });
  });

  it("maps a video-pixel point onto the picture, not the box", () => {
    // The whole point of the three numbers: convert an analyzer box into screen pixels.
    // 640x480 video pillarboxed in a 1280x720 box.
    const { leftShift, topShift, scaleRatio } = computeLetterbox(1280, 720, 640, 480);
    const toScreen = (x: number, y: number) => [
      leftShift + x * scaleRatio,
      topShift + y * scaleRatio,
    ];

    // The video's own top-left lands at the picture's top-left, not the box's.
    expect(toScreen(0, 0)).toEqual([160, 0]);
    // The video's centre lands at the box's centre.
    expect(toScreen(320, 240)).toEqual([640, 360]);
    // The video's bottom-right lands at the right edge of the picture (1280 - 160).
    expect(toScreen(640, 480)).toEqual([1120, 720]);
  });
});
