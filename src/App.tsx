import { useEffect, useRef, useState } from "react";
import { DEFAULT_PARAMS, type Activity, type AnalysisMeta, type AnalysisParams, type Box, type WorkerMsg } from "./analyzer/types";
import "./App.css";

const PLAYBACK_LEAD = 10; // seconds analyzed before playback unlocks

// Debug tooling is for us: always on in dev, ?debug=1 in production builds.
const DEBUG = import.meta.env.DEV || new URLSearchParams(location.search).get("debug") === "1";
// In-memory cap for stored analyzer frames (~25 KB each => ~150 MB worst case).
const MAX_DEBUG_FRAMES = 6000;

type DebugFrame = { t: number; blob: Blob; boxes: Box[] };

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
  { title: "2 · Change detection", note: "frame pair → changed regions (red mask / green boxes)", keys: ["diffThresh", "dilateIters", "contourAreaLowFrac", "contourAreaHighFrac"] },
  { title: "3 · Clustering", note: "regions over time → activities", keys: ["spanTh", "distRatio"] },
  { title: "4 · Filtering", note: "which activities the player shows", keys: ["minSizeFrac", "maxSizeFrac", "minDuration"] },
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
];

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const magCanvasRef = useRef<HTMLCanvasElement>(null);
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
  const [meta, setMeta] = useState<AnalysisMeta | null>(null);
  const [analyzedUpTo, setAnalyzedUpTo] = useState(0);
  const [xRealtime, setXRealtime] = useState(0);
  const [activityCount, setActivityCount] = useState(0);
  const [validCount, setValidCount] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<Activity | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [openClusters, setOpenClusters] = useState(0);
  const [framesCount, setFramesCount] = useState(0);
  const [viewIdx, setViewIdx] = useState(-1); // -1 = follow the frontier
  const [playheadNodes, setPlayheadNodes] = useState<Box[]>([]);

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

  function analyze(file: File, p: AnalysisParams) {
    workerRef.current?.terminate();
    fileRef.current = file;
    activitiesRef.current = [];
    framesRef.current = [];
    framesBytesRef.current = 0;
    followRef.current = true;
    setMeta(null); setAnalyzedUpTo(0); setXRealtime(0); setActivityCount(0); setValidCount(0);
    setDone(false); setError(null); setCurrent(null); setOpenClusters(0); setPlayheadNodes([]);
    setFramesCount(0); setViewIdx(-1);

    const worker = new Worker(new URL("./analyzer/worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const m = e.data;
      if (m.type === "meta") setMeta(m.meta);
      else if (m.type === "activity") {
        activitiesRef.current.push(m.activity);
        setActivityCount((c) => c + 1);
        if (m.activity.isValid) setValidCount((c) => c + 1);
      } else if (m.type === "progress") { setAnalyzedUpTo(m.analyzedUpTo); setXRealtime(m.xRealtime); setOpenClusters(m.openClusters); }
      else if (m.type === "done") { setDone(true); setXRealtime(m.xRealtime); setAnalyzedUpTo(Infinity); }
      else if (m.type === "error") setError(m.message);
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
    worker.postMessage({ type: "start", file, params: p, debug: DEBUG });
    workerRef.current = worker;
  }

  function loadFile(file: File) {
    setCurrentTime(0);
    setVideoUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(file); });
    analyze(file, params);
  }

  function reanalyze() {
    if (fileRef.current) analyze(fileRef.current, params);
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

  // Magnification-rate canvas blit — mirrors MagnificationOverlay's per-frame readback
  // cost so the Phase-0 measurement is honest.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current, c = magCanvasRef.current;
      if (v && c && !v.paused && v.videoWidth) {
        const ctx = c.getContext("2d");
        if (ctx) ctx.drawImage(v, 0, 0, c.width, c.height);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  function onTimeUpdate() {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    const t = v.currentTime;
    const hits = activitiesRef.current.filter(
      (a) => a.isValid && a.end - a.start >= params.minDuration && a.start - 1 <= t && a.end + 0.5 >= t
    );
    hits.sort((a, b) => a.start - b.start);
    setCurrent(hits[0] ?? null);
    if (DEBUG) {
      // Raw nodes detected near the playhead — what the pipeline saw, pre-clustering.
      setPlayheadNodes(
        framesRef.current.filter((s) => Math.abs(s.t - t) <= 0.6).flatMap((s) => s.boxes)
      );
    }
  }

  const progressPct = meta ? Math.min(100, (Math.min(analyzedUpTo, meta.duration) / meta.duration) * 100) : 0;

  return (
    <div className="app">
      <h1>veasyguide-app · Phase 0 spike</h1>

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
          <div className="video-wrap">
            <video ref={videoRef} src={videoUrl} controls={canPlay}
              onTimeUpdate={onTimeUpdate} style={{ width: "100%", display: "block" }} />
            {current && meta && (
              <div className="highlight" style={{
                left: `${(current.box.x / meta.analysisWidth) * 100}%`,
                top: `${(current.box.y / meta.analysisHeight) * 100}%`,
                width: `${(current.box.w / meta.analysisWidth) * 100}%`,
                height: `${(current.box.h / meta.analysisHeight) * 100}%`,
              }} />
            )}
            {DEBUG && meta && playheadNodes.map((b, i) => (
              <div key={i} className="node-box" style={{
                left: `${(b.x / meta.analysisWidth) * 100}%`,
                top: `${(b.y / meta.analysisHeight) * 100}%`,
                width: `${(b.w / meta.analysisWidth) * 100}%`,
                height: `${(b.h / meta.analysisHeight) * 100}%`,
              }} />
            ))}
            {!canPlay && <div className="gate">Analyzing… playback unlocks at {PLAYBACK_LEAD}s lead</div>}
          </div>

          <div className="hud">
            <div className={`meter ${xRealtime >= 4 ? "ok" : xRealtime >= 2 ? "warn" : "bad"}`}>
              {done ? "done" : "analyzing"} · <b>{xRealtime.toFixed(1)}×</b> realtime
            </div>
            <div className="bar"><div className="fill" style={{ width: `${progressPct}%` }} /></div>
            <div className="stats">
              {meta ? `${meta.videoWidth}×${meta.videoHeight} → ${meta.analysisWidth}×${meta.analysisHeight}` : "…"}
              {" · "}{validCount} valid / {activityCount} activities · analyzed {progressPct.toFixed(0)}%
              {" · playhead "}{currentTime.toFixed(1)}s
            </div>
          </div>

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
                  <button type="button" className="primary" onClick={reanalyze}>Re-analyze</button>
                  <button type="button" onClick={() => setParams(DEFAULT_PARAMS)}>Reset to defaults</button>
                  <small>Min duration filters display only (no re-analysis needed).</small>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {DEBUG && (
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
              if (f && videoRef.current) videoRef.current.currentTime = f.t;
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
          <div className="debug-legend">
            <span><i className="sw red" /> diff mask (post-dilate)</span>
            <span><i className="sw green" /> node boxes (this sample)</span>
            <span><i className="sw blue" /> raw nodes near playhead (on video)</span>
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

      <canvas ref={magCanvasRef} width={480} height={270} className="mag" />
    </div>
  );
}
