import { useEffect, useRef, useState } from "react";
import type { Activity, AnalysisMeta, WorkerMsg } from "./analyzer/types";
import "./App.css";

const ANALYSIS_WIDTH = 480; // downscale for analysis (design: ~480p fast path)
const SAMPLE_INTERVAL = 0.2; // seconds (study: sample_fps_ratio 0.2)
const PLAYBACK_LEAD = 10; // seconds analyzed before playback unlocks

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const magCanvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const activitiesRef = useRef<Activity[]>([]);

  const [meta, setMeta] = useState<AnalysisMeta | null>(null);
  const [analyzedUpTo, setAnalyzedUpTo] = useState(0);
  const [xRealtime, setXRealtime] = useState(0);
  const [activityCount, setActivityCount] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<Activity | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  const canPlay = done || analyzedUpTo >= PLAYBACK_LEAD;

  function loadFile(file: File) {
    workerRef.current?.terminate();
    activitiesRef.current = [];
    setMeta(null); setAnalyzedUpTo(0); setXRealtime(0); setActivityCount(0);
    setDone(false); setError(null); setCurrent(null); setCurrentTime(0);
    setVideoUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(file); });

    const worker = new Worker(new URL("./analyzer/worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const m = e.data;
      if (m.type === "meta") setMeta(m.meta);
      else if (m.type === "activity") {
        activitiesRef.current.push(m.activity);
        setActivityCount((c) => c + 1);
      } else if (m.type === "progress") { setAnalyzedUpTo(m.analyzedUpTo); setXRealtime(m.xRealtime); }
      else if (m.type === "done") { setDone(true); setXRealtime(m.xRealtime); setAnalyzedUpTo(Infinity); }
      else if (m.type === "error") setError(m.message);
    };
    worker.postMessage({ type: "start", file, analysisWidth: ANALYSIS_WIDTH, sampleInterval: SAMPLE_INTERVAL });
    workerRef.current = worker;
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
    const hits = activitiesRef.current.filter((a) => a.start - 1 <= t && a.end + 0.5 >= t);
    hits.sort((a, b) => a.start - b.start);
    setCurrent(hits[0] ?? null);
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
            {!canPlay && <div className="gate">Analyzing… playback unlocks at {PLAYBACK_LEAD}s lead</div>}
          </div>

          <div className="hud">
            <div className={`meter ${xRealtime >= 4 ? "ok" : xRealtime >= 2 ? "warn" : "bad"}`}>
              {done ? "done" : "analyzing"} · <b>{xRealtime.toFixed(1)}×</b> realtime
            </div>
            <div className="bar"><div className="fill" style={{ width: `${progressPct}%` }} /></div>
            <div className="stats">
              {meta ? `${meta.videoWidth}×${meta.videoHeight} → ${meta.analysisWidth}×${meta.analysisHeight}` : "…"}
              {" · "}{activityCount} activities · analyzed {progressPct.toFixed(0)}%
              {" · playhead "}{currentTime.toFixed(1)}s
            </div>
          </div>
        </div>
      )}

      <canvas ref={magCanvasRef} width={ANALYSIS_WIDTH} height={270} className="mag" />
    </div>
  );
}
