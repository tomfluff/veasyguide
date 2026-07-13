// Activity-level feature vectors, aggregated from an activity's node log.
// Always computed at finalization (cheap); intended for later ML — clustering
// finalized activities to learn types (pointing/marking/sketching/...) instead of
// the old hand-tuned heuristic. Every feature here maps to a signal the Python
// heuristic used or implied: shapeDiff ≈ avg matchShapes difference, growth/IoU
// separate marking from pointing, trajectory separates sketching from animation.

import type { Box } from "./types";
import type { Region } from "./pipeline";

// One detection node with its region stats (analysis-res px).
export type DetailedNode = { t: number; region: Region };

export type ActivityFeatures = {
  duration: number;
  nodeCount: number;
  nodesPerSec: number;
  // Ink & intensity
  meanMass: number; // avg changed-pixel count per node
  meanDensity: number; // mass / bbox area — thin stroke vs solid blob
  meanDiff: number; // avg per-pixel change magnitude — cursor≈subtle, ink≈strong
  // Spatial behavior of consecutive nodes
  meanConsecIoU: number; // pointing = same spot (high), sketching = drifting (low)
  pathLength: number; // centroid trajectory length (analysis px)
  displacement: number; // straight-line first→last centroid distance
  tortuosity: number; // pathLength / displacement — wander vs directed motion
  xSpread: number; // std-dev of centroid x
  ySpread: number;
  // Accumulation
  growth: number; // union-bbox area / mean node bbox area — marking grows, pointing doesn't
  // Shape consistency (the matchShapes analog, cv2 CONTOURS_MATCH_I2 style)
  meanShapeDiff: number;
  // Structural motion
  meanOcc: number; // mean change-occupancy across member regions (see pipeline.Region.occ)
  flaggedFrac: number; // share of member nodes sitting in habitually-moving frame area
};

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// cv2.matchShapes(I2): sum |m_i(A) - m_i(B)| where m_i = sign(h_i) * log10(|h_i|).
export function shapeDiff(huA: number[], huB: number[]): number {
  let d = 0;
  for (let i = 0; i < 7; i++) {
    const a = huA[i];
    const b = huB[i];
    if (Math.abs(a) < 1e-30 || Math.abs(b) < 1e-30) continue;
    const ma = Math.sign(a) * Math.log10(Math.abs(a));
    const mb = Math.sign(b) * Math.log10(Math.abs(b));
    d += Math.abs(ma - mb);
  }
  return d;
}

// `flagTh`: a region whose mean change-occupancy reaches this is structural motion, not ink
// (see pipeline.Region.occ). The share of an activity's nodes that trip it is `flaggedFrac`,
// which is what invalidates a talking head: nearly all of its nodes are flagged, while a real
// activity that merely happens to pass near the webcam has only a few. A per-node vote rather
// than a mean, because a mean is dragged around by a handful of extreme nodes and this
// shouldn't be — the question is "is most of this activity structural?", which is a count.
export function computeFeatures(nodes: DetailedNode[], flagTh = Infinity): ActivityFeatures {
  const n = nodes.length;
  const sorted = [...nodes].sort((a, b) => a.t - b.t);
  const duration = n > 0 ? sorted[n - 1].t - sorted[0].t : 0;

  let occSum = 0, flagged = 0;
  let massSum = 0, densitySum = 0, diffSum = 0;
  let cxSum = 0, cySum = 0, cx2Sum = 0, cy2Sum = 0;
  let unionMinX = Infinity, unionMinY = Infinity, unionMaxX = -Infinity, unionMaxY = -Infinity;
  let areaSum = 0;
  for (const { region: r } of sorted) {
    massSum += r.mass;
    densitySum += r.mass / (r.box.w * r.box.h);
    diffSum += r.meanDiff;
    occSum += r.occ;
    if (r.occ >= flagTh) flagged++;
    cxSum += r.cx; cySum += r.cy;
    cx2Sum += r.cx * r.cx; cy2Sum += r.cy * r.cy;
    unionMinX = Math.min(unionMinX, r.box.x);
    unionMinY = Math.min(unionMinY, r.box.y);
    unionMaxX = Math.max(unionMaxX, r.box.x + r.box.w);
    unionMaxY = Math.max(unionMaxY, r.box.y + r.box.h);
    areaSum += r.box.w * r.box.h;
  }

  let iouSum = 0, pathLength = 0, shapeSum = 0;
  for (let i = 1; i < n; i++) {
    const prev = sorted[i - 1].region;
    const cur = sorted[i].region;
    iouSum += iou(prev.box, cur.box);
    pathLength += Math.hypot(cur.cx - prev.cx, cur.cy - prev.cy);
    shapeSum += shapeDiff(prev.hu, cur.hu);
  }
  const displacement =
    n > 1
      ? Math.hypot(
          sorted[n - 1].region.cx - sorted[0].region.cx,
          sorted[n - 1].region.cy - sorted[0].region.cy
        )
      : 0;

  const meanArea = n > 0 ? areaSum / n : 0;
  const unionArea =
    n > 0 ? (unionMaxX - unionMinX) * (unionMaxY - unionMinY) : 0;
  const mean = (s: number) => (n > 0 ? s / n : 0);
  const meanPair = (s: number) => (n > 1 ? s / (n - 1) : 0);

  return {
    duration,
    nodeCount: n,
    nodesPerSec: duration > 0 ? n / duration : n,
    meanMass: mean(massSum),
    meanDensity: mean(densitySum),
    meanDiff: mean(diffSum),
    meanConsecIoU: meanPair(iouSum),
    pathLength,
    displacement,
    tortuosity: pathLength / (displacement + 1e-6),
    xSpread: n > 0 ? Math.sqrt(Math.max(0, cx2Sum / n - (cxSum / n) ** 2)) : 0,
    ySpread: n > 0 ? Math.sqrt(Math.max(0, cy2Sum / n - (cySum / n) ** 2)) : 0,
    growth: meanArea > 0 ? unionArea / meanArea : 0,
    meanShapeDiff: meanPair(shapeSum),
    meanOcc: mean(occSum),
    flaggedFrac: n > 0 ? flagged / n : 0,
  };
}
