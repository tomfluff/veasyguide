// Which activity should be highlighted at time t. Faithful port of the study
// player's getSingleActivityAtTime (VeasyGuide VideoPlayer.tsx):
// - activities match within [start - lead, end + linger] — the "pre-activity" cue
//   shows the highlight before the action starts so the viewer can orient
// - a single currently-ACTIVE activity always wins over pre/post-padded matches
// - otherwise the activity whose start is closest to t wins

import type { Activity } from "./types";

export type SelectOpts = {
  lead: number; // seconds before start the activity becomes eligible
  linger: number; // seconds after end it stays eligible
  minDuration: number; // hide activities shorter than this
};

export function selectActivity(activities: Activity[], t: number, opts: SelectOpts): Activity | null {
  const hits = activities.filter(
    (a) =>
      a.isValid &&
      a.end - a.start >= opts.minDuration &&
      t >= a.start - opts.lead &&
      t <= a.end + opts.linger
  );
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];

  const active = hits.filter((a) => a.start <= t && a.end >= t);
  if (active.length === 1) return active[0];

  return hits.reduce((prev, curr) =>
    Math.abs(curr.start - t) < Math.abs(prev.start - t) ? curr : prev
  );
}
