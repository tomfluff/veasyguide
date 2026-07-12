// Research gallery (?research=1): one card per finalized activity with its feature
// vector and, when snippets are enabled (?snippets=1 or the toggle), a visual crop.
//
// Snippets are generated LAZILY from a hidden <video> on the already-loaded object
// URL — native resolution, zero analysis cost, works for cached analyses too. They
// are display-only: the research JSON export contains features + node logs but NO
// image data (snippets are fragments of the video; exporting them needs its own
// explicit consent, deliberately not implemented yet).
import { useEffect, useRef, useState } from "react";
import type { Activity, AnalysisMeta, AnalysisParams } from "./analyzer/types";

type Props = {
  activitiesRef: React.RefObject<Activity[]>;
  version: number; // bump = new activities finalized
  meta: AnalysisMeta;
  videoUrl: string;
  fileName: string;
  params: AnalysisParams;
  collectNodes: boolean;
  snippetsDefault: boolean;
  seekTo: (t: number) => void;
};

const SNIPPET_MAX_W = 220;
const SNIPPET_PAD = 0.15; // padding around the activity box, fraction of its size

export default function ActivityGallery(props: Props) {
  const [snippets, setSnippets] = useState(props.snippetsDefault);
  const [crops, setCrops] = useState<Map<number, string>>(new Map());
  const hiddenVideoRef = useRef<HTMLVideoElement>(null);
  const generatingRef = useRef(false);

  // Sequentially generate crops for activities that don't have one yet.
  useEffect(() => {
    if (!snippets || generatingRef.current) return;
    const video = hiddenVideoRef.current;
    if (!video) return;
    generatingRef.current = true;

    (async () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      // Iterate over a snapshot; newly finalized activities get picked up on the
      // next version bump.
      const todo = (props.activitiesRef.current ?? []).filter((a) => !crops.has(a.id));
      const made = new Map<number, string>();
      for (const a of todo) {
        const url = await cropActivity(video, ctx, canvas, a, props.meta);
        if (url) made.set(a.id, url);
      }
      if (made.size > 0) setCrops((old) => new Map([...old, ...made]));
      generatingRef.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snippets, props.version, crops.size]);

  // Object URLs die with the component (new video = new gallery via key).
  useEffect(() => {
    return () => {
      for (const url of crops.values()) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function downloadResearchJson() {
    const payload = {
      schemaVersion: "research-1",
      generatedAt: new Date().toISOString(),
      video: {
        name: props.fileName,
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
      activities: props.activitiesRef.current ?? [],
    };
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${props.fileName.replace(/\.[^.]+$/, "")}.research.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const activities = props.activitiesRef.current ?? [];

  return (
    <div className="gallery">
      <h2>
        Activity gallery <small>({activities.length} activities · research mode)</small>
      </h2>
      <div className="gallery-actions">
        <label title="Generate a native-resolution image crop per activity from the loaded video. Display-only — never included in exports.">
          <input type="checkbox" checked={snippets} onChange={(e) => setSnippets(e.target.checked)} />
          show snippets
        </label>
        <button type="button" onClick={downloadResearchJson}>
          Download research JSON {props.collectNodes ? "(features + node logs)" : "(features only)"}
        </button>
      </div>
      <video ref={hiddenVideoRef} src={props.videoUrl} muted preload="auto" style={{ display: "none" }} />
      <div className="gallery-grid">
        {activities.map((a) => (
          <div className={`gallery-card ${a.isValid ? "" : "invalid"}`} key={a.id}>
            {snippets &&
              (crops.has(a.id) ? (
                <img src={crops.get(a.id)} alt={`Activity ${a.id} region`} />
              ) : (
                <div className="crop-pending">…</div>
              ))}
            <div className="card-head">
              <b>#{a.id}</b>
              {!a.isValid && <span className="badge">invalid</span>}
              <button type="button" onClick={() => props.seekTo(Math.max(0, a.start - 0.5))}>
                {a.start.toFixed(1)}–{a.end.toFixed(1)}s ▶
              </button>
            </div>
            <div className="card-feats">
              <span title="duration">{a.features.duration.toFixed(1)}s</span>
              <span title="nodes">{a.nodeCount}n</span>
              <span title="mean mask density (mass / bbox area)">d {a.features.meanDensity.toFixed(2)}</span>
              <span title="mean consecutive-node IoU (pointing high, sketching low)">iou {a.features.meanConsecIoU.toFixed(2)}</span>
              <span title="union area / mean node area (marking grows)">gr {a.features.growth.toFixed(1)}</span>
              <span title="trajectory tortuosity (path / displacement)">tor {a.features.tortuosity > 99 ? "∞" : a.features.tortuosity.toFixed(1)}</span>
              <span title="mean consecutive shape difference (matchShapes analog)">sh {a.features.meanShapeDiff.toFixed(2)}</span>
              <span title="mean per-pixel change magnitude">Δ {a.features.meanDiff.toFixed(0)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

async function cropActivity(
  video: HTMLVideoElement,
  ctx: CanvasRenderingContext2D | null,
  canvas: HTMLCanvasElement,
  a: Activity,
  meta: AnalysisMeta
): Promise<string | null> {
  if (!ctx) return null;
  try {
    // Seek slightly before the end: the activity's result (finished stroke) is there.
    const t = Math.max(0, Math.min(a.end, meta.duration - 0.05));
    await seekOnce(video, t);
    // Native-res crop with padding, clamped to the frame.
    const s = meta.scale;
    const padX = a.box.w * s * SNIPPET_PAD;
    const padY = a.box.h * s * SNIPPET_PAD;
    const sx = Math.max(0, a.box.x * s - padX);
    const sy = Math.max(0, a.box.y * s - padY);
    const sw = Math.min(meta.videoWidth - sx, a.box.w * s + 2 * padX);
    const sh = Math.min(meta.videoHeight - sy, a.box.h * s + 2 * padY);
    if (sw < 2 || sh < 2) return null;
    const outW = Math.min(SNIPPET_MAX_W, Math.round(sw));
    const outH = Math.max(1, Math.round((outW / sw) * sh));
    canvas.width = outW;
    canvas.height = outH;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), "image/webp", 0.85)
    );
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

function seekOnce(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      reject(new Error("video error during seek"));
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = t;
  });
}
