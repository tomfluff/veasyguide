// Regression suite for the moment set and the highlight selection. Both were untested; the
// selection rules are a port of the study player and must not drift.
import { describe, it, expect } from "vitest";
import { validActivities, selectActivity } from "./select";
import type { Activity } from "./types";

// Only the fields these functions read. The rest of Activity is irrelevant here.
const act = (id: number, start: number, end: number, isValid = true) =>
  ({ id, start, end, isValid }) as unknown as Activity;

const opts = { lead: 1, linger: 0.5 };

describe("validActivities", () => {
  it("sorts by start time, because activities do NOT arrive in time order", () => {
    // This is the shape the worker actually produces: a seek jumps analysis forward, then
    // the idle worker backfills the gap it left behind. Arrival order is [0s, 120s, 20s].
    const arrival = [act(1, 0, 4), act(2, 120, 124), act(3, 20, 24)];
    expect(validActivities(arrival, 0).map((a) => a.start)).toEqual([0, 20, 120]);
  });

  it("gives a stable index as backfill lands", () => {
    // The moment at 20s is 'Moment 2' both before and after the backfilled 60s arrives.
    // Index off the raw arrival array and it would have silently shifted.
    const before = validActivities([act(1, 0, 4), act(2, 120, 124), act(3, 20, 24)], 0);
    const after = validActivities(
      [act(1, 0, 4), act(2, 120, 124), act(3, 20, 24), act(4, 60, 64)],
      0
    );
    expect(before.findIndex((a) => a.start === 20)).toBe(1);
    expect(after.findIndex((a) => a.start === 20)).toBe(1);
  });

  it("drops invalid activities and anything shorter than minDuration", () => {
    const all = [act(1, 0, 4), act(2, 10, 10.2), act(3, 20, 24, false)];
    expect(validActivities(all, 0.5).map((a) => a.id)).toEqual([1]);
  });

  it("returns an empty list rather than throwing when nothing qualifies", () => {
    expect(validActivities([], 0.5)).toEqual([]);
    expect(validActivities([act(1, 0, 4, false)], 0.5)).toEqual([]);
  });
});

describe("selectActivity", () => {
  const valid = validActivities([act(1, 10, 14), act(2, 30, 34)], 0);

  it("returns null when nothing is in range", () => {
    expect(selectActivity(valid, 0, opts)).toBeNull();
    expect(selectActivity([], 12, opts)).toBeNull();
  });

  it("shows the highlight `lead` seconds BEFORE the activity starts", () => {
    // The pre-activity cue: a low-vision viewer needs time to move their gaze before the
    // action happens. Cueing at start means the beginning is always missed.
    expect(selectActivity(valid, 9.5, opts)?.id).toBe(1); // 0.5s early, within the 1s lead
    expect(selectActivity(valid, 8.5, opts)).toBeNull(); // 1.5s early, outside it
  });

  it("keeps the highlight `linger` seconds after the activity ends", () => {
    expect(selectActivity(valid, 14.4, opts)?.id).toBe(1);
    expect(selectActivity(valid, 14.6, opts)).toBeNull();
  });

  it("lets a currently-active activity beat one that is only pre-cued", () => {
    // t=13.5 is inside activity 1, and also within the lead of a hypothetical next one.
    const overlapping = validActivities([act(1, 10, 14), act(2, 14.2, 18)], 0);
    expect(selectActivity(overlapping, 13.5, opts)?.id).toBe(1);
  });

  it("falls back to the nearest start when several are eligible but none is active", () => {
    // Both are in their padded windows and neither is running: closest start wins.
    const adjacent = validActivities([act(1, 10, 11), act(2, 12, 13)], 0);
    expect(selectActivity(adjacent, 11.4, opts)?.id).toBe(2);
  });
});
