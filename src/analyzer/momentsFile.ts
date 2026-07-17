// The moments file: one analysis, serialized. Three consumers share this format —
// the IndexedDB cache (reopen the same video, skip re-analysis), the exportable
// .veasyguide.json sidecar (an instructor analyzes once and posts the file next to the
// video; 300 students each skip ~25 minutes), and the Markdown export (a textual skeleton
// of the lecture's visual events — a blind learner's note anchor, a creator's pacing data).
//
// The sidecar is the architecture-honest answer to "embed the player" / "paste a link":
// the FILE the creator hosts is a few kilobytes of coordinates; the video itself still
// never moves (decisions D1/D2, proposals-parked.md).

import type { Activity, AnalysisMeta, AnalysisParams, Box, Range, Scene } from "./types";
import { momentDescription } from "../player/describe";
import { convertSecondsToTimecode } from "../utils/misc";

export const MOMENTS_FORMAT = "veasyguide-moments";
export const MOMENTS_VERSION = 1;

export type MomentsFile = {
  format: typeof MOMENTS_FORMAT;
  version: number;
  savedAt: string; // ISO — provenance for humans reading the JSON
  // Identity of the video this analysis belongs to. Size + duration + frame size is
  // rename-proof (name is carried for humans, never matched on).
  video: { name: string; size: number; duration: number; width: number; height: number };
  params: AnalysisParams;
  meta: AnalysisMeta;
  webcam: Box | null;
  scenes: Scene[];
  activities: Activity[];
};

export function buildMomentsFile(args: {
  fileName: string;
  fileSize: number;
  params: AnalysisParams;
  meta: AnalysisMeta;
  webcam: Box | null;
  scenes: Scene[];
  activities: Activity[];
}): MomentsFile {
  return {
    format: MOMENTS_FORMAT,
    version: MOMENTS_VERSION,
    savedAt: new Date().toISOString(),
    video: {
      name: args.fileName,
      size: args.fileSize,
      duration: args.meta.duration,
      width: args.meta.videoWidth,
      height: args.meta.videoHeight,
    },
    params: args.params,
    meta: args.meta,
    webcam: args.webcam,
    scenes: args.scenes,
    activities: args.activities,
  };
}

// The cache key. Duration tolerates container rounding (two demuxers can disagree by a
// frame); size and frame dimensions must be exact.
export function videoKey(size: number, duration: number, w: number, h: number): string {
  return `${size}|${Math.round(duration * 10)}|${w}x${h}`;
}

export function keyOf(f: MomentsFile): string {
  return videoKey(f.video.size, f.video.duration, f.video.width, f.video.height);
}

// Parse + validate an untrusted sidecar. Returns an error STRING (for the banner), not an
// exception — a malformed file a student got from a forum is an expected input, not a bug.
export function parseMomentsFile(text: string): { file: MomentsFile; error?: never } | { file?: never; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "That moments file isn't valid JSON." };
  }
  const f = raw as Partial<MomentsFile>;
  if (f?.format !== MOMENTS_FORMAT) {
    return { error: "That JSON file isn't a veasyguide moments file." };
  }
  if (f.version !== MOMENTS_VERSION) {
    return { error: `That moments file is version ${f.version}; this app reads version ${MOMENTS_VERSION}. Re-export it from a matching version.` };
  }
  if (
    !f.video || typeof f.video.size !== "number" || typeof f.video.duration !== "number" ||
    !f.meta || !Array.isArray(f.activities) || !Array.isArray(f.scenes)
  ) {
    return { error: "That moments file is missing required fields — it may be truncated." };
  }
  return { file: f as MomentsFile };
}

// Does this sidecar belong to this video file? Size is the cheap pre-demux check; the
// duration check runs later, once the video's own metadata is read.
export function sidecarMatchesFile(f: MomentsFile, fileSize: number): boolean {
  return f.video.size === fileSize;
}

// A gap long enough to be worth naming in the export: the creator persona's retention
// diagnostic ("static screen — voice only"), and the crammer's measured 67% dead air.
export const EXPORT_GAP_MIN = 15;

// The Markdown export: a scene-grouped, timestamped index of every moment, with long
// moment-free stretches called out. Text is the one rendering of this data a screen
// reader, a text editor, and a diff all read natively.
export function momentsMarkdown(f: MomentsFile): string {
  const { meta } = f;
  const acts = [...f.activities].filter((a) => a.isValid).sort((a, b) => a.start - b.start);
  const lines: string[] = [];
  lines.push(`# Moments — ${f.video.name}`);
  lines.push("");
  lines.push(
    `${acts.length} moments · ${f.scenes.length} scene${f.scenes.length === 1 ? "" : "s"} · ` +
    `${convertSecondsToTimecode(f.video.duration)} · analyzed ${f.savedAt.slice(0, 10)} by veasyguide (in-browser, video never uploaded)`
  );

  const sceneFor = (t: number): number => {
    let idx = 0;
    for (let i = 0; i < f.scenes.length; i++) if (f.scenes[i].start <= t) idx = i;
    return idx;
  };

  let lastScene = -1;
  let lastEnd = 0;
  for (const a of acts) {
    const gap = a.start - lastEnd;
    if (gap >= EXPORT_GAP_MIN) {
      lines.push(`- _${convertSecondsToTimecode(lastEnd)}–${convertSecondsToTimecode(a.start)}: no visual activity (${Math.round(gap)}s)_`);
    }
    const s = sceneFor(a.start);
    if (s !== lastScene) {
      lastScene = s;
      lines.push("");
      lines.push(`## Scene ${s + 1} — from ${convertSecondsToTimecode(f.scenes[s]?.start ?? 0)}`);
      lines.push("");
    }
    lines.push(
      `- **${convertSecondsToTimecode(a.start)}** (${(a.end - a.start).toFixed(1)}s) — ${momentDescription(a, meta.analysisWidth, meta.analysisHeight)}`
    );
    lastEnd = Math.max(lastEnd, a.end);
  }
  const tail = f.video.duration - lastEnd;
  if (tail >= EXPORT_GAP_MIN) {
    lines.push(`- _${convertSecondsToTimecode(lastEnd)}–${convertSecondsToTimecode(f.video.duration)}: no visual activity (${Math.round(tail)}s)_`);
  }
  lines.push("");
  return lines.join("\n");
}
