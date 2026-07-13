// Moment navigation and the timeline's marker lane.
//
// Pure geometry and stepping, kept out of the component so it can be tested.

import type { Activity } from "../analyzer/types";

// A mark drawn in the lane under the scrubber. Usually one activity; sometimes several,
// because at real lecture lengths they collide.
export type Marker = {
  leftPct: number;
  widthPct: number;
  activities: Activity[];
  index: number; // 1-based number of the FIRST moment in the mark ("Moment 3")
};

// The smallest mark that is still a real click target. Below this the lane becomes a smear of
// hairlines you cannot hit — a 4-second moment on a 75-minute lecture is 0.7px of an 800px
// track, and even on the 6-minute benchmark clip it is only 9px.
export const MIN_MARKER_PX = 6;

// Lay the moments out along a track `trackPx` wide.
//
// Marks that would overlap are MERGED into one wider mark carrying several moments. This means
// the lane deliberately LIES about time: a merged mark covers more of the timeline than its
// moments actually do. That is the accepted trade — the lane is an approximate map, and the
// exact mechanisms are the [ / ] keys, the Prev/Next buttons and the moments sidebar.
export function timelineMarkers(
  valid: readonly Activity[],
  duration: number,
  trackPx: number
): Marker[] {
  if (duration <= 0 || trackPx <= 0 || valid.length === 0) return [];

  const pxPerSec = trackPx / duration;
  const out: Marker[] = [];

  valid.forEach((a, i) => {
    const left = a.start * pxPerSec;
    const width = Math.max(MIN_MARKER_PX, (a.end - a.start) * pxPerSec);
    const prev = out[out.length - 1];

    if (prev) {
      const prevRight = (prev.leftPct / 100) * trackPx + (prev.widthPct / 100) * trackPx;
      if (left <= prevRight) {
        // Collides with the mark before it — widen that one and adopt this moment.
        const right = Math.max(prevRight, left + width);
        prev.widthPct = ((right - (prev.leftPct / 100) * trackPx) / trackPx) * 100;
        prev.activities.push(a);
        return;
      }
    }
    out.push({
      leftPct: (left / trackPx) * 100,
      widthPct: (width / trackPx) * 100,
      activities: [a],
      index: i + 1,
    });
  });

  return out;
}

const EPS = 0.05;

// Where a click on a moment lands. Seeking to `start` means the pre-activity cue is already
// over and the highlight snaps on at the same instant you arrive — the viewer never gets the
// moment to orient that `lead` exists to give them.
export function seekTargetFor(a: Activity, lead: number): number {
  return Math.max(0, a.start - lead);
}

// Which moment the playhead is "at" — the last one whose CUE has begun. The cue, not the
// start: jumping to a moment lands you at `start - lead`, and from there you are already at
// that moment, not still at the one before it.
export function momentIndexAt(valid: readonly Activity[], t: number, lead: number): number {
  let idx = -1;
  for (let i = 0; i < valid.length; i++) {
    if (valid[i].start - lead <= t + EPS) idx = i;
    else break; // sorted by start, so nothing later can qualify
  }
  return idx;
}

// Step to the next or previous moment.
//
// This works off the moment INDEX, not the raw playhead, and that is the whole trick. A jump
// lands at `start - lead`, which is BEFORE the moment it jumped to — so "the next moment
// after the playhead" would find that same moment again and every press after the first would
// stick in place.
//
// Backwards has one deliberate asymmetry: if you are already inside a moment (past its
// start), Previous replays it rather than skipping past it. Someone who missed what was just
// written wants to see THAT again. Press it a second time — you are now parked at the cue,
// before the start — and it steps properly back.
export function stepMoment(
  valid: readonly Activity[],
  t: number,
  lead: number,
  dir: 1 | -1
): Activity | null {
  const i = momentIndexAt(valid, t, lead);
  if (dir === 1) return valid[i + 1] ?? null;
  if (i < 0) return null;
  const current = valid[i];
  if (t > current.start + EPS) return current; // inside it → replay it
  return valid[i - 1] ?? null; // parked at its cue → step back
}
