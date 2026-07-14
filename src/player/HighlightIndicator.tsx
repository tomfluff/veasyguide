// Ported from VeasyGuide HighlightIndicator (component name typo "Higghlight..."
// at the import site fixed; logic unchanged). Consumes PlayerActivity (native
// video px), scaled to the container by scaleRatio like the original.
import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import { Box, type MantineStyleProp } from "@mantine/core";
import { useTimeout } from "@mantine/hooks";
import { sanitizeFilters, useHighlightSettingsStore } from "../stores/HighlightSettingsStore";
import { convertColorToRGBA } from "../utils/misc";
import IndicatorPointer from "./IndicatorPointer";
import EnhanceCanvas from "./EnhanceCanvas";
import type { PlayerActivity } from "./types";

type Props = {
  leftShift: number;
  topShift: number;
  scaleRatio: number;
  activity: PlayerActivity | null | undefined;
  videoRef: RefObject<HTMLVideoElement | null>;
};

// The top of a throb, as a multiple of the resting box. MUST match the 1.25 in @keyframes pulse
// (player.css) — the canvas is sized to this extent and the ink-spread clip is derived from it,
// so if they disagree the ink and the border stop lining up at the peak.
const PULSE_PEAK = 1.25;

const HighlightIndicator = (props: Props) => {
  const { leftShift, topShift, scaleRatio, activity } = props;
  const settings = useHighlightSettingsStore();
  const filters = sanitizeFilters(settings.filter_style);
  const opacityDuration = 350;
  const [highlightOpacity, setHighlightOpacity] = useState(1);
  const [currActivity, setCurrActivity] = useState<PlayerActivity | null | undefined>(null);

  const { start: emptyActivityStart, clear: emptyActivityClear } = useTimeout(() => {
    setCurrActivity(null);
  }, opacityDuration);

  useEffect(() => {
    if (activity != null) {
      setCurrActivity(activity);
      setHighlightOpacity(1);
    } else if (currActivity != null) {
      setHighlightOpacity(0);
      emptyActivityStart();
    }
    return emptyActivityClear;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity]);

  if (!currActivity) {
    return null;
  }

  const commonStyle: CSSProperties = {
    ["--indicator-scale" as string]: settings.base_scale + 0.05,
    position: "absolute",
    bottom: 0,
    width: "100%",
    height: "100%",
    transformOrigin: "50% 50%",
    transform: `scale(var(--indicator-scale))`,
  };

  const indicatorBaseStyle: CSSProperties = {
    ...commonStyle,
    backgroundColor: convertColorToRGBA(settings.fill_color, settings.fill_opacity),
    border: `${settings.border_width * scaleRatio}px solid ${settings.border_color}`,
  };

  const indicatorCircleStyle: CSSProperties = {
    width: `${settings.base_scale * settings.base_size}px`,
    height: `${settings.base_scale * settings.base_size}px`,
    borderRadius: "50%",
  };

  const indicatorAnimationStyle: CSSProperties = {
    animation: `${settings.animation_style} ${1 / settings.animation_speed}s ease-in-out forwards 3`,
  };

  const indicatorStyle: MantineStyleProp = {
    ...indicatorBaseStyle,
    ...(settings.shape_style === "static-circle" ? indicatorCircleStyle : {}),
    ...(settings.animation_style !== "none" ? indicatorAnimationStyle : {}),
  };

  const pointerStyle: MantineStyleProp = {
    ...commonStyle,
    ...(settings.shape_style === "static-circle"
      ? {
          width: `${settings.base_scale * settings.base_size}px`,
          height: `${settings.base_scale * settings.base_size}px`,
        }
      : {}),
  };

  const pointerInnerStyle: MantineStyleProp = {
    width: `${settings.pointer_scale * scaleRatio * settings.base_size * 0.5}px`,
    height: `${settings.pointer_scale * scaleRatio * settings.base_size * 0.5}px`,
    position: "absolute",
    left: 0,
    top: "calc(100% - 5% * var(--indicator-scale))",
    transformOrigin: "0% 0%",
    rotate: "25deg",
    ...(settings.shape_style === "static-circle"
      ? { transform: `translate(0%, -100%)` }
      : {}),
  };

  // The indicator is drawn scaled by --indicator-scale, but the enhance canvas used to stay at
  // the activity's unscaled rect — so at 200% size the "bolder ink" covered only the centre
  // quarter of the box. The canvas covers the SCALED box instead, with its source rect expanded
  // by the same factor so the pixels stay 1:1 with the video underneath. (A source poking past
  // the frame edge is fine: GL clamps to edge, and 2D drawImage clips.)
  //
  // Making the ink breathe with the pulse: the canvas is NEVER scaled. It holds a copy of the
  // video's own pixels, so scaling it would stretch a picture of the lecture and the words under
  // the highlight would physically grow and shrink — a pulse is an attention cue, not a
  // magnifier (that is what the zoom is for).
  //
  // Instead, when the pulse is on the canvas is rendered at the throb's WIDEST extent, still
  // sourced 1:1, and a clip-path animation reveals more or less of it in step with the border.
  // The inked REGION grows — more content gets enhanced — while every pixel inside it stays
  // exactly where it was. Growing the region and magnifying it are different things, and only
  // the first is what "pulse" should mean.
  const indicatorScale = settings.base_scale + 0.05;
  const pulsing = settings.animation_style !== "none";
  const inkScale = indicatorScale * (pulsing ? PULSE_PEAK : 1);
  const enhanceSource = {
    x: currActivity.pos.x + (currActivity.dim.width * (1 - inkScale)) / 2,
    y: currActivity.pos.y + (currActivity.dim.height * (1 - inkScale)) / 2,
    width: currActivity.dim.width * inkScale,
    height: currActivity.dim.height * inkScale,
  };

  return (
    <Box
      className="highlight-wrapper"
      style={{
        ["--highlight-opacity" as string]: highlightOpacity,
        ["--pulse-duration" as string]: `${1 / settings.animation_speed}s`,
        position: "absolute",
        left: `${scaleRatio * currActivity.pos.x + leftShift}px`,
        top: `${scaleRatio * currActivity.pos.y + topShift}px`,
        width: `${scaleRatio * currActivity.dim.width}px`,
        height: `${scaleRatio * currActivity.dim.height}px`,
        animation: `fade-in ${opacityDuration}ms ease-in-out`,
        opacity: "var(--highlight-opacity)",
        // Geometry is only animated when no enhance canvas is showing: the canvas holds
        // a fixed crop of the video, so tweening the box it lives in would smear it
        // against the frame underneath.
        transition:
          filters.length > 0
            ? `opacity ${opacityDuration}ms ease-in-out`
            : `
        opacity ${opacityDuration}ms ease-in-out,
        left ${opacityDuration}ms ease-in-out,
        top ${opacityDuration}ms ease-in-out,
        width ${opacityDuration}ms ease-in-out,
        height ${opacityDuration}ms ease-in-out
        `,
      }}
    >
      <EnhanceCanvas
        className={pulsing ? "highlight-enhance spreading" : "highlight-enhance"}
        videoRef={props.videoRef}
        filters={filters}
        source={enhanceSource}
        width={scaleRatio * enhanceSource.width}
        height={scaleRatio * enhanceSource.height}
      />
      <Box className="highlight-indicator" style={indicatorStyle} />
      <Box className="highlight-pointer" style={pointerStyle}>
        <Box style={pointerInnerStyle}>
          <IndicatorPointer style={settings.pointer_style} />
        </Box>
      </Box>
    </Box>
  );
};

export default HighlightIndicator;
