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

  // The indicator is drawn scaled by --indicator-scale (and the pulse scales it further),
  // but the enhance canvas used to stay at the activity's unscaled rect — so at 200% size
  // the "bolder ink" covered only the centre quarter of the box, and during a pulse the
  // border throbbed around a frozen crop. The canvas instead covers the SCALED box, with
  // its source rect expanded by the same factor so the pixels stay 1:1 with the video
  // underneath. (A source poking past the frame edge is fine: GL clamps to edge, and 2D
  // drawImage clips.) The pulse itself is transform-only, so the canvas mirrors it with
  // its own animation; the interior magnifies with the throb, which is the point.
  const indicatorScale = settings.base_scale + 0.05;
  const enhanceSource = {
    x: currActivity.pos.x + (currActivity.dim.width * (1 - indicatorScale)) / 2,
    y: currActivity.pos.y + (currActivity.dim.height * (1 - indicatorScale)) / 2,
    width: currActivity.dim.width * indicatorScale,
    height: currActivity.dim.height * indicatorScale,
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
        className={
          settings.animation_style !== "none"
            ? "highlight-enhance pulsing"
            : "highlight-enhance"
        }
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
