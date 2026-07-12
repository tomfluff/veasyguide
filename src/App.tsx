import { useEffect, useRef, useState } from "react";
import { DEFAULT_PARAMS, type Activity, type AnalysisMeta, type AnalysisParams, type Box, type WorkerMsg } from "./analyzer/types";
import "./App.css";

const PLAYBACK_LEAD = 10; // seconds analyzed before playback unlocks

// Debug tooling is for us: always on in dev, ?debug=1 in production builds.
const DEBUG = import.meta.env.DEV || new URLSearchParams(location.search).get("debug") === "1";

// label, key, step, hint
const PARAM_FIELDS: [string, keyof AnalysisParams, number, string][] = [
  ["Analysis width (px)", "analysisWidth", 40, "downscale target; lower = faster, coarser"],
  ["Sample interval (s)", "sampleInterval", 0.05, "time between compared frames"],
  ["Diff threshold", "diffThresh", 1, "min pixel change to count as motion (0-255)"],
  ["Dilate iterations", "dilateIters", 1, "mask growth passes; higher merges nearby specks"],
  ["Min region area (frac)", "contourAreaLowFrac", 0.00005, "drop changed regions smaller than this fraction of frame"],
  ["Max region area (frac)", "contourAreaHighFrac", 0.05, "drop changed regions larger than this fraction of frame"],
  ["Link time gap (s)", "spanTh", 0.1, "max time between nodes of one activity"],
  ["Link distance (frac diag)", "distRatio", 0.005, "max spatial gap between nodes of one activity"],
  ["Min activity size (frac)", "minSizeFrac", 0.005, "validity: activity w/h at least this fraction of frame"],
  ["Max activity size (frac)", "maxSizeFrac", 0.05, "validity: activity w/h at most this fraction of frame"],
  ["Min duration (s)", "minDuration", 0.1, "hide activities shorter than this"],
];

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const magCanvasRef = useRef<HTMLCanvasElement>(null);
  const debugCanvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const activitiesRef = useRef<Activity[]>([]);
  const samplesRef = useRef<{ t: number; boxes: Box[] }[]>([]); // per-sample node boxes (debug)
  const fileRef = useRef<File | null>(null);

  const [params, setParams] = useState<AnalysisParams>(DEFAULT_PARAMS);
  const [showParams, setShowParams] = useState(false);
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
  const [debugT, setDebugT] = useState(0);
  const [playheadNodes, setPlayheadNodes] = useState<Box[]>([]);

  const canPlay = done || analyzedUpTo >= PLAYBACK_LEAD;

  function analyze(file: File, p: AnalysisParams) {
    workerRef.current?.terminate();
    fileRef.current = file;
    activitiesRef.current = [];
    samplesRef.current = [];
    setMeta(null); setAnalyzedUpTo(0); setXRealtime(0); setActivityCount(0); setValidCount(0);
    setDone(false); setError(null); setCurrent(null); setOpenClusters(0); setPlayheadNodes([]);

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
        samplesRef.current.push({ t: m.t, boxes: m.boxes });
        // Draw straight to the canvas — no React state per sample (5/sec of video × 16×).
        const c = debugCanvasRef.current;
        if (c) {
          if (c.width !== m.w) { c.width = m.w; c.height = m.h; }
          const ctx = c.getContext("2d");
          if (ctx) {
            ctx.putImageData(new ImageData(new Uint8ClampedArray(m.frame), m.w, m.h), 0, 0);
            ctx.strokeStyle = "#00e676";
            ctx.lineWidth = 1.5;
            for (const b of m.boxes) ctx.strokeRect(b.x, b.y, b.w, b.h);
          }
        }
        setDebugT(m.t);
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
        samplesRef.current.filter((s) => Math.abs(s.t - t) <= 0.6).flatMap((s) => s.boxes)
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
                <div className="param-grid">
                  {PARAM_FIELDS.map(([label, key, step, hint]) => (
                    <label key={key} title={hint}>
                      <span>{label}</span>
                      <input
                        type="number"
                        step={step}
                        value={params[key]}
                        onChange={(e) => setParams((p) => ({ ...p, [key]: Number(e.target.value) }))}
                      />
                    </label>
                  ))}
                </div>
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
          <h2>Analyzer view {done ? "(final sample)" : `@ ${debugT.toFixed(1)}s`}</h2>
          <canvas ref={debugCanvasRef} width={480} height={270} />
          <div className="debug-legend">
            <span><i className="sw red" /> diff mask (post-dilate)</span>
            <span><i className="sw green" /> node boxes (this sample)</span>
            <span><i className="sw blue" /> raw nodes near playhead (on video)</span>
            <span>{openClusters} open clusters · {samplesRef.current.length} samples</span>
          </div>
        </div>
      )}

      <canvas ref={magCanvasRef} width={480} height={270} className="mag" />
    </div>
  );
}
