// Streaming activity clusterer with watermark finalization. Ports the graph logic
// from roi.py: nodes connect when close in TIME (<= spanTh) and SPACE (<= distTh);
// connected components are activities. Because edges are temporally local, a cluster
// whose latest node is older than (frontier - spanTh) can never gain a new member —
// so we finalize and emit it immediately. This is what makes analysis streaming.

import type { Activity, Box, Node } from "./types";

// The clusterer knows nothing about validity heuristics; the worker adds `isValid`.
export type RawActivity = Omit<Activity, "isValid">;

function rectGap(a: Box, b: Box): number {
  const aRight = a.x + a.w, bRight = b.x + b.w;
  const aBot = a.y + a.h, bBot = b.y + b.h;
  let dx = 0, dy = 0;
  if (aRight < b.x) dx = b.x - aRight;
  else if (bRight < a.x) dx = a.x - bRight;
  if (aBot < b.y) dy = b.y - aBot;
  else if (bBot < a.y) dy = a.y - bBot;
  return Math.sqrt(dx * dx + dy * dy);
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

type Cluster = { box: Box; start: number; end: number; nodeCount: number };

export class StreamingClusterer {
  private open: Cluster[] = [];
  private nextId = 0;
  private spanTh: number;
  private distTh: number;

  // spanTh in seconds (study: 1.0); distTh in analysis-resolution pixels.
  constructor(spanTh: number, distTh: number) {
    this.spanTh = spanTh;
    this.distTh = distTh;
  }

  // Feed one node. Returns any activities finalized as a result of the advancing frontier.
  add(node: Node): RawActivity[] {
    const finalized = this.reap(node.t);
    // Merge into every open cluster this node links to (may bridge several).
    let merged: Cluster | null = null;
    const survivors: Cluster[] = [];
    for (const c of this.open) {
      const linked = node.t - c.end <= this.spanTh && rectGap(node.box, c.box) <= this.distTh;
      if (!linked) { survivors.push(c); continue; }
      if (!merged) {
        c.box = union(c.box, node.box);
        c.end = Math.max(c.end, node.t);
        c.start = Math.min(c.start, node.t);
        c.nodeCount++;
        merged = c;
        survivors.push(c);
      } else {
        merged.box = union(merged.box, c.box);
        merged.start = Math.min(merged.start, c.start);
        merged.end = Math.max(merged.end, c.end);
        merged.nodeCount += c.nodeCount;
      }
    }
    if (!merged) {
      survivors.push({ box: node.box, start: node.t, end: node.t, nodeCount: 1 });
    }
    this.open = survivors;
    return finalized;
  }

  // Finalize clusters that can no longer grow (frontier passed end + spanTh).
  private reap(frontier: number): RawActivity[] {
    const out: RawActivity[] = [];
    const still: Cluster[] = [];
    for (const c of this.open) {
      if (frontier - c.end > this.spanTh) out.push(this.emit(c));
      else still.push(c);
    }
    this.open = still;
    return out;
  }

  // Flush everything at end of stream.
  flush(): RawActivity[] {
    const out = this.open.map((c) => this.emit(c));
    this.open = [];
    return out;
  }

  private emit(c: Cluster): RawActivity {
    return { id: this.nextId++, start: c.start, end: c.end, box: c.box, nodeCount: c.nodeCount };
  }
}
