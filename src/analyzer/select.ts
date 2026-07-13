// Which activity should be highlighted at time t. Faithful port of the study
// player's getSingleActivityAtTime (VeasyGuide VideoPlayer.tsx):
// - activities match within [start - lead, end + linger] — the "pre-activity" cue
//   shows the highlight before the action starts so the viewer can orient
// - a single currently-ACTIVE activity always wins over pre/post-padded matches
// - otherwise the activity whose start is closest to t wins
//
// This takes an ALREADY-FILTERED, ALREADY-SORTED array (see validActivities below). It used
// to filter on isValid/minDuration itself, on every presented frame. Now the player, the
// timeline's moment markers and the moments sidebar all read the same list, so the filter
// happens once and they cannot disagree about which moments exist.

import type { Activity } from "./types";

export type SelectOpts = {
  lead: number; // seconds before start the activity becomes eligible
  linger: number; // seconds after end it stays eligible
};

// The moments, in time order.
//
// SORTING IS NOT COSMETIC. Analysis is segmented: a seek abandons the current segment and
// restarts at the seek point, and the idle worker then backfills the earliest remaining gap
// (see analyzer/worker.ts). Activities therefore ARRIVE out of order — the array can read
// [0-10s..., 12:00+..., backfilled 0:20-12:00...]. Indexing that array directly would number
// the moments by arrival, so "Moment 9" could sit at 1:30, and the numbers would renumber
// themselves under the viewer as backfill landed. In a live region, that announces changes
// nobody made.
export function validActivities(
  activities: readonly Activity[],
  minDuration: number
): Activity[] {
  return activities
    .filter((a) => a.isValid && a.end - a.start >= minDuration)
    .sort((a, b) => a.start - b.start);
}

export function selectActivity(
  valid: readonly Activity[],
  t: number,
  opts: SelectOpts
): Activity | null {
  const hits = valid.filter((a) => t >= a.start - opts.lead && t <= a.end + opts.linger);
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];

  const active = hits.filter((a) => a.start <= t && a.end >= t);
  if (active.length === 1) return active[0];

  return hits.reduce((prev, curr) =>
    Math.abs(curr.start - t) < Math.abs(prev.start - t) ? curr : prev
  );
}
