import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_PARAMS, type Activity, type AnalysisMeta, type AnalysisParams, type Box, type Range, type Scene, type WorkerMsg } from "./analyzer/types";
import { coverage, isAnalyzed } from "./analyzer/ranges";
import VideoPlayer from "./player/VideoPlayer";
import ActivityGallery from "./ActivityGallery";
import "./App.css";

const PLAYBACK_LEAD = 10; // seconds analyzed before playback unlocks

// Debug tooling is for us, and it is OFF unless asked for — in dev too, so that a dev
// run measures the same thing a production run does. `?debug=1` turns it on.
const QUERY = new URLSearchParams(location.search);
const DEBUG = QUERY.get("debug") === "1";
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
  { title: "1 · Sampling", note: "which pixels the analyzer looks at", keys: ["analysisWidth", "sampleInterval"] },
  { title: "2 · Change detection", note: "frame pair → changed regions (red mask / green boxes / blue = habitually moving)", keys: ["diffThresh", "dilateIters", "contourAreaLowFrac", "contourAreaHighFrac", "persistFrac"] },
  { title: "3 · Scene detection", note: "slide changes / cuts — activities never span one", keys: ["sceneThreshold", "sceneMinLen"] },
  { title: "4 · Clustering", note: "regions over time → activities", keys: ["spanTh", "distRatio"] },
  { title: "5 · Filtering & display", note: "which activities the player shows, and when", keys: ["persistInvalidFrac", "minSizeFrac", "maxSizeFrac", "minDuration", "highlightLead", "highlightLinger"] },
];

const PARAM_FIELDS: ParamField[] = [
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
    key: "sceneThreshold", label: "Scene threshold", step: 1,
    what: "A scene cut is declared when the HSV content score between two sampled frames (mean hue+saturation+luma change, 0–255) reaches this value. The cut's own frame pair produces no detection nodes, and any open activities are closed at the boundary.",
    why: "A slide change alters the whole frame — treating that as instructor activity would produce one giant bogus highlight, and an activity must never span two slides. Ports PySceneDetect's ContentDetector, which the Python analyzer used at threshold 14 — but it scored every adjacent frame (~33 ms apart) while we compare frames one sample interval apart, so more change accumulates and our score runs higher; hence the higher default. Lower = more cuts (a big animation may split a slide); higher = slide changes get missed and leak into activities.",
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

// If the read phase never completes, say so instead of spinning forever.
function Watchdog({ active }: { active: boolean }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) return;
    const id = setTimeout(() => setLate(true), 15000);
    return () => clearTimeout(id);
  }, [active]);
  if (!late) return null;
  return (
    <div className="watchdog">
      This is taking longer than expected. The analysis worker may have failed to start —
      check the browser console. If you have more than one dev server running, stop all of
      them, delete <code>node_modules/.vite</code>, and start a single one.
    </div>
  );
}

export default function App() {
  // Lets debug UI (analyzer view, scene strip) seek the player's video element.
  const seekFnRef = useRef<(t: number) => void>(() => {});
  const debugCanvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
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
  const [ranges, setRanges] = useState<Range[]>([]);
  const [openClusters, setOpenClusters] = useState(0);
  const [framesCount, setFramesCount] = useState(0);
  const [viewIdx, setViewIdx] = useState(-1); // -1 = follow the frontier

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
    setStage("Starting worker…");

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
        activitiesRef.current.push(m.activity);
        setActivityCount((c) => c + 1);
        if (m.activity.isValid) setValidCount((c) => c + 1);
      } else if (m.type === "scene") { setScenes((s) => [...s, m.scene]); }
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
    setVideoUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(file); });
    analyze(file, params);
  }

  function reanalyze(cap = captureRef.current) {
    if (fileRef.current) analyze(fileRef.current, params, cap);
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

  const selectOpts = useMemo(
    () => ({
      lead: params.highlightLead,
      linger: params.highlightLinger,
      minDuration: params.minDuration,
    }),
    [params.highlightLead, params.highlightLinger, params.minDuration]
  );

  const progressPct = meta ? coverage(ranges, meta.duration) * 100 : 0;

  return (
    <div className="app">
      <h1>veasyguide-app</h1>

      {!videoUrl && (
        <label className="drop">
          <input type="file" accept="video/*" hidden
            onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
          <span>⬇ Drop a lecture video or click to choose</span>
          <small>Analysis runs in your browser · MP4 / WebM / MKV</small>
        </label>
      )}

      {error && <div className="error">⚠ {error}</div>}

      {videoUrl && (
        <div className="stage">
          {meta ? (
            <VideoPlayer
              key={videoUrl}
              src={videoUrl}
              meta={meta}
              activitiesRef={activitiesRef}
              scenes={scenes}
              ranges={ranges}
              done={done}
              canPlay={canPlay}
              selectOpts={selectOpts}
              onSeeked={onSeeked}
              onTimeChange={onTimeChange}
              seekFnRef={seekFnRef}
            />
          ) : error ? null : (
            <div className="probing">
              <div>{stage ?? "Reading video…"}</div>
              <Watchdog active />
            </div>
          )}

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

    </div>
  );
}
