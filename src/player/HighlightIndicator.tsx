// Ported from VeasyGuide HighlightIndicator (component name typo "Higghlight..."
// at the import site fixed; logic unchanged). Consumes PlayerActivity (native
// video px), scaled to the container by scaleRatio like the original.
import { useEffect, useState, type CSSProperties } from "react";
import { Box, type MantineStyleProp } from "@mantine/core";
import { useTimeout } from "@mantine/hooks";
import { useHighlightSettingsStore } from "../stores/HighlightSettingsStore";
import { convertColorToRGBA } from "../utils/misc";
import IndicatorPointer from "./IndicatorPointer";
import type { PlayerActivity } from "./types";

type Props = {
  leftShift: number;
  topShift: number;
  scaleRatio: number;
  activity: PlayerActivity | null | undefined;
};

const HighlightIndicator = (props: Props) => {
  const { leftShift, topShift, scaleRatio, activity } = props;
  const settings = useHighlightSettingsStore();
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

  const indicatorFilterStyle: CSSProperties = {
    backdropFilter: `${settings.filter_style
      .map((filter) => `url(#svgf-${filter})`)
      .join(" ")}`,
  };

  const indicatorAnimationStyle: CSSProperties = {
    animation: `${settings.animation_style} ${1 / settings.animation_speed}s ease-in-out forwards 3`,
  };

  const indicatorStyle: MantineStyleProp = {
    ...indicatorBaseStyle,
    ...(settings.shape_style === "static-circle" ? indicatorCircleStyle : {}),
    ...(settings.filter_style.length > 0 ? indicatorFilterStyle : {}),
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

  return (
    <Box
      className="highlight-wrapper"
      style={{
        ["--highlight-opacity" as string]: highlightOpacity,
        position: "absolute",
        left: `${scaleRatio * currActivity.pos.x + leftShift}px`,
        top: `${scaleRatio * currActivity.pos.y + topShift}px`,
        width: `${scaleRatio * currActivity.dim.width}px`,
        height: `${scaleRatio * currActivity.dim.height}px`,
        animation: `fade-in ${opacityDuration}ms ease-in-out`,
        opacity: "var(--highlight-opacity)",
        transition: `
        opacity ${opacityDuration}ms ease-in-out,
        left ${opacityDuration}ms ease-in-out,
        top ${opacityDuration}ms ease-in-out,
        width ${opacityDuration}ms ease-in-out,
        height ${opacityDuration}ms ease-in-out
        `,
      }}
    >
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
