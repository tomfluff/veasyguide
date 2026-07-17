import { describe, expect, it } from "vitest";
import { buildMomentsFile, parseMomentsFile, momentsMarkdown, videoKey, keyOf, sidecarMatchesFile, MOMENTS_VERSION } from "./momentsFile";
import { DEFAULT_PARAMS, type Activity, type AnalysisMeta } from "./types";
import type { ActivityFeatures } from "./features";

const META: AnalysisMeta = {
  videoWidth: 1280, videoHeight: 720,
  analysisWidth: 480, analysisHeight: 270,
  scale: 1280 / 480, duration: 120,
};

const F: ActivityFeatures = {
  duration: 1, nodeCount: 5, nodesPerSec: 5,
  meanMass: 0, meanDensity: 0, meanDiff: 0,
  meanConsecIoU: 0.4, pathLength: 0, displacement: 0, tortuosity: 1,
  xSpread: 0, ySpread: 0, growth: 5, meanShapeDiff: 0, meanOcc: 0, flaggedFrac: 0,
};

const act = (id: number, start: number, end: number, isValid = true): Activity => ({
  id, start, end, box: { x: 10, y: 10, w: 60, h: 30 }, nodeCount: 5, isValid, features: F,
});

function sample() {
  return buildMomentsFile({
    fileName: "lecture.mp4",
    fileSize: 12345,
    params: DEFAULT_PARAMS,
    meta: META,
    webcam: null,
    scenes: [
      { id: 0, start: 0, end: 60 },
      { id: 1, start: 60, end: 120 },
    ],
    activities: [act(0, 5, 9), act(1, 12, 14), act(2, 70, 75), act(3, 40, 41, false)],
  });
}

describe("moments file round trip", () => {
  it("parses what it builds", () => {
    const text = JSON.stringify(sample());
    const r = parseMomentsFile(text);
    expect(r.error).toBeUndefined();
    expect(r.file!.activities).toHaveLength(4);
    expect(keyOf(r.file!)).toBe(videoKey(12345, 120, 1280, 720));
  });

  it("rejects non-JSON, foreign JSON, and version drift with human messages", () => {
    expect(parseMomentsFile("not json").error).toMatch(/valid JSON/);
    expect(parseMomentsFile("{}").error).toMatch(/isn't a veasyguide/);
    const wrongVersion = { ...sample(), version: MOMENTS_VERSION + 1 };
    expect(parseMomentsFile(JSON.stringify(wrongVersion)).error).toMatch(/version/);
  });

  it("matches sidecars by file size", () => {
    expect(sidecarMatchesFile(sample(), 12345)).toBe(true);
    expect(sidecarMatchesFile(sample(), 12346)).toBe(false);
  });
});

describe("momentsMarkdown", () => {
  it("groups by scene, words each moment, flags long gaps, skips invalid moments", () => {
    const md = momentsMarkdown(sample());
    expect(md).toContain("# Moments — lecture.mp4");
    expect(md).toContain("3 moments · 2 scenes");
    expect(md).toContain("## Scene 1");
    expect(md).toContain("## Scene 2");
    // Worded, timestamped entries.
    expect(md).toContain("**00:05** (4.0s) — top left, medium size");
    // The 14s -> 70s stretch is a flagged gap (56s >= 15s threshold).
    expect(md).toMatch(/00:14–01:10: no visual activity \(56s\)/);
    // The invalid activity at 40s is not listed.
    expect(md).not.toContain("00:40");
    // Tail gap 75 -> 120 flagged too.
    expect(md).toMatch(/01:15–02:00: no visual activity \(45s\)/);
  });
});
