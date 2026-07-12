// Runnable self-check for the pure pipeline + clusterer logic (no browser needed).
// Run: node --experimental-strip-types src/analyzer/selfcheck.ts
import { componentBoxes, contentScore, diffMask, dilate, toGray } from "./pipeline.ts";
import { StreamingClusterer } from "./graph.ts";
import { selectActivity } from "./select.ts";
import { addRange, coverage, isAnalyzed, nextGap } from "./ranges.ts";
import type { Activity, Node } from "./types.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok:", msg);
}

const W = 100, H = 100;

// Build an RGBA frame with a filled white box.
function frameWithBox(bx: number, by: number, bw: number, bh: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inBox = x >= bx && x < bx + bw && y >= by && y < by + bh;
      const p = (y * W + x) * 4;
      const v = inBox ? 255 : 20;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
      rgba[p + 3] = 255;
    }
  return rgba;
}

// 1. A box that moves should produce exactly one detected component near the motion.
{
  const a = toGray(frameWithBox(20, 20, 12, 12), W, H);
  const b = toGray(frameWithBox(40, 40, 12, 12), W, H);
  const mask = dilate(diffMask(a, b, W, H), W, H);
  const boxes = componentBoxes(mask, W, H);
  assert(boxes.length >= 1, `motion produces >=1 component (got ${boxes.length})`);
  // The changed region spans roughly x:20..52, y:20..52
  const b0 = boxes[0];
  assert(b0.x < 40 && b0.x + b0.w > 30, `component overlaps the motion region (x=${b0.x},w=${b0.w})`);
}

// 2. Identical frames produce no components.
{
  const a = toGray(frameWithBox(30, 30, 12, 12), W, H);
  const mask = dilate(diffMask(a, a, W, H), W, H);
  assert(componentBoxes(mask, W, H).length === 0, "identical frames -> 0 components");
}

// 3. Clusterer: two nodes within spanTh + distTh merge; a far-future node finalizes them.
{
  const c = new StreamingClusterer(1.0, 15);
  const near = (t: number, x: number): Node => ({ t, box: { x, y: 10, w: 6, h: 6 } });
  let finalized = c.add(near(0.0, 10));
  finalized = finalized.concat(c.add(near(0.4, 12))); // links (close in time+space)
  assert(finalized.length === 0, "linked nodes not yet finalized");
  // A node 3s later is beyond spanTh of the first cluster -> finalizes it.
  finalized = c.add(near(3.0, 80));
  assert(finalized.length === 1, `watermark finalized the stale cluster (got ${finalized.length})`);
  assert(finalized[0].nodeCount === 2, `merged cluster has 2 nodes (got ${finalized[0].nodeCount})`);
  assert(Math.abs(finalized[0].start - 0) < 1e-9 && Math.abs(finalized[0].end - 0.4) < 1e-9, "cluster time span correct");
  const rest = c.flush();
  assert(rest.length === 1, "flush emits the remaining open cluster");
}

// 4. Activity selection: pre-activity lead + active-precedence (study player port).
{
  const act = (id: number, start: number, end: number): Activity => ({
    id, start, end, box: { x: 0, y: 0, w: 10, h: 10 }, nodeCount: 1, isValid: true,
  });
  const opts = { lead: 1.0, linger: 0.5, minDuration: 0 };
  const A = act(0, 10, 20); // long, active during most tests
  const B = act(1, 21, 25); // upcoming

  // Pre-activity: nothing active at t=9.5, A starts at 10 -> highlighted early.
  assert(selectActivity([A, B], 9.5, opts)?.id === 0, "pre-activity cue shows before start");
  // Nothing eligible well before.
  assert(selectActivity([A, B], 8.5, opts) === null, "no highlight outside lead window");
  // Active precedence: at t=20.3, A lingers (ended 20) and B is upcoming (starts 21).
  // Neither is active; closest start to t wins -> B (|21-20.3| < |10-20.3|).
  assert(selectActivity([A, B], 20.3, opts)?.id === 1, "closest start wins when none active");
  // A active at t=19.9 while B is in its lead window -> the ACTIVE one wins.
  assert(selectActivity([A, B], 19.9, opts)?.id === 0, "active activity beats pre-activity cue");
  // Linger: A still highlighted at t=20.4 when B removed.
  assert(selectActivity([A], 20.4, opts)?.id === 0, "highlight lingers after end");
  // minDuration filter hides short activities.
  const S = act(2, 30, 30.2);
  assert(selectActivity([S], 30.1, { ...opts, minDuration: 0.5 }) === null, "minDuration hides short activities");
  // Invalid activities never selected.
  assert(selectActivity([{ ...A, isValid: false }], 15, opts) === null, "invalid activities never selected");
}

// 5. Scene scoring: a small moving mark barely registers; a whole-frame change spikes.
{
  const dark = frameWithBox(20, 20, 12, 12); // small white box on dark bg
  const darkMoved = frameWithBox(40, 40, 12, 12); // same, box moved
  const light = new Uint8ClampedArray(W * H * 4).fill(230); // entirely different frame

  const activityScore = contentScore(dark, darkMoved);
  const cutScore = contentScore(dark, light);
  assert(activityScore < 27, `pen-stroke-scale change stays below cut threshold (${activityScore.toFixed(1)})`);
  assert(cutScore > 27, `whole-frame change exceeds cut threshold (${cutScore.toFixed(1)})`);
  assert(contentScore(dark, dark) === 0, "identical frames score 0");
}

// 6. Range bookkeeping: coverage is a set of segments, and gaps get backfilled in order.
{
  let r = addRange([], { start: 0, end: 10 });
  assert(isAnalyzed(r, 5) && !isAnalyzed(r, 15), "isAnalyzed respects range bounds");
  // Seek to 40 creates a second segment; the gap between them is still open.
  r = addRange(r, { start: 40, end: 50 });
  assert(r.length === 2, "disjoint segments stay separate");
  assert(nextGap(r, 60, 0) === 10, "next gap starts right after the first segment");
  // Fill the middle; adjacent ranges merge.
  r = addRange(r, { start: 10, end: 40 });
  assert(r.length === 1 && r[0].end === 50, "adjacent ranges merge");
  assert(nextGap(r, 60, 0) === 50, "remaining tail is the next gap");
  assert(Math.abs(coverage(r, 60) - 50 / 60) < 1e-9, "coverage fraction correct");
  // Fully covered -> no gaps left.
  r = addRange(r, { start: 50, end: 60 });
  assert(nextGap(r, 60, 0) === null, "no gap when fully covered");
}

console.log("\nALL PASS");
