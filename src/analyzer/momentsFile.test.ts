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
  it("groups by scene, words each moment, flags long gaps, marks what is not shown", () => {
    const md = momentsMarkdown(sample());
    expect(md).toContain("# Moments — lecture.mp4");
    expect(md).toContain("3 moments · 1 found but not shown · 2 scenes");
    expect(md).toContain("## Scene 1");
    expect(md).toContain("## Scene 2");
    // Worded, timestamped entries.
    expect(md).toContain("**00:05** (4.0s) — top left, medium size");
    // The 14s -> 70s stretch is a flagged gap (56s >= 15s threshold).
    expect(md).toMatch(/00:14–01:10: no moments \(56s\)/);
    // The invalid activity at 40s IS listed now, and says why it isn't shown.
    expect(md).toContain("**00:40** (1.0s) — top left, medium size — not shown: size outside the range the analyzer accepts");
    // Tail gap 75 -> 120 flagged too.
    expect(md).toMatch(/01:15–02:00: no moments \(45s\)/);
  });

  it("a moment shorter than minDuration is listed as not shown, and does not close a gap", () => {
    // The divergence this fixes: the player hides sub-minDuration moments (select.ts
    // validActivities), the export used to list them as if the sidebar had them.
    const f = buildMomentsFile({
      fileName: "l.mp4", fileSize: 1, params: { ...DEFAULT_PARAMS, minDuration: 0.1 },
      meta: META, webcam: null, scenes: [{ id: 0, start: 0, end: 120 }],
      activities: [act(0, 5, 9), { ...act(1, 60, 60.05), id: 1 }],
    });
    const md = momentsMarkdown(f);
    expect(md).toContain("1 moments · 1 found but not shown");
    expect(md).toContain("not shown: shorter than the 0.1s minimum");
    // The blip at 60s sits inside the 9s->120s stretch but must not break it: the gap runs
    // from the last SHOWN moment's end all the way to the video's end.
    expect(md).toMatch(/00:09–02:00: no moments \(111s\)/);
  });

  it("survives a sidecar with no params rather than crashing the export", () => {
    // parseMomentsFile does not require params; an untrusted file must not throw here.
    const f = { ...sample(), params: undefined } as unknown as Parameters<typeof momentsMarkdown>[0];
    expect(() => momentsMarkdown(f)).not.toThrow();
  });
});
