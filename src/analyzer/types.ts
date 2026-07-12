// Shared analysis types. Framework-free (no React imports) — keep it that way.

import type { Region } from "./pipeline";
import type { ActivityFeatures } from "./features";

export type Box = { x: number; y: number; w: number; h: number };

// A detected contour box at a moment in time, in ANALYSIS-resolution pixels.
// `detail` carries the region stats captured during flood fill (always present when
// produced by the worker; optional so tests can build bare nodes).
export type Node = { t: number; box: Box; detail?: Region };

// A finalized activity: connected group of nodes. Coordinates in analysis-res pixels;
// scale by `scale` to reach video display pixels.
export type Scene = { id: number; start: number; end: number };

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
  // Always computed at finalization: compact aggregates intended for later ML
  // (clustering activities to learn types). See features.ts.
  features: ActivityFeatures;
  // Research detail (opt-in via StartMsg.collectNodes): the full per-node log with
  // region stats, enough for future models to derive their own features.
  nodes?: { t: number; region: Region }[];
};

// Tunable analysis parameters. Defaults = the study's values (VeasyGuide analyzer.py).
export type AnalysisParams = {
  analysisWidth: number; // downscale target for analysis (px)
  sampleInterval: number; // seconds between sampled frames (study: sample_fps_ratio 0.2)
  diffThresh: number; // absdiff binarization threshold (Python: threshold@25)
  dilateIters: number; // mask dilation passes (Python: iterations=3)
  contourAreaLowFrac: number; // component box area filter, fraction of frame area
  contourAreaHighFrac: number;
  sceneThreshold: number; // HSV content score above which a scene cut is declared
  sceneMinLen: number; // minimum seconds between cuts (debounce)
  spanTh: number; // seconds; max time gap for linking nodes (study: 1.0)
  distRatio: number; // max spatial gap for linking, fraction of frame diagonal (0.05)
  minSizeFrac: number; // activity validity: min w/h fraction of frame (roi_area_low 0.01)
  maxSizeFrac: number; // activity validity: max w/h fraction of frame (roi_area_high 0.7)
  minDuration: number; // display filter: hide activities shorter than this (s)
  highlightLead: number; // pre-activity cue: highlight this many seconds before start (s)
  highlightLinger: number; // keep highlight this many seconds after end (s)
};

export const DEFAULT_PARAMS: AnalysisParams = {
  analysisWidth: 480,
  sampleInterval: 0.2,
  diffThresh: 25,
  dilateIters: 3,
  contourAreaLowFrac: 0.00015,
  contourAreaHighFrac: 0.5,
  sceneThreshold: 27,
  sceneMinLen: 1.0,
  spanTh: 1.0,
  distRatio: 0.05,
  minSizeFrac: 0.01,
  maxSizeFrac: 0.7,
  minDuration: 0,
  highlightLead: 1.0,
  highlightLinger: 0.5,
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
  | { type: "scene"; scene: Scene }
  | { type: "progress"; analyzedUpTo: number; xRealtime: number; openClusters: number; ranges: Range[] }
  | { type: "done"; wallMs: number; xRealtime: number; ranges: Range[] }
  | { type: "error"; message: string }
  // Debug-only: per-sample analyzer view. `blob` is a WebP of the composite
  // (grayscale sample with the post-dilate diff mask tinted red) — ~10-25 KB each,
  // so a whole video's worth can be kept in memory for scrubbing (gone on refresh).
  // `boxes` are the node boxes detected for this sample (analysis-res px).
  | { type: "debugFrame"; t: number; blob: Blob; w: number; h: number; boxes: Box[] };

// A contiguous analyzed time range [start, end].
export type Range = { start: number; end: number };

// Main -> worker
export type StartMsg = {
  type: "start";
  file: File;
  params: AnalysisParams;
  debug: boolean;
  // Research mode: include the per-node region logs on emitted activities.
  collectNodes?: boolean;
};
export type SeekMsg = { type: "seek"; t: number }; // analyze from here next, abandoning current segment
export type InMsg = StartMsg | SeekMsg;
