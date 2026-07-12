// Runnable self-check for the pure pipeline + clusterer logic (no browser needed).
// Run: node --experimental-strip-types src/analyzer/selfcheck.ts
import { componentRegions, contentScore, diffMask, dilate, toGray, type Region } from "./pipeline.ts";
import { computeFeatures, shapeDiff, type DetailedNode } from "./features.ts";
import { StreamingClusterer } from "./graph.ts";
import { selectActivity } from "./select.ts";
import { addRange, coverage, isAnalyzed, nextGap } from "./ranges.ts";
import { cropRect, snippetTimestamps, SNIPPET_MAX_FRAMES } from "./snippets.ts";
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
  const { mask: raw, mag } = diffMask(a, b, W, H);
  const mask = dilate(raw, W, H);
  const regions = componentRegions(mask, W, H, 0.00015, 0.5, mag);
  assert(regions.length >= 1, `motion produces >=1 component (got ${regions.length})`);
  // The changed region spans roughly x:20..52, y:20..52
  const r0 = regions[0];
  assert(r0.box.x < 40 && r0.box.x + r0.box.w > 30, `component overlaps the motion region (x=${r0.box.x},w=${r0.box.w})`);
  assert(r0.mass > 0 && r0.mass <= r0.box.w * r0.box.h, "mass is positive and bounded by bbox area");
  assert(r0.cx >= r0.box.x && r0.cx <= r0.box.x + r0.box.w, "centroid inside bbox");
  assert(r0.meanDiff > 25, `region meanDiff above threshold (${r0.meanDiff.toFixed(1)})`);
}

// 2. Identical frames produce no components.
{
  const a = toGray(frameWithBox(30, 30, 12, 12), W, H);
  const { mask: raw } = diffMask(a, a, W, H);
  const mask = dilate(raw, W, H);
  assert(componentRegions(mask, W, H).length === 0, "identical frames -> 0 components");
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
    features: computeFeatures([]),
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

// Extract a single region from a hand-built mask.
function regionOfMask(paint: (mask: Uint8Array) => void): Region {
  const mask = new Uint8Array(W * H);
  paint(mask);
  const rs = componentRegions(mask, W, H, 0, 1);
  assert(rs.length === 1, `mask yields exactly one region (got ${rs.length})`);
  return rs[0];
}
const rect = (x0: number, y0: number, w: number, h: number) => (mask: Uint8Array) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) mask[y * W + x] = 1;
};
const lShape = (x0: number, y0: number, s: number) => (mask: Uint8Array) => {
  rect(x0, y0, s, Math.floor(s / 3))(mask); // horizontal bar
  rect(x0, y0, Math.floor(s / 3), s)(mask); // vertical bar
};

// 7. Hu moments: invariant under translation and scale, discriminative across shapes.
{
  const bar = regionOfMask(rect(10, 10, 24, 8));
  const barMoved = regionOfMask(rect(60, 70, 24, 8));
  const barScaled = regionOfMask(rect(10, 30, 48, 16));
  const ell = regionOfMask(lShape(10, 50, 24));

  const dTranslate = shapeDiff(bar.hu, barMoved.hu);
  const dScale = shapeDiff(bar.hu, barScaled.hu);
  const dShape = shapeDiff(bar.hu, ell.hu);
  assert(dTranslate < 0.01, `Hu invariant under translation (d=${dTranslate.toFixed(4)})`);
  assert(dScale < 0.3, `Hu ~invariant under scale (d=${dScale.toFixed(4)})`);
  assert(dShape > dScale * 3, `Hu separates bar vs L-shape (d=${dShape.toFixed(3)} vs ${dScale.toFixed(3)})`);
}

// 8. Activity features: pointing-like (static) vs sketching-like (drifting) logs.
{
  const regionAt = (x: number, y: number): Region =>
    regionOfMask(rect(x, y, 10, 6));
  const pointing: DetailedNode[] = [0, 0.2, 0.4, 0.6].map((t) => ({ t, region: regionAt(30, 30) }));
  const sketching: DetailedNode[] = [0, 0.2, 0.4, 0.6].map((t, i) => ({ t, region: regionAt(20 + i * 12, 30 + i * 8) }));

  const fp = computeFeatures(pointing);
  const fs = computeFeatures(sketching);
  assert(fp.meanConsecIoU === 1, `static activity has IoU 1 (got ${fp.meanConsecIoU})`);
  assert(fp.pathLength < 1e-9 && fp.displacement < 1e-9, "static activity has no trajectory");
  assert(fs.meanConsecIoU < 0.5, `drifting activity has low IoU (got ${fs.meanConsecIoU.toFixed(2)})`);
  assert(fs.displacement > 20, `drifting activity displaces (got ${fs.displacement.toFixed(1)})`);
  assert(fs.growth > fp.growth, "drifting activity's union bbox grows more than static's");
  assert(fp.nodeCount === 4 && Math.abs(fp.duration - 0.6) < 1e-9, "count/duration recorded");
}

// 9. Snippet planning: before-frame, 0.5s cadence, even spread when capped.
{
  const mk = (start: number, end: number): Activity => ({
    id: 0, start, end, box: { x: 10, y: 10, w: 40, h: 30 }, nodeCount: 1, isValid: true,
    features: computeFeatures([]),
  });
  const meta = {
    videoWidth: 1280, videoHeight: 720, analysisWidth: 480, analysisHeight: 270,
    scale: 1280 / 480, duration: 600,
  };

  // A 2s activity: before + start + 0.5 steps + end.
  const ts = snippetTimestamps(mk(10, 12), 600);
  assert(Math.abs(ts[0] - 9.7) < 1e-9, `first frame is the "before" baseline (got ${ts[0]})`);
  assert(Math.abs(ts[ts.length - 1] - 12) < 1e-9, "last frame is the activity end (the result)");
  assert(ts.length === 6, `2s activity -> before+start+3 steps+end = 6 frames (got ${ts.length})`);
  assert(ts.every((t, i) => i === 0 || t > ts[i - 1]), "timestamps strictly ascending");

  // A 30s activity would be 61 frames at 0.5s — must cap and spread evenly.
  const long = snippetTimestamps(mk(100, 130), 600);
  assert(long.length <= SNIPPET_MAX_FRAMES, `long activity capped (got ${long.length})`);
  assert(Math.abs(long[long.length - 1] - 130) < 1e-9, "capped sequence still ends at the end");
  assert(Math.abs(long[1] - 100) < 1e-9, "capped sequence still starts at the start");
  const gaps = long.slice(2).map((t, i) => t - long[i + 1]);
  const spread = Math.max(...gaps) - Math.min(...gaps);
  assert(spread < 1e-6, `capped frames are evenly spread (gap spread ${spread.toExponential(1)})`);

  // Zero-length activity: still yields a before + the moment itself.
  const inst = snippetTimestamps(mk(50, 50), 600);
  assert(inst.length === 2, `instantaneous activity -> before + itself (got ${inst.length})`);

  // Crop rect is in native px, padded, and clamped to the frame.
  const r = cropRect(mk(0, 1), meta);
  assert(r.x >= 0 && r.y >= 0 && r.x < 10 * meta.scale,
    `crop is padded left of the activity box but never negative (x=${r.x})`);
  assert(r.w > 40 * meta.scale, "crop is padded beyond the raw activity box");
  // An activity hugging the top-left corner must clamp rather than go negative.
  const corner = cropRect({ ...mk(0, 1), box: { x: 0, y: 0, w: 20, h: 20 } }, meta);
  assert(corner.x === 0 && corner.y === 0, "crop clamps at the frame origin");
  const edge = cropRect({ ...mk(0, 1), box: { x: 470, y: 260, w: 10, h: 10 } }, meta);
  assert(edge.x + edge.w <= meta.videoWidth && edge.y + edge.h <= meta.videoHeight,
    "crop never exceeds the frame bounds");
}

console.log("\nALL PASS");
