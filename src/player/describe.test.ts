import { describe, expect, it } from "vitest";
import { momentPlace, momentSize, momentDescription } from "./describe";
import type { Activity } from "../analyzer/types";
import type { ActivityFeatures } from "../analyzer/features";

const F: ActivityFeatures = {
  duration: 1, nodeCount: 10, nodesPerSec: 10,
  meanMass: 0, meanDensity: 0, meanDiff: 0,
  meanConsecIoU: 0.4, pathLength: 0, displacement: 0, tortuosity: 1,
  xSpread: 0, ySpread: 0, growth: 1, meanShapeDiff: 0, meanOcc: 0, flaggedFrac: 0,
};

function act(box: { x: number; y: number; w: number; h: number }): Activity {
  return { id: 0, start: 0, end: 1, box, nodeCount: 10, isValid: true, features: F };
}

// Frame used throughout: 480×270 (the analyzer's default 16:9).
const W = 480, H = 270;

describe("momentPlace", () => {
  it("corners and center", () => {
    expect(momentPlace(act({ x: 10, y: 10, w: 40, h: 20 }), W, H)).toBe("top left");
    expect(momentPlace(act({ x: 400, y: 230, w: 40, h: 20 }), W, H)).toBe("bottom right");
    expect(momentPlace(act({ x: 210, y: 120, w: 40, h: 20 }), W, H)).toBe("center");
  });
  it("middle row drops the word middle", () => {
    expect(momentPlace(act({ x: 400, y: 120, w: 40, h: 20 }), W, H)).toBe("right");
  });
  it("a full-width box is across, not center", () => {
    expect(momentPlace(act({ x: 10, y: 10, w: 460, h: 30 }), W, H)).toBe("across the top");
  });
  it("a full-frame box is most of the slide", () => {
    expect(momentPlace(act({ x: 0, y: 0, w: 470, h: 260 }), W, H)).toBe("most of the slide");
  });
});

describe("momentSize", () => {
  it("thresholds at 1% and 8% of frame area", () => {
    expect(momentSize(act({ x: 0, y: 0, w: 20, h: 20 }), W, H)).toBe("small"); // 0.3%
    expect(momentSize(act({ x: 0, y: 0, w: 80, h: 40 }), W, H)).toBe("medium"); // 2.5%
    expect(momentSize(act({ x: 0, y: 0, w: 200, h: 100 }), W, H)).toBe("large"); // 15%
  });
});

describe("momentDescription", () => {
  // No verb: geometry only. See describe.ts on why the verb tier was removed.
  it("composes the spoken form", () => {
    expect(momentDescription(act({ x: 400, y: 10, w: 80, h: 40 }), W, H)).toBe("top right, medium size");
  });
});
