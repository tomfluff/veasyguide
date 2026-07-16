import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_PARAMS, type Activity, type AnalysisMeta, type AnalysisParams, type Box, type Range, type Scene, type WorkerMsg } from "./analyzer/types";
import { coverage, isAnalyzed } from "./analyzer/ranges";
import { validActivities } from "./analyzer/select";
import { thumbRect } from "./analyzer/snippets";
import { convertSecondsToTimecode } from "./utils/misc";
import type { SnippetOutMsg, SnippetReq } from "./analyzer/snippetWorker";
import VideoPlayer, { PLAYBACK_LEAD } from "./player/VideoPlayer";
import MomentsSidebar from "./MomentsSidebar";
import Landing from "./Landing";
import { TopBar, Footer } from "./Shell";
import { feedbackMailto } from "./feedback";
import About from "./About";
import ActivityGallery from "./ActivityGallery";
import "./App.css";

// Debug tooling is for us, and it is OFF unless asked for — in dev too, so that a dev
// run measures the same thing a production run does. `?debug=1` turns it on.
const QUERY = new URLSearchParams(location.search);
const DEBUG = QUERY.get("debug") === "1";

// Moments to accumulate before a snippet batch is worth a decode pass. Each batch costs one
// seek, so a batch per moment would be ~600 seeks on an hour-long lecture; a batch of 600 is
// the old behaviour, where nothing appears until the end. Batching is self-pacing above this
// floor: a pass takes a second or two, and whatever finalizes meanwhile becomes the next one.
const SNIPPET_BATCH_MIN = 10;
// Research mode: collect per-node region logs + show the activity gallery.
const RESEARCH = QUERY.get("research") === "1";
// Preset the gallery's snippet toggle (visual crops of each activity).
const SNIPPETS = QUERY.get("snippets") === "1";
// Force the CPU pipeline (`?cpu=1`) — the reference the GPU path is checked against.
const FORCE_CPU = QUERY.get("cpu") === "1";
// In-memory cap for stored analyzer frames (~25 KB each => ~150 MB worst case).
const MAX_DEBUG_FRAMES = 6000;

type DebugFrame = { t: number; blob: Blob; boxes: Box[] };
// One completed analysis run, for comparing the cost of the debug instrumentation.
type Run = { wallMs: number; xRealtime: number; capture: boolean; width: number; label: string };

type ParamField = {
  key: keyof AnalysisParams;
  label: string;
  step: number;
  what: string; // what it does, mechanically
  why: string; // why the heuristic exists + origin + tuning direction
};

// Pipeline-stage grouping: mirrors the order data flows through the analyzer.
const PARAM_GROUPS: { title: string; note: string; keys: (keyof AnalysisParams)[] }[] = [
  { title: "0 · Webcam pre-pass", note: "find the talking-head inset before analysis; drop detections inside it", keys: ["webcamPairFrac"] },
  { title: "1 · Sampling", note: "which pixels the analyzer looks at", keys: ["analysisWidth", "sampleInterval"] },
  { title: "2 · Change detection", note: "frame pair → changed regions (red mask / green boxes / blue = habitually moving)", keys: ["diffThresh", "dilateIters", "contourAreaLowFrac", "contourAreaHighFrac", "persistFrac"] },
  { title: "3 · Scene detection", note: "slide changes / cuts — activities never span one", keys: ["sceneChangeFrac", "sceneMinLen"] },
  { title: "4 · Clustering", note: "regions over time → activities", keys: ["spanTh", "distRatio"] },
  { title: "5 · Filtering & display", note: "which activities the player shows, and when", keys: ["persistInvalidFrac", "minSizeFrac", "maxSizeFrac", "minDuration", "highlightLead", "highlightLinger"] },
];

const PARAM_FIELDS: ParamField[] = [
  {
    key: "webcamPairFrac", label: "Webcam churn (frac of pairs)", step: 0.05,
    what: "Before analysis, ~24 frames are sampled minutes apart and diffed pairwise. A pixel that changed in at least this fraction of the pairs counts as permanently churning; the compact blob of such pixels becomes the webcam zone, and detections mostly inside it are dropped before clustering.",
    why: "A person in an inset has always moved between two frames minutes apart, so webcam pixels churn in ~every pair; slide pixels change only across slide turns and ink only in the pairs that straddle its writing — the distributions barely overlap. The per-pixel occupancy veto alone missed the inset's rim (silhouette edges change too rarely per-pixel): measured on a 59-min lecture, 171 of 602 valid moments were the webcam. A frame-scale churn blob (camera video of an instructor at a board) is deliberately NOT called a webcam — see the area cap in pipeline.webcamZone. Lower = more aggressive (risks capturing a region the instructor reworks constantly); higher = a sleepy talking head slips through.",
  },
  {
    key: "analysisWidth", label: "Analysis width (px)", step: 40,
    what: "Frames are downscaled to this width before any pixel work; detected coordinates are scaled back up for the overlays.",
    why: "Pixel-op cost scales with area, and slide content is coarse enough to survive downscaling — 480p is ~4× cheaper than 720p. The Python analyzer ran at native resolution, so set this to the video's width to reproduce it exactly. Lower = faster but thin pen strokes (1–2 px) can vanish.",
  },
  {
    key: "sampleInterval", label: "Sample interval (s)", step: 0.05,
    what: "Consecutive sampled frames this far apart in time are compared; each comparison can yield detection nodes.",
    why: "Adjacent frames (~33 ms) differ too little to segment — comparing across 200 ms accumulates enough change to see a pen stroke, and cuts the work ~6×. Study value: sample_fps_ratio=0.2. Lower = finer timing, more compute; higher = brief pointing gestures fall between samples.",
  },
  {
    key: "diffThresh", label: "Diff threshold", step: 1,
    what: "Minimum grayscale change (0–255) for a pixel to count as 'changed' between the two compared frames.",
    why: "Video compression makes pixels wiggle a few units even in perfectly static regions; 25 sits above codec noise while ink-on-slide changes are high-contrast and clear it easily. Python: threshold(blur, 25). Lower = more sensitive but noise blobs appear; higher = faint cursors and low-contrast marks are missed.",
  },
  {
    key: "dilateIters", label: "Dilate iterations", step: 1,
    what: "Grows the changed-pixel mask outward ~1 px per pass before regions are extracted.",
    why: "One pen stroke fragments into disconnected specks after thresholding; dilation glues them into a single region so it's detected as one node instead of ten. Python: cv2.dilate(iterations=3). More = distinct nearby events merge; fewer = fragments get dropped by the area filter.",
  },
  {
    key: "contourAreaLowFrac", label: "Min region area (frac)", step: 0.00005,
    what: "Changed regions smaller than this fraction of the frame area are discarded as noise.",
    why: "Residual compression shimmer survives thresholding as tiny blobs, while real activity (cursor, text) is bigger. 0.00015 of 720p ≈ a 12×12 px blob. Python: contour_area_low. Lower = keeps tiny marks (dots on i's) plus more noise; higher = small pointer movements disappear.",
  },
  {
    key: "contourAreaHighFrac", label: "Max region area (frac)", step: 0.05,
    what: "Changed regions larger than this fraction of the frame area are discarded.",
    why: "A slide transition or scroll changes most of the frame at once — that's a scene change, not instructor activity, and without this cap it becomes one giant bogus 'activity'. Python: contour_area_high. Also the stand-in for scene detection until that lands (design Phase 1).",
  },
  {
    key: "persistFrac", label: "Structural-motion cutoff", step: 0.05,
    what: "Each pixel carries a running estimate of how often it changes (blue in the debug composite). A detected region whose pixels average this much or more is flagged as structural motion rather than instructor activity.",
    why: "A talking-head webcam overlay never stops moving, so its pixels churn through the whole video; ink is written once and then sits still, so its pixels average near 0.05. That gap is the signal. The flag doesn't hide the region on its own — it feeds the per-activity vote below. Lower = flags more (eventually catching a region the instructor works in continuously); higher = the webcam stops being flagged.",
  },
  {
    key: "sceneChangeFrac", label: "Scene change (frac of frame)", step: 0.01,
    what: "A scene cut is declared when this share of the frame changes between two sampled frames. The cut's own frame pair produces no detection nodes, and any open activities are closed at the boundary.",
    why: "A slide change replaces the whole frame — treating that as instructor activity would produce one giant bogus highlight, and an activity must never span two slides. This replaced a port of PySceneDetect's ContentDetector (mean HSV delta per pixel), which cannot see a slide change on a deck with a consistent style: the background and layout are pixel-identical between slides, so only the text moves and the mean washes it out. Measured on a 59-minute lecture, every slide change scored under 2.5 against a threshold of 27 and none was caught. Counting changed pixels separates the same footage cleanly — writing and webcam under 2%, slide changes 20–30%, hard cuts over 70%. Lower = more cuts (a big build animation may split a slide); higher = slide changes get missed and leak into activities.",
  },
  {
    key: "sceneMinLen", label: "Min scene length (s)", step: 0.5,
    what: "Debounce: no second cut is allowed until this long after the previous one.",
    why: "A slide transition (fade, wipe, build animation) crosses the threshold on several consecutive samples and would otherwise register as a burst of cuts. Not in the Python version — it detected on every frame, where transitions are handled by ContentDetector's own internals; at our coarser sampling an explicit debounce is the simpler equivalent.",
  },
  {
    key: "spanTh", label: "Link time gap (s)", step: 0.1,
    what: "Two detection nodes can belong to the same activity only if they occur within this many seconds of each other. Also sets finalization lag: an activity is emitted once analysis passes this far beyond its last node.",
    why: "Writing pauses — the pen lifts between words — and 1 s bridges those pauses without chaining unrelated events. Study value: roi_timespan_th=1.0 (code default was 1.5). Higher = longer merged activities and more delay before they appear; lower = one gesture splits into several activities.",
  },
  {
    key: "distRatio", label: "Link distance (frac diag)", step: 0.005,
    what: "Max spatial gap between two nodes' boxes (as a fraction of the frame diagonal) for them to link into one activity.",
    why: "Consecutive strokes of one annotation land near each other; unrelated activities happen across the slide. 5% of the diagonal ≈ 73 px at 720p. Python: roi_distance_ratio, node-to-node edges. Higher = neighboring distinct activities merge; lower = a fast-moving pointer splits into pieces.",
  },
  {
    key: "persistInvalidFrac", label: "Structural-motion veto (frac)", step: 0.05,
    what: "Validity heuristic: an activity with at least this share of its nodes flagged as structural motion (see the cutoff in stage 2) is marked invalid — hidden and never highlighted. 1 = off.",
    why: "The per-activity vote is what actually keeps the highlight off a talking head. A webcam's activity is ~100% flagged nodes; a real activity that merely happens near the webcam picks up only a few, and survives. Judging whole activities rather than deleting pixels is what makes this robust to a person who moves: an overlay's edge pixels are individually ambiguous, but an activity built almost entirely out of them is not. Lower = more aggressive (a real activity overlapping the webcam gets vetoed too); higher = a webcam activity with a few stray nodes elsewhere sneaks through.",
  },
  {
    key: "minSizeFrac", label: "Min activity size (frac)", step: 0.005,
    what: "Validity heuristic: a finished activity's width AND height must each be at least this fraction of the frame's, else it's flagged invalid (hidden, not deleted — see the valid/total count).",
    why: "An activity under ~1% of the frame is usually noise that survived clustering, and too small to usefully highlight or zoom into. Python: roi_area_low in RoIActivity._is_valid.",
  },
  {
    key: "maxSizeFrac", label: "Max activity size (frac)", step: 0.05,
    what: "Validity heuristic: activity width/height must each be at most this fraction of the frame's.",
    why: "Something spanning >70% of the frame is a scene-level change (scroll, transition, camera move) — highlighting it is meaningless and magnifying it is impossible. Python: roi_area_high in RoIActivity._is_valid.",
  },
  {
    key: "minDuration", label: "Min duration (s)", step: 0.1,
    what: "Display filter only (no re-analysis): activities shorter than this are hidden from the player overlays.",
    why: "Sub-second blips — a stray cursor flick — can distract more than help when highlighted. This comes from the player, not the analyzer: the study player filtered by duration ('atLeast', up to 1.5 s in some modes) when choosing what to highlight.",
  },
  {
    key: "highlightLead", label: "Highlight lead (s)", step: 0.1,
    what: "Pre-activity cue (display only): the highlight appears this many seconds before the activity starts — but a currently-active activity always takes precedence, so the early cue only shows when nothing else is highlighted.",
    why: "A low-vision viewer needs time to orient their gaze before the action happens; cueing at activity start means the beginning is always missed. Study player: padding[0]=1.0 s in normal mode. Higher = more anticipation but the highlight sits on 'nothing happening yet' longer.",
  },
  {
    key: "highlightLinger", label: "Highlight linger (s)", step: 0.1,
    what: "Display only: the highlight stays this many seconds after the activity ends.",
    why: "Dropping the highlight the instant motion stops feels abrupt and yanks attention away from what was just drawn — the result of the activity is usually what the viewer wants to read. Study player: padding[1]=0.5 s.",
  },
];

// The wait before the video is even readable — container parse, codec check, duration. Usually
// under a second, but it is the first thing that happens after someone hands over their file, so
// a bare line of grey text saying "Starting worker…" is a poor first impression AND a layout bug:
// it occupies no space, so the player pops in and shoves the page down when meta arrives. This
// holds the player's exact 16:9 box from the start.
function Preparing({ stage, fileName, onCancel }: {
  stage: string | null;
  fileName: string | null;
  onCancel: () => void;
}) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setLate(true), 15000);
    return () => clearTimeout(id);
  }, []);

  return (
    <div className="preparing" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <div className="preparing-stage">{stage ?? "Getting ready…"}</div>
      {fileName && <div className="preparing-file">{fileName}</div>}

      {/* If the read phase never finishes, say so — and give a way out. This used to tell a
          VIEWER to check the browser console, stop their dev servers and delete
          node_modules/.vite: our debugging notes, shipped to the person least able to act on
          them. The dev hint still exists, behind ?debug=1, for us. */}
      {late && (
        <div className="preparing-late">
          <p>
            This is taking longer than usual. Very large files can be slow to open — but if
            nothing happens, the file may be damaged or in a format this browser can't read.
          </p>
          <button type="button" onClick={onCancel}>Try another video</button>
          {DEBUG && (
            <p className="preparing-devhint">
              Dev: the worker may have failed to start — check the console. Two dev servers
              running can break it; stop all but one and delete <code>node_modules/.vite</code>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  // Lets debug UI (analyzer view, scene strip) seek the player's video element.
  const seekFnRef = useRef<(t: number) => void>(() => {});
  const debugCanvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const snipRef = useRef<Worker | null>(null);
  const snipDoneRef = useRef<Set<number>>(new Set()); // moments already handed to the snippet worker
  const snipBusyRef = useRef(false);
  const [snipTick, setSnipTick] = useState(0);
  const activitiesRef = useRef<Activity[]>([]);
  const framesRef = useRef<DebugFrame[]>([]); // all analyzer-view frames (debug; in-memory only)
  const framesBytesRef = useRef(0);
  const followRef = useRef(true); // scrubber follows the analysis frontier until user scrubs
  const lastDrawRef = useRef(0);
  const fileRef = useRef<File | null>(null);

  const [params, setParams] = useState<AnalysisParams>(DEFAULT_PARAMS);
  const [showParams, setShowParams] = useState(false);
  const [infoKey, setInfoKey] = useState<keyof AnalysisParams | null>(null);
  // Frame capture is the expensive half of debug (WebP-encodes every sample). Kept
  // separately toggleable so its cost can be measured against the same run without it.
  const [capture, setCapture] = useState(DEBUG);
  const [runs, setRuns] = useState<Run[]>([]);
  const captureRef = useRef(DEBUG);
  const [meta, setMeta] = useState<AnalysisMeta | null>(null);
  const [analyzedUpTo, setAnalyzedUpTo] = useState(0);
  const [xRealtime, setXRealtime] = useState(0);
  const [activityCount, setActivityCount] = useState(0);
  const [validCount, setValidCount] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null); // pre-analysis read progress
  const [currentTime, setCurrentTime] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  // Webcam pre-pass verdict (zone is analysis-res px; url is the debug heatmap).
  const [webcam, setWebcam] = useState<{ zone: Box | null; wallMs: number; sampled: number; url: string | null } | null>(null);
  const [ranges, setRanges] = useState<Range[]>([]);
  const [openClusters, setOpenClusters] = useState(0);
  const [framesCount, setFramesCount] = useState(0);
  const [viewIdx, setViewIdx] = useState(-1); // -1 = follow the frontier
  // Sidebar state: which moment the player is highlighting, and each moment's thumbnail.
  const [currMoment, setCurrMoment] = useState<Activity | null>(null);
  const [thumbs, setThumbs] = useState<ReadonlyMap<number, string>>(new Map());
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);

  // Draw a stored analyzer frame (composite + its node boxes + timestamp) to the canvas.
  async function renderDebugFrame(i: number) {
    const f = framesRef.current[i];
    const c = debugCanvasRef.current;
    if (!f || !c) return;
    const bmp = await createImageBitmap(f.blob);
    if (c.width !== bmp.width) { c.width = bmp.width; c.height = bmp.height; }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    ctx.strokeStyle = "#00e676";
    ctx.lineWidth = 1.5;
    for (const b of f.boxes) ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = "#fff";
    ctx.font = "12px monospace";
    ctx.fillText(`${f.t.toFixed(2)}s · ${f.boxes.length} nodes`, 6, 14);
  }

  const canPlay = done || analyzedUpTo >= PLAYBACK_LEAD;

  function analyze(file: File, p: AnalysisParams, cap = captureRef.current) {
    workerRef.current?.terminate();
    captureRef.current = cap;
    fileRef.current = file;
    activitiesRef.current = [];
    framesRef.current = [];
    framesBytesRef.current = 0;
    followRef.current = true;
    setMeta(null); setAnalyzedUpTo(0); setXRealtime(0); setActivityCount(0); setValidCount(0);
    setDone(false); setError(null); setOpenClusters(0);
    setFramesCount(0); setViewIdx(-1); setScenes([]); setRanges([]);
    setWebcam((old) => { if (old?.url) URL.revokeObjectURL(old.url); return null; });
    setCurrMoment(null);
    setErrorDismissed(false);
    setThumbs((old) => { old.forEach((u) => URL.revokeObjectURL(u)); return new Map(); });
    setStage("Getting ready…");

    const worker = new Worker(new URL("./analyzer/worker.ts", import.meta.url), { type: "module" });
    // Without these, a worker that fails to load or throws outside our try/catch dies
    // silently and the UI waits forever for a `meta` that will never arrive.
    worker.onerror = (e) => {
      setError(
        `The analysis worker failed to start${e.message ? `: ${e.message}` : "."} ` +
          `If you are running two dev servers, stop one and restart (a shared Vite cache can break the worker).`
      );
      setStage(null);
    };
    worker.onmessageerror = () => setError("The analysis worker sent a message that could not be read.");
    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const m = e.data;
      if (m.type === "status") setStage(m.stage);
      else if (m.type === "meta") { setStage(null); setMeta(m.meta); }
      else if (m.type === "activity") {
        // Insert in start order. Segments emit chronologically, but a backfill segment
        // (started by a seek) emits earlier moments after later ones — and everything
        // downstream (markers, stepping, the sidebar) assumes the list is sorted.
        const list = activitiesRef.current;
        let i = list.length;
        while (i > 0 && list[i - 1].start > m.activity.start) i--;
        list.splice(i, 0, m.activity);
        setActivityCount((c) => c + 1);
        if (m.activity.isValid) setValidCount((c) => c + 1);
      } else if (m.type === "scenes") { setScenes(m.scenes); }
      else if (m.type === "webcam") {
        const blob = m.blob;
        setWebcam((old) => {
          if (old?.url) URL.revokeObjectURL(old.url);
          return { zone: m.zone, wallMs: m.wallMs, sampled: m.sampled, url: blob ? URL.createObjectURL(blob) : null };
        });
      }
      else if (m.type === "progress") { setAnalyzedUpTo(m.analyzedUpTo); setXRealtime(m.xRealtime); setOpenClusters(m.openClusters); setRanges(m.ranges); }
      else if (m.type === "done") {
        setDone(true); setXRealtime(m.xRealtime); setAnalyzedUpTo(Infinity); setRanges(m.ranges);
        setRuns((rs) => [...rs, {
          wallMs: m.wallMs, xRealtime: m.xRealtime, capture: cap, width: p.analysisWidth,
          label: `${cap ? "debug frames" : "no capture"} @ ${p.analysisWidth}px`,
        }]);
      }
      else if (m.type === "error") { setError(m.message); setStage(null); }
      else if (m.type === "debugFrame") {
        if (framesRef.current.length < MAX_DEBUG_FRAMES) {
          framesRef.current.push({ t: m.t, blob: m.blob, boxes: m.boxes });
          framesBytesRef.current += m.blob.size;
          setFramesCount(framesRef.current.length);
        }
        // While following, live-draw the frontier (throttled to ~15 fps of wall time).
        if (followRef.current && performance.now() - lastDrawRef.current > 66) {
          lastDrawRef.current = performance.now();
          void renderDebugFrame(framesRef.current.length - 1);
        }
      }
    };
    worker.postMessage({ type: "start", file, params: p, debug: cap, collectNodes: RESEARCH, forceCpu: FORCE_CPU });
    workerRef.current = worker;
  }

  function loadFile(file: File) {
    setCurrentTime(0);
    setFileName(file.name);
    setVideoUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(file); });
    analyze(file, params);
  }

  function reanalyze(cap = captureRef.current) {
    if (fileRef.current) analyze(fileRef.current, params, cap);
  }

  // Back to the landing screen — the way out of a stuck read. The worker must be terminated,
  // not just forgotten: it may still be grinding through a file we are done with, and the next
  // analyze() would leave two of them competing for the decoder.
  function reset() {
    workerRef.current?.terminate();
    workerRef.current = null;
    snipRef.current?.terminate();
    snipRef.current = null;
    snipDoneRef.current = new Set();
    snipBusyRef.current = false;
    fileRef.current = null;
    setVideoUrl((old) => { if (old) URL.revokeObjectURL(old); return null; });
    setThumbs((old) => { old.forEach((u) => URL.revokeObjectURL(u)); return new Map(); });
    setFileName(null);
    setMeta(null);
    setStage(null);
    setError(null);
  }

  // Dev-only auto-load for headless smoke tests: ?test=<name> fetches public/_test/<name>.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const name = new URLSearchParams(location.search).get("test");
    if (!name) return;
    fetch(`/_test/${name}`)
      .then((r) => r.blob())
      .then((b) => loadFile(new File([b], name, { type: b.type || "video/mp4" })))
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seeking somewhere unanalyzed: tell the worker to abandon what it's doing and
  // analyze from here, so the viewer's position always wins.
  function onSeeked(t: number) {
    if (done || !workerRef.current) return;
    if (!isAnalyzed(ranges, t)) {
      workerRef.current.postMessage({ type: "seek", t });
    }
  }

  // The player reports time per presented frame (rVFC); throttle App re-renders,
  // which only feed the HUD.
  const lastTimeRef = useRef(-1);
  function onTimeChange(t: number) {
    if (Math.abs(t - lastTimeRef.current) < 0.2) return;
    lastTimeRef.current = t;
    setCurrentTime(t);
  }

  // The moments, filtered and sorted, computed ONCE and shared. This lives in App rather than
  // in VideoPlayer because the moments sidebar will mount here, beside the player, and both
  // must agree about which moments exist and what number each one has.
  //
  // `activitiesRef` is a ref that the worker appends to in place, so its identity never
  // changes and it can never be a memo key. `activityCount` is the state that does change on
  // every append — that is what makes this recompute. (Key it on the ref and the list is
  // computed once, at mount, and stays empty forever.)
  const activities = useMemo(
    () => validActivities(activitiesRef.current, params.minDuration),
    [activityCount, params.minDuration]
  );

  // Debug console access to the raw activity list (valid AND invalid, with features), for
  // interrogating the analyzer's judgments on a real video without adding UI.
  if (DEBUG) {
    (window as unknown as { __dumpActivities?: () => Activity[] }).__dumpActivities =
      () => activitiesRef.current;
  }

  const selectOpts = useMemo(
    () => ({ lead: params.highlightLead, linger: params.highlightLinger }),
    [params.highlightLead, params.highlightLinger]
  );

  // Sidebar thumbnails: one crop per moment (at its END — the finished annotation is what a
  // row must be recognized by). Open the file once, then feed the worker batches as moments
  // finalize, so rows fill in behind the analyzer instead of all at the end. On a 59-minute
  // lecture the old "wait for done" meant 602 numbered placeholders for the 14 minutes the
  // analysis ran — precisely when a table of contents is worth having.
  useEffect(() => {
    if (!meta || !fileRef.current) return;
    const worker = new Worker(new URL("./analyzer/snippetWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<SnippetOutMsg>) => {
      const m = e.data;
      if (m.type === "snippet") {
        const url = URL.createObjectURL(m.blob);
        setThumbs((prev) => new Map(prev).set(m.activityId, url));
      } else if (m.type === "batchDone") {
        if (DEBUG && m.count > 0) {
          console.log(`[snippets] +${m.count} crops, ${(m.bytes / 1024).toFixed(0)} KB, ${(m.wallMs / 1000).toFixed(1)}s`);
        }
        snipBusyRef.current = false;
        setSnipTick((n) => n + 1); // a batch finished — go see if more moments landed meanwhile
      } else if (m.type === "error") {
        snipBusyRef.current = false;
      }
    };
    worker.postMessage({ type: "open", file: fileRef.current });
    snipRef.current = worker;
    snipDoneRef.current = new Set();
    snipBusyRef.current = false;
    return () => { worker.terminate(); snipRef.current = null; };
  }, [meta]);

  // Hand the worker every moment it hasn't seen. One batch at a time: batches are what keep
  // this to one monotonic decode per contiguous stretch, and two in flight would interleave
  // seeks. Below the floor we wait for more rather than pay a seek per moment — unless
  // analysis is done, in which case this is the tail and there is nothing left to wait for.
  useEffect(() => {
    const worker = snipRef.current;
    if (!worker || !meta || snipBusyRef.current) return;
    const pending = validActivities(activitiesRef.current, 0).filter((a) => !snipDoneRef.current.has(a.id));
    if (pending.length === 0 || (!done && pending.length < SNIPPET_BATCH_MIN)) return;

    const reqs: SnippetReq[] = pending.map((a) => ({
      activityId: a.id,
      t: Math.max(0, Math.min(a.end, meta.duration - 0.05)),
      rect: thumbRect(a, meta),
    }));
    for (const a of pending) snipDoneRef.current.add(a.id);
    snipBusyRef.current = true;
    worker.postMessage({ type: "batch", reqs });
  }, [activityCount, done, meta, snipTick]);

  const progressPct = meta ? coverage(ranges, meta.duration) * 100 : 0;

  // Fatal vs partial. Fatal = it broke before there was ever anything to watch (bad codec,
  // unreadable container, worker refused to start) — there is no player to put a message in,
  // so the landing screen takes it back. Partial = analysis died part-way through a video that
  // plays fine; that is mostly a SUCCESS and must not read like a crash, so the player stays
  // and says what still works.
  const fatal = error !== null && meta === null;
  const partial = error !== null && meta !== null;
  // How far the analysis actually got — the end of the last analyzed range, which is the
  // honest thing to name in the strip.
  const lastAnalyzed = ranges.length > 0 ? ranges[ranges.length - 1].end : 0;

  // What the top bar says about the analysis. This is the ONLY analyzer status a viewer gets,
  // and it is deliberately about their lecture ("141 moments") rather than about our pipeline
  // ("21.8× realtime, 480×270, 8 scenes") — the number they can act on, not the one we tune on.
  const chip = videoUrl && !fatal && (
    <span className={done ? "chip ready" : "chip"} role="status">
      <span className="chip-dot" />
      {done
        ? `${activities.length} moment${activities.length === 1 ? "" : "s"}`
        : `Finding moments… ${progressPct.toFixed(0)}%`}
    </span>
  );

  // The feedback email's diagnostics: what a bug report always needs and never includes.
  // Composed fresh each render — it carries live analysis numbers.
  const feedbackHref = feedbackMailto({
    fileName,
    duration: meta?.duration,
    videoWidth: meta?.videoWidth,
    videoHeight: meta?.videoHeight,
    validMoments: activities.length,
    totalActivities: activityCount,
    scenes: scenes.length,
    xRealtime,
    done,
  });

  return (
    <div className="shell">
      <TopBar
        file={videoUrl && !fatal ? fileName : null}
        status={chip}
        onAbout={() => setAboutOpen(true)}
      />
      <About open={aboutOpen} onClose={() => setAboutOpen(false)} feedbackHref={feedbackHref} />
      {/* The page grows a right-hand column once a video is up; before that the narrow
          reading width is right for the drop zone. */}
      <main className={videoUrl && !fatal ? "app with-side" : "app"}>

      {/* A fatal error belongs ON the landing screen, beside the drop zone: whatever went
          wrong, the next thing the viewer wants is to try another file. */}
      {(!videoUrl || fatal) && <Landing onFile={loadFile} error={error} />}

      {videoUrl && !fatal && (
        <div className="stage-row">
        <div className="stage">
          {partial && !errorDismissed && (
            <div className="strip" role="status">
              <span>
                <b>Analysis stopped at {convertSecondsToTimecode(lastAnalyzed)}.</b>{" "}
                Everything before that still works — highlights and magnification simply stop
                past that point.
              </span>
              <button type="button" onClick={() => setErrorDismissed(true)} aria-label="Dismiss">
                ✕
              </button>
            </div>
          )}
          {meta ? (
            <VideoPlayer
              key={videoUrl}
              src={videoUrl}
              meta={meta}
              activities={activities}
              scenes={scenes}
              ranges={ranges}
              done={done}
              canPlay={canPlay}
              xRealtime={xRealtime}
              selectOpts={selectOpts}
              onSeeked={onSeeked}
              onTimeChange={onTimeChange}
              onActivityChange={setCurrMoment}
              thumbs={thumbs}
              seekFnRef={seekFnRef}
            />
          ) : error ? null : (
            <Preparing stage={stage} fileName={fileName} onCancel={reset} />
          )}

          {/* The analyzer readout is instrumentation, not product. It shipped to every viewer:
              "21.8× realtime · 141 valid / 192 activities · playhead 1734.0s" tells a learner
              nothing and makes the app look like a lab harness. Behind ?debug=1 with the rest
              of the tooling now; the status a viewer actually needs is the chip in the top bar. */}
          {DEBUG && (
          <div className="hud">
            <div className={`meter ${xRealtime >= 4 ? "ok" : xRealtime >= 2 ? "warn" : "bad"}`}>
              {done ? "done" : "analyzing"} · <b>{xRealtime.toFixed(1)}×</b> realtime
            </div>
            {/* Analyzed coverage — segments, not a single frontier (a seek starts a new one). */}
            <div className="bar">
              {meta && ranges.map((r, i) => (
                <div key={i} className="fill" style={{
                  left: `${(r.start / meta.duration) * 100}%`,
                  width: `${((r.end - r.start) / meta.duration) * 100}%`,
                }} />
              ))}
              {meta && (
                <div className="playhead" style={{ left: `${(currentTime / meta.duration) * 100}%` }} />
              )}
            </div>
            <div className="stats">
              {meta ? `${meta.videoWidth}×${meta.videoHeight} → ${meta.analysisWidth}×${meta.analysisHeight}` : "…"}
              {" · "}{validCount} valid / {activityCount} activities · {scenes.length} scene{scenes.length === 1 ? "" : "s"}
              {" · analyzed "}{progressPct.toFixed(0)}%{" · playhead "}{currentTime.toFixed(1)}s
            </div>
          </div>
          )}

          {DEBUG && (
          <div className="params">
            <button type="button" onClick={() => setShowParams((s) => !s)}>
              {showParams ? "▾" : "▸"} Analysis parameters
            </button>
            {showParams && (
              <>
                {PARAM_GROUPS.map((group) => (
                  <div className="param-group" key={group.title}>
                    <h3>{group.title} <small>{group.note}</small></h3>
                    <div className="param-grid">
                      {group.keys.map((key) => {
                        const f = PARAM_FIELDS.find((f) => f.key === key)!;
                        return (
                          <div className="param-field" key={key}>
                            <button
                              type="button"
                              className={`info-btn ${infoKey === key ? "active" : ""}`}
                              title={f.what}
                              aria-label={`About ${f.label}`}
                              onClick={() => setInfoKey((k) => (k === key ? null : key))}
                            >
                              ⓘ
                            </button>
                            <label>
                              <span>{f.label}</span>
                              <input
                                type="number"
                                step={f.step}
                                value={params[key]}
                                onChange={(e) => setParams((p) => ({ ...p, [key]: Number(e.target.value) }))}
                              />
                            </label>
                          </div>
                        );
                      })}
                    </div>
                    {infoKey && group.keys.includes(infoKey) && (() => {
                      const f = PARAM_FIELDS.find((f) => f.key === infoKey)!;
                      return (
                        <div className="param-info">
                          <b>{f.label}</b>
                          <p><b>What it does:</b> {f.what}</p>
                          <p><b>Why it exists:</b> {f.why}</p>
                        </div>
                      );
                    })()}
                  </div>
                ))}
                <div className="param-actions">
                  <button type="button" className="primary" onClick={() => reanalyze()}>Re-analyze</button>
                  <button type="button" onClick={() => setParams(DEFAULT_PARAMS)}>Reset to defaults</button>
                  <label className="capture-toggle" title="WebP-encodes every sampled frame for the analyzer view — the expensive half of debug mode.">
                    <input type="checkbox" checked={capture}
                      onChange={(e) => { setCapture(e.target.checked); reanalyze(e.target.checked); }} />
                    capture analyzer frames
                  </label>
                  <small>Duration, lead and linger apply live; the rest need Re-analyze.</small>
                </div>

                {runs.length > 0 && (
                  <table className="runs">
                    <thead><tr><th>run</th><th>wall</th><th>×realtime</th><th>vs. no-capture</th></tr></thead>
                    <tbody>
                      {runs.map((r, i) => {
                        const base = runs.find((x) => !x.capture && x.width === r.width);
                        const delta = base && base !== r ? (r.wallMs / base.wallMs - 1) * 100 : null;
                        return (
                          <tr key={i}>
                            <td>{r.label}</td>
                            <td>{(r.wallMs / 1000).toFixed(2)}s</td>
                            <td>{r.xRealtime.toFixed(1)}×</td>
                            <td>{delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(0)}%`}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </div>
          )}
        </div>

        {/* Mounted from the first frame, not from `meta` — it already has a "Looking…" state,
            and the column is reserved either way. Waiting for meta left a white void beside the
            preparing card, which is the same layout jump the card exists to prevent. */}
        <MomentsSidebar
          activities={activities}
          scenes={scenes}
          thumbs={thumbs}
          current={currMoment}
          done={done}
          canPlay={canPlay}
          lead={params.highlightLead}
          onJump={(t) => seekFnRef.current(t)}
        />
        </div>
      )}

      {RESEARCH && meta && videoUrl && fileRef.current && (
        <ActivityGallery
          key={videoUrl}
          activitiesRef={activitiesRef}
          version={activityCount}
          analysisDone={done}
          meta={meta}
          file={fileRef.current}
          videoUrl={videoUrl}
          params={params}
          collectNodes={RESEARCH}
          snippetsDefault={SNIPPETS}
          seekTo={(t) => seekFnRef.current(t)}
        />
      )}

      {DEBUG && webcam && (
        <div className="debug">
          <h2>Webcam pre-pass</h2>
          <p className="webcam-line">
            {webcam.zone
              ? `zone ${webcam.zone.x},${webcam.zone.y} ${webcam.zone.w}×${webcam.zone.h}` +
                (meta ? ` (${(((webcam.zone.w * webcam.zone.h) / (meta.analysisWidth * meta.analysisHeight)) * 100).toFixed(1)}% of frame)` : "")
              : "no webcam overlay detected"}
            {` · ${webcam.sampled} frames in ${(webcam.wallMs / 1000).toFixed(1)}s`}
          </p>
          {webcam.url && (
            // The churn heatmap: black = never changed across the sparse pairs, red -> yellow =
            // changed in more of them. The green outline is the extracted zone.
            <img className="webcam-heat" src={webcam.url} alt="Webcam churn heatmap" />
          )}
        </div>
      )}

      {DEBUG && capture && (
        <div className="debug">
          <h2>
            Analyzer view
            {viewIdx >= 0
              ? ` — sample ${viewIdx + 1}/${framesCount} (scrubbed)`
              : done ? " — end (drag to scrub)" : " — following frontier"}
          </h2>
          <canvas
            ref={debugCanvasRef}
            width={480}
            height={270}
            title="Click to seek the video to this sample"
            onClick={() => {
              const i = viewIdx >= 0 ? viewIdx : framesCount - 1;
              const f = framesRef.current[i];
              if (f) seekFnRef.current(f.t);
            }}
          />
          <input
            className="debug-scrub"
            type="range"
            min={0}
            max={Math.max(0, framesCount - 1)}
            value={viewIdx >= 0 ? viewIdx : Math.max(0, framesCount - 1)}
            onChange={(e) => {
              const i = Number(e.target.value);
              followRef.current = false;
              setViewIdx(i);
              void renderDebugFrame(i);
            }}
          />
          {meta && scenes.length > 0 && (
            <div className="scene-strip" title="Scene cuts — click to seek">
              {scenes.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="scene-seg"
                  style={{
                    left: `${(s.start / meta.duration) * 100}%`,
                    width: `${((s.end - s.start) / meta.duration) * 100}%`,
                  }}
                  title={`Scene ${s.id + 1}: ${s.start.toFixed(1)}s – ${s.end.toFixed(1)}s`}
                  onClick={() => seekFnRef.current(s.start)}
                >
                  {s.id + 1}
                </button>
              ))}
            </div>
          )}
          <div className="debug-legend">
            <span><i className="sw red" /> diff mask (post-dilate)</span>
            <span><i className="sw green" /> node boxes (this sample)</span>
            <span>{openClusters} open clusters</span>
            <span>{framesCount}{framesCount >= MAX_DEBUG_FRAMES ? " (capped)" : ""} frames · {(framesBytesRef.current / 1048576).toFixed(1)} MB in memory (cleared on refresh)</span>
            {viewIdx >= 0 && (
              <button type="button" onClick={() => { followRef.current = true; setViewIdx(-1); void renderDebugFrame(framesRef.current.length - 1); }}>
                {done ? "jump to end" : "follow frontier"}
              </button>
            )}
          </div>
        </div>
      )}

      </main>
      <Footer feedbackHref={feedbackHref} />
    </div>
  );
}
