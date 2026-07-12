// Research gallery (?research=1): one card per finalized activity with its feature
// vector and, when snippets are enabled, a SEQUENCE of native-resolution crops showing
// how the activity evolved (before → start → …every 0.5s… → end).
//
// The sequence is what makes the classes legible: writing accumulates ink, pointing
// stays static, animation changes without ink. Hovering a card plays through the frames
// (the client-side equivalent of the old backend's activities/gif bucket).
//
// Snippets are DISPLAY ONLY. They are fragments of the video, so they are never written
// into any export — see docs/decisions.md D9.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Activity, AnalysisMeta, AnalysisParams } from "./analyzer/types";
import { cropRect, snippetTimestamps } from "./analyzer/snippets";
import type { SnippetOutMsg, SnippetReq } from "./analyzer/snippetWorker";

type Props = {
  activitiesRef: React.RefObject<Activity[]>;
  version: number; // bump = new activities finalized
  analysisDone: boolean;
  meta: AnalysisMeta;
  file: File;
  videoUrl: string;
  params: AnalysisParams;
  collectNodes: boolean;
  snippetsDefault: boolean;
  seekTo: (t: number) => void;
};

type Seq = { t: number; url: string }[];

export default function ActivityGallery(props: Props) {
  const [snippets, setSnippets] = useState(props.snippetsDefault);
  const [seqs, setSeqs] = useState<Map<number, Seq>>(new Map());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [stats, setStats] = useState<{ count: number; bytes: number; wallMs: number } | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const urlsRef = useRef<string[]>([]);

  const activities = props.activitiesRef.current ?? [];

  // Generate the whole snippet set in one decode pass, once analysis is complete
  // (so we know every activity and never decode the video twice).
  useEffect(() => {
    if (!snippets || !props.analysisDone) return;
    if (workerRef.current) return; // already generated/generating for this video

    const reqs: SnippetReq[] = [];
    for (const a of props.activitiesRef.current ?? []) {
      const rect = cropRect(a, props.meta);
      if (rect.w < 2 || rect.h < 2) continue;
      for (const t of snippetTimestamps(a, props.meta.duration)) {
        reqs.push({ activityId: a.id, t, rect });
      }
    }
    if (reqs.length === 0) return;

    setProgress({ done: 0, total: reqs.length });
    const worker = new Worker(new URL("./analyzer/snippetWorker.ts", import.meta.url), {
      type: "module",
    });
    worker.onerror = () => setProgress(null);
    worker.onmessage = (e: MessageEvent<SnippetOutMsg>) => {
      const m = e.data;
      if (m.type === "snippet") {
        const url = URL.createObjectURL(m.blob);
        urlsRef.current.push(url);
        setSeqs((old) => {
          const next = new Map(old);
          const seq = [...(next.get(m.activityId) ?? []), { t: m.t, url }];
          seq.sort((a, b) => a.t - b.t);
          next.set(m.activityId, seq);
          return next;
        });
      } else if (m.type === "progress") {
        setProgress({ done: m.done, total: m.total });
      } else if (m.type === "done") {
        setProgress(null);
        setStats({ count: m.count, bytes: m.bytes, wallMs: m.wallMs });
      } else if (m.type === "error") {
        setProgress(null);
      }
    };
    worker.postMessage({ type: "start", file: props.file, reqs });
    workerRef.current = worker;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snippets, props.analysisDone]);

  // Everything dies with the component (a new video remounts via key).
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
    };
  }, []);

  function downloadResearchJson() {
    const payload = {
      schemaVersion: "research-1",
      generatedAt: new Date().toISOString(),
      video: {
        name: props.file.name,
        width: props.meta.videoWidth,
        height: props.meta.videoHeight,
        duration: props.meta.duration,
      },
      analysis: {
        width: props.meta.analysisWidth,
        height: props.meta.analysisHeight,
        params: props.params,
        nodesIncluded: props.collectNodes,
      },
      // No image data, by design (docs/decisions.md D9).
      activities: props.activitiesRef.current ?? [],
    };
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${props.file.name.replace(/\.[^.]+$/, "")}.research.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="gallery">
      <h2>
        Activity gallery <small>({activities.length} activities · research mode)</small>
      </h2>
      <div className="gallery-actions">
        <label title="Native-resolution crops of each activity over time (before → start → every 0.5s → end). Display only — never included in exports.">
          <input type="checkbox" checked={snippets} onChange={(e) => setSnippets(e.target.checked)} />
          show snippets
        </label>
        <button type="button" onClick={downloadResearchJson}>
          Download research JSON {props.collectNodes ? "(features + node logs)" : "(features only)"}
        </button>
        {progress && (
          <span className="gallery-progress">
            generating snippets… {progress.done}/{progress.total} frames
          </span>
        )}
        {stats && (
          <span className="gallery-progress">
            {stats.count} crops · {(stats.bytes / 1048576).toFixed(1)} MB in memory ·{" "}
            {(stats.wallMs / 1000).toFixed(1)}s
          </span>
        )}
        {snippets && !props.analysisDone && (
          <span className="gallery-progress">waiting for analysis to finish…</span>
        )}
      </div>

      <div className="gallery-grid">
        {activities.map((a) => (
          <ActivityCard
            key={a.id}
            activity={a}
            seq={seqs.get(a.id)}
            showSnippets={snippets}
            onSeek={() => props.seekTo(Math.max(0, a.start - 0.5))}
          />
        ))}
      </div>
    </div>
  );
}

function ActivityCard({
  activity: a,
  seq,
  showSnippets,
  onSeek,
}: {
  activity: Activity;
  seq: Seq | undefined;
  showSnippets: boolean;
  onSeek: () => void;
}) {
  const [idx, setIdx] = useState<number | null>(null); // null = show the result (last frame)
  const [playing, setPlaying] = useState(false);

  // Hover plays the sequence, like a GIF.
  useEffect(() => {
    if (!playing || !seq || seq.length < 2) return;
    let i = 0;
    setIdx(0);
    const id = setInterval(() => {
      i = (i + 1) % seq.length;
      setIdx(i);
    }, 350);
    return () => clearInterval(id);
  }, [playing, seq]);

  const shown = useMemo(() => {
    if (!seq || seq.length === 0) return null;
    const i = idx ?? seq.length - 1; // default: the end frame — the result
    return seq[Math.min(i, seq.length - 1)];
  }, [seq, idx]);

  const f = a.features;

  return (
    <div
      className={`gallery-card ${a.isValid ? "" : "invalid"}`}
      onMouseEnter={() => setPlaying(true)}
      onMouseLeave={() => {
        setPlaying(false);
        setIdx(null);
      }}
    >
      {showSnippets &&
        (shown ? (
          <div className="card-media">
            <img src={shown.url} alt={`Activity ${a.id} at ${shown.t.toFixed(1)}s`} />
            <span className="frame-time">{shown.t.toFixed(1)}s</span>
            {seq && seq.length > 1 && (
              <div className="filmstrip">
                {seq.map((fr, i) => (
                  <button
                    key={fr.url}
                    type="button"
                    className={`strip-frame ${(idx ?? seq.length - 1) === i ? "on" : ""}`}
                    title={`${fr.t.toFixed(1)}s${i === 0 ? " (before)" : ""}`}
                    onMouseEnter={() => {
                      setPlaying(false);
                      setIdx(i);
                    }}
                  >
                    <img src={fr.url} alt="" />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="crop-pending">…</div>
        ))}
      <div className="card-head">
        <b>#{a.id}</b>
        {!a.isValid && <span className="badge">invalid</span>}
        <button type="button" onClick={onSeek}>
          {a.start.toFixed(1)}–{a.end.toFixed(1)}s ▶
        </button>
      </div>
      <div className="card-feats">
        <span title="duration">{f.duration.toFixed(1)}s</span>
        <span title="nodes">{a.nodeCount}n</span>
        <span title="mean mask density (mass / bbox area)">d {f.meanDensity.toFixed(2)}</span>
        <span title="mean consecutive-node IoU (pointing high, sketching low)">
          iou {f.meanConsecIoU.toFixed(2)}
        </span>
        <span title="union area / mean node area (marking grows)">gr {f.growth.toFixed(1)}</span>
        <span title="trajectory tortuosity (path / displacement)">
          tor {f.tortuosity > 99 ? "∞" : f.tortuosity.toFixed(1)}
        </span>
        <span title="mean consecutive shape difference (matchShapes analog)">
          sh {f.meanShapeDiff.toFixed(2)}
        </span>
        <span title="mean per-pixel change magnitude">Δ {f.meanDiff.toFixed(0)}</span>
      </div>
    </div>
  );
}
