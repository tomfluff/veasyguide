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

// Why the player doesn't show this moment, or null if it does. The player shows a moment
// when the analyzer accepted its size (isValid) AND it lasts at least the display floor
// (params.minDuration) — see select.ts `validActivities`, which is the one place that
// decides. Null means shown.
//
// The export used to filter on isValid alone and say nothing about it, which was wrong
// twice: it listed moments shorter than minDuration that the sidebar does NOT show (the
// notes and the app disagreeing about which moments exist), and it dropped rejected ones
// silently, so a creator asking "did it miss my pen stroke?" got a shorter list instead of
// an answer. Now every moment is listed and says for itself which side of the line it is on.
export function hiddenReason(a: Activity, minDuration: number): string | null {
  if (!a.isValid) return "size outside the range the analyzer accepts";
  if (a.end - a.start < minDuration) return `shorter than the ${minDuration}s minimum`;
  return null;
}

// The Markdown export: a scene-grouped, timestamped index of every moment, with long
// moment-free stretches called out. Text is the one rendering of this data a screen
// reader, a text editor, and a diff all read natively.
export function momentsMarkdown(f: MomentsFile): string {
  const { meta } = f;
  const acts = [...f.activities].sort((a, b) => a.start - b.start);
  // An untrusted sidecar may be missing params (parseMomentsFile does not require them),
  // so a hand-edited file must not crash the export it is being read for. No floor = the
  // analyzer's size verdict is the only filter, which is what a params-less file states.
  const minDuration = f.params?.minDuration ?? 0;
  const hiddenCount = acts.filter((a) => hiddenReason(a, minDuration)).length;
  const lines: string[] = [];
  lines.push(`# Moments — ${f.video.name}`);
  lines.push("");
  lines.push(
    `${acts.length - hiddenCount} moments · ` +
    (hiddenCount ? `${hiddenCount} found but not shown · ` : "") +
    `${f.scenes.length} scene${f.scenes.length === 1 ? "" : "s"} · ` +
    `${convertSecondsToTimecode(f.video.duration)} · analyzed ${f.savedAt.slice(0, 10)} by veasyguide (in-browser, video never uploaded)`
  );

  const sceneFor = (t: number): number => {
    let idx = 0;
    for (let i = 0; i < f.scenes.length; i++) if (f.scenes[i].start <= t) idx = i;
    return idx;
  };

  // Gaps are measured between SHOWN moments and named "no moments", not "no visual
  // activity": a rejected blip is still something the analyzer saw, so letting one close a
  // gap would claim the screen was busy when the viewer had nothing to follow, and calling
  // the stretch activity-free would contradict a not-shown entry printed inside it. Gaps
  // describe what the viewer gets; the not-shown entries say what was there anyway.
  //
  // Collected with their start time and sorted, not pushed as we go: a gap is only
  // discovered when the next shown moment arrives, so emitting it there printed it AFTER
  // the not-shown entries lying inside it — a document claiming "no moments 00:14–01:10"
  // below the two it just listed at 00:40 and 00:50. Every line goes where its timestamp
  // says, which is the only order a timeline can be read in.
  const gapLine = (from: number, to: number) =>
    `- _${convertSecondsToTimecode(from)}–${convertSecondsToTimecode(to)}: no moments (${Math.round(to - from)}s)_`;
  const entries: { t: number; line: string }[] = [];
  let lastEnd = 0;
  for (const a of acts) {
    const hidden = hiddenReason(a, minDuration);
    if (!hidden && a.start - lastEnd >= EXPORT_GAP_MIN) entries.push({ t: lastEnd, line: gapLine(lastEnd, a.start) });
    const entry = `**${convertSecondsToTimecode(a.start)}** (${(a.end - a.start).toFixed(1)}s) — ${momentDescription(a, meta.analysisWidth, meta.analysisHeight)}`;
    entries.push({ t: a.start, line: hidden ? `- _${entry} — not shown: ${hidden}_` : `- ${entry}` });
    if (!hidden) lastEnd = Math.max(lastEnd, a.end);
  }
  if (f.video.duration - lastEnd >= EXPORT_GAP_MIN) entries.push({ t: lastEnd, line: gapLine(lastEnd, f.video.duration) });
  entries.sort((x, y) => x.t - y.t);

  let lastScene = -1;
  for (const e of entries) {
    const s = sceneFor(e.t);
    if (s !== lastScene) {
      lastScene = s;
      lines.push("");
      lines.push(`## Scene ${s + 1} — from ${convertSecondsToTimecode(f.scenes[s]?.start ?? 0)}`);
      lines.push("");
    }
    lines.push(e.line);
  }
  lines.push("");
  return lines.join("\n");
}
