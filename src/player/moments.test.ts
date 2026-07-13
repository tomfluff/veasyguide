import { describe, it, expect } from "vitest";
import { timelineMarkers, nextMoment, prevMoment, seekTargetFor, MIN_MARKER_PX } from "./moments";
import type { Activity } from "../analyzer/types";

const act = (id: number, start: number, end: number) =>
  ({ id, start, end, isValid: true }) as unknown as Activity;

describe("timelineMarkers", () => {
  it("places a marker at its share of the track", () => {
    // One 60s moment starting at 30s, in a 300s video on a 1000px track.
    const [m] = timelineMarkers([act(1, 30, 90)], 300, 1000);
    expect(m.leftPct).toBeCloseTo(10); // 30/300
    expect(m.widthPct).toBeCloseTo(20); // 60/300
    expect(m.index).toBe(1);
  });

  it("gives a brief moment a minimum width instead of a hairline", () => {
    // A 4s moment in a 75-minute lecture is 0.7px of an 800px track — unclickable.
    const [m] = timelineMarkers([act(1, 1000, 1004)], 4500, 800);
    expect((m.widthPct / 100) * 800).toBeCloseTo(MIN_MARKER_PX);
  });

  it("merges colliding moments into one wider mark", () => {
    // Three moments a second apart in a 75-minute lecture: each is sub-pixel, and after the
    // minimum width they overlap. They become one mark, not three hairlines on top of
    // each other.
    const markers = timelineMarkers(
      [act(1, 1000, 1002), act(2, 1003, 1005), act(3, 1006, 1008)],
      4500,
      800
    );
    expect(markers).toHaveLength(1);
    expect(markers[0].activities.map((a) => a.id)).toEqual([1, 2, 3]);
    expect(markers[0].index).toBe(1);
  });

  it("keeps well-separated moments separate", () => {
    const markers = timelineMarkers([act(1, 10, 20), act(2, 200, 210)], 300, 1000);
    expect(markers).toHaveLength(2);
    expect(markers[1].index).toBe(2);
  });

  it("returns nothing rather than dividing by zero", () => {
    expect(timelineMarkers([act(1, 0, 4)], 0, 800)).toEqual([]);
    expect(timelineMarkers([act(1, 0, 4)], 300, 0)).toEqual([]);
    expect(timelineMarkers([], 300, 800)).toEqual([]);
  });
});

describe("stepping", () => {
  const valid = [act(1, 10, 14), act(2, 30, 34), act(3, 50, 54)];

  it("steps forward past the moment you are already in", () => {
    expect(nextMoment(valid, 12)?.id).toBe(2); // inside moment 1 → next is 2
    expect(nextMoment(valid, 0)?.id).toBe(1);
  });

  it("replays the moment you are inside, then steps back on a second press", () => {
    // Deliberate, and it matters. A viewer who missed what was just written presses Previous
    // because they want to see THAT moment again — not the one before it. So from inside
    // moment 2 we return moment 2, and the seek lands at its start (minus the lead), which
    // replays it. Pressing Previous again from there steps properly back to moment 1.
    // This is the media-player convention, and it falls out of "the last moment that started
    // before the playhead" for free.
    expect(prevMoment(valid, 31)?.id).toBe(2); // inside moment 2 → replay it
    expect(prevMoment(valid, 29)?.id).toBe(1); // now parked before it → step back
  });

  it("is a no-op at the ends rather than wrapping", () => {
    expect(nextMoment(valid, 60)).toBeNull();
    expect(prevMoment(valid, 0)).toBeNull();
    expect(nextMoment([], 10)).toBeNull();
    expect(prevMoment([], 10)).toBeNull();
  });
});

describe("seekTargetFor", () => {
  it("lands before the moment so the pre-activity cue actually plays", () => {
    expect(seekTargetFor(act(1, 30, 34), 1)).toBe(29);
  });

  it("never seeks before the start of the video", () => {
    expect(seekTargetFor(act(1, 0.4, 4), 1)).toBe(0);
  });
});
