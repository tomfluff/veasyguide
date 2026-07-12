// Mirrors a region of the video into a canvas and applies the enhance filters to it.
//
// This exists because `backdrop-filter: url(#svg-filter)` — what the study player used
// for the highlight's filters — is unsupported in Firefox and Safari, and in Firefox it
// makes the element vanish entirely rather than degrade. A regular `filter: url(#…)` on
// a canvas works in every current browser, so we copy the pixels instead of filtering
// the backdrop. Same technique MagnificationOverlay already used.
//
// The canvas only renders while it is actually visible (filters on + an activity), so
// there is no per-frame readback cost when the feature is off.
import { useEffect, useRef, type RefObject } from "react";
import type { TFilterStyle } from "../stores/HighlightSettingsStore";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  filters: TFilterStyle[];
  /** Source region in native video pixels. */
  source: { x: number; y: number; width: number; height: number };
  /** Rendered size in CSS pixels. */
  width: number;
  height: number;
  className?: string;
};

const EnhanceCanvas = ({ videoRef, filters, source, width, height, className }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Keep the source rect in a ref so the render loop always reads the latest one
  // without being torn down and restarted on every activity change.
  const srcRef = useRef(source);
  srcRef.current = source;

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || filters.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const draw = () => {
      const s = srcRef.current;
      if (video.videoWidth && s.width > 0 && s.height > 0) {
        ctx.drawImage(
          video,
          s.x, s.y, s.width, s.height,
          0, 0, canvas.width, canvas.height
        );
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [videoRef, filters.length]);

  if (filters.length === 0) return null;

  return (
    <canvas
      ref={canvasRef}
      className={className}
      width={Math.max(1, Math.round(width))}
      height={Math.max(1, Math.round(height))}
      style={{ filter: filters.map((f) => `url(#svgf-${f})`).join(" ") }}
    />
  );
};

export default EnhanceCanvas;
