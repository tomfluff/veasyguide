import { describe, it, expect } from "vitest";
import { timelineMarkers, stepMoment, seekTargetFor, MIN_MARKER_PX } from "./moments";
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
  const LEAD = 1;
  // What a press actually does: pick the target, then seek to its cue.
  const press = (t: number, dir: 1 | -1) => {
    const target = stepMoment(valid, t, LEAD, dir);
    return target ? { id: target.id, landsAt: seekTargetFor(target, LEAD) } : null;
  };

  it("keeps stepping forward on repeated presses instead of sticking", () => {
    // THE regression this exists for. A jump lands at start-lead, which is BEFORE the moment
    // it jumped to. Step off the raw playhead and the next press finds that same moment
    // again — you press ] four times and never leave moment 2.
    let t = 0;
    const visited: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = press(t, 1);
      if (!r) break;
      visited.push(r.id);
      t = r.landsAt;
    }
    expect(visited).toEqual([1, 2, 3]); // then null at the end, not a fourth
  });

  it("steps forward past the moment you are playing inside", () => {
    expect(press(12, 1)?.id).toBe(2); // inside moment 1 → next is 2
    expect(press(0, 1)?.id).toBe(1);
  });

  it("replays the moment you are inside, then steps back on a second press", () => {
    // A viewer who missed what was just written presses Previous because they want to see
    // THAT moment again — not the one before it. A second press steps properly back.
    const first = press(31, -1); // inside moment 2
    expect(first?.id).toBe(2);
    expect(first?.landsAt).toBe(29);
    expect(press(29, -1)?.id).toBe(1); // now parked at its cue → back to moment 1
  });

  it("returns you where you were: ] then [ is a round trip", () => {
    const fwd = press(12, 1); // inside moment 1 → jump to moment 2, landing at 29
    expect(fwd).toEqual({ id: 2, landsAt: 29 });
    expect(press(fwd!.landsAt, -1)?.id).toBe(1); // and straight back to moment 1
  });

  it("is a no-op at the ends rather than wrapping", () => {
    expect(press(60, 1)).toBeNull();
    expect(press(0, -1)).toBeNull();
    expect(stepMoment([], 10, LEAD, 1)).toBeNull();
    expect(stepMoment([], 10, LEAD, -1)).toBeNull();
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
