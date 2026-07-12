// Shared analysis types. Framework-free (no React imports) — keep it that way.

export type Box = { x: number; y: number; w: number; h: number };

// A detected contour box at a moment in time, in ANALYSIS-resolution pixels.
export type Node = { t: number; box: Box };

// A finalized activity: connected group of nodes. Coordinates in analysis-res pixels;
// scale by `scale` to reach video display pixels.
export type Activity = {
  id: number;
  start: number;
  end: number;
  box: Box; // bounding box over all member nodes
  nodeCount: number;
};

export type AnalysisMeta = {
  videoWidth: number;
  videoHeight: number;
  analysisWidth: number;
  analysisHeight: number;
  scale: number; // videoWidth / analysisWidth
  duration: number;
};

// Worker -> main messages
export type WorkerMsg =
  | { type: "meta"; meta: AnalysisMeta }
  | { type: "activity"; activity: Activity }
  | { type: "progress"; analyzedUpTo: number; xRealtime: number }
  | { type: "done"; wallMs: number; xRealtime: number }
  | { type: "error"; message: string };

// Main -> worker
export type StartMsg = { type: "start"; file: File; analysisWidth: number; sampleInterval: number };
