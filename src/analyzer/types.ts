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
  // Size-based validity heuristic (Python RoIActivity._is_valid): activity w/h within
  // [minSizeFrac, maxSizeFrac] of the frame w/h. Invalid activities are kept but
  // filtered from display by default.
  isValid: boolean;
};

// Tunable analysis parameters. Defaults = the study's values (VeasyGuide analyzer.py).
export type AnalysisParams = {
  analysisWidth: number; // downscale target for analysis (px)
  sampleInterval: number; // seconds between sampled frames (study: sample_fps_ratio 0.2)
  diffThresh: number; // absdiff binarization threshold (Python: threshold@25)
  dilateIters: number; // mask dilation passes (Python: iterations=3)
  contourAreaLowFrac: number; // component box area filter, fraction of frame area
  contourAreaHighFrac: number;
  spanTh: number; // seconds; max time gap for linking nodes (study: 1.0)
  distRatio: number; // max spatial gap for linking, fraction of frame diagonal (0.05)
  minSizeFrac: number; // activity validity: min w/h fraction of frame (roi_area_low 0.01)
  maxSizeFrac: number; // activity validity: max w/h fraction of frame (roi_area_high 0.7)
  minDuration: number; // display filter: hide activities shorter than this (s)
};

export const DEFAULT_PARAMS: AnalysisParams = {
  analysisWidth: 480,
  sampleInterval: 0.2,
  diffThresh: 25,
  dilateIters: 3,
  contourAreaLowFrac: 0.00015,
  contourAreaHighFrac: 0.5,
  spanTh: 1.0,
  distRatio: 0.05,
  minSizeFrac: 0.01,
  maxSizeFrac: 0.7,
  minDuration: 0,
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
  | { type: "progress"; analyzedUpTo: number; xRealtime: number; openClusters: number }
  | { type: "done"; wallMs: number; xRealtime: number }
  | { type: "error"; message: string }
  // Debug-only: per-sample analyzer view. `blob` is a WebP of the composite
  // (grayscale sample with the post-dilate diff mask tinted red) — ~10-25 KB each,
  // so a whole video's worth can be kept in memory for scrubbing (gone on refresh).
  // `boxes` are the node boxes detected for this sample (analysis-res px).
  | { type: "debugFrame"; t: number; blob: Blob; w: number; h: number; boxes: Box[] };

// Main -> worker
export type StartMsg = { type: "start"; file: File; params: AnalysisParams; debug: boolean };
