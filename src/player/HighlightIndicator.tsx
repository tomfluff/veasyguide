// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// Ported from VeasyGuide HighlightIndicator (component name typo "Higghlight..."
// at the import site fixed). Consumes PlayerActivity in native video px.
//
// The WRAPPER is video-space: scaleRatio and the letterbox shifts put it exactly over the
// ink the analyzer found. Everything drawn inside it is screen-space and comes from
// indicatorMetrics — see that file for why the two must not be the same unit, and why no
// `transform: scale()` may sit between the border and the viewport.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { Box, type MantineStyleProp } from "@mantine/core";
import { useTimeout } from "@mantine/hooks";
import { sanitizeFilters, useHighlightSettingsStore } from "../stores/HighlightSettingsStore";
import { convertColorToRGBA } from "../utils/misc";
import IndicatorPointer from "./IndicatorPointer";
import EnhanceCanvas from "./EnhanceCanvas";
import { indicatorMetrics, enhanceSource, isThrobAnimation } from "./indicatorMetrics";
import { tweenActivity } from "./activityTween";
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
  // Whether the enhance canvas exists at all — not WHICH filters, which is what the rewind
  // below used to key on. Swapping one filter for another repaints a canvas already running
  // in step; only its appearing mounts a fresh animation that needs bringing into phase.
  //
  // As a dependency this fires on the canvas leaving too, which restarts the throb on its own
  // for no synchronisation reason. That is accepted rather than guarded: distinguishing "the
  // ink went away" from "the ink went away in the same pass as the moment changed" costs
  // three more refs, and what it buys is suppressing one throb at the instant a viewer
  // toggled their last enhance filter off — a discrete, deliberate action, where a throb
  // reads as acknowledgement rather than noise. (The speed slider was the opposite case, and
  // is deliberately not a dependency: it fires continuously under a dragging thumb.)
  const hasInk = filters.length > 0;
  const opacityDuration = 350;
  const [highlightOpacity, setHighlightOpacity] = useState(1);
  const [currActivity, setCurrActivity] = useState<PlayerActivity | null | undefined>(null);
  // Bumped on each ENTRY into a moment. The moment's id is not enough on its own: leaving a
  // moment and returning to it inside the 350ms fade-out window never unmounts the wrapper
  // and never changes the id, so scrubbing back over the same moment would re-show a
  // highlight that had already spent its throbs.
  const [entry, setEntry] = useState(0);
  const absentRef = useRef(true);
  // Where the highlight is actually drawn while it is on its way to `currActivity`. Null
  // whenever it is not travelling, which is the whole time unless an enhance filter is on —
  // see activityTween.ts for why that one case cannot use the CSS transition.
  const [inTransit, setInTransit] = useState<PlayerActivity | null>(null);

  const { start: emptyActivityStart, clear: emptyActivityClear } = useTimeout(() => {
    setCurrActivity(null);
  }, opacityDuration);

  useEffect(() => {
    if (activity != null) {
      // Only on the edge. VideoPlayer builds a fresh PlayerActivity object every frame, so
      // this effect runs every frame and an unconditional bump would rewind the throb 60
      // times a second — it would never get past its first few milliseconds.
      if (absentRef.current) setEntry((n) => n + 1);
      absentRef.current = false;
      setCurrActivity(activity);
      setHighlightOpacity(1);
    } else if (currActivity != null) {
      absentRef.current = true;
      setHighlightOpacity(0);
      emptyActivityStart();
    }
    return emptyActivityClear;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity]);

  const wrapperRef = useRef<HTMLDivElement>(null);

  // Walk the activity rectangle from where the highlight IS to the moment it is now wanted
  // at, so that the box, the ink canvas and the crop that canvas cuts all keep agreeing frame
  // by frame. Only when a filter is on: without one the CSS transition on the wrapper does
  // this for free, on the compositor, and nothing has to agree with it.
  //
  // useLayoutEffect, and the first step taken here rather than in the first frame callback.
  // A passive effect would leave one render — the render in which the moment changed — with
  // no journey started yet, so `shown` would fall through to the destination and the browser
  // would paint the highlight there before anything moved. Measured off painted frames: the
  // mark appeared at the far end for two frames, jumped back, and only then travelled. Seeding
  // progress 0 before paint means the destination is never a frame the viewer sees.
  const inTransitRef = useRef<PlayerActivity | null>(null);
  inTransitRef.current = inTransit;
  const lastTargetRef = useRef<PlayerActivity | null>(null);
  useLayoutEffect(() => {
    // Start from where the mark actually is. Mid-journey that is the interpolated rectangle,
    // not the moment we were heading for — otherwise a viewer stepping quickly through
    // moments sends it back to collect the one it never reached.
    const from = inTransitRef.current ?? lastTargetRef.current;
    lastTargetRef.current = currActivity ?? null;
    if (!hasInk || !currActivity || !from || from.id === currActivity.id) {
      setInTransit(null);
      return;
    }
    setInTransit(tweenActivity(from, currActivity, 0));
    let raf = 0;
    let start = 0;
    const step = (now: number) => {
      if (!start) start = now;
      const progress = (now - start) / opacityDuration;
      if (progress >= 1) {
        setInTransit(null);
        return;
      }
      setInTransit(tweenActivity(from, currActivity, progress));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currActivity?.id, hasInk]);

  // Rewind the pulse for every new moment.
  //
  // The pulse is `forwards 3` — three throbs, then hold. That reads as "three throbs per
  // moment", and it is what you get for the FIRST moment. But `selectActivity` (analyzer/
  // select.ts) hands one moment straight to the next whenever they are within lead+linger of
  // each other, which on a real lecture is most of them: the wrapper never unmounts, React
  // reuses the same element, and a CSS animation that has finished does not restart just
  // because the styles around it changed. So the three throbs were spent once and the rest of
  // the run was silent — the feature quietly stopping for exactly the viewer who went and
  // switched it on.
  //
  // Rewinding beats remounting. `key={currActivity.id}` would restart the animations, but it
  // would also tear down and rebuild EnhanceCanvas — a fresh WebGL context per moment
  // (GLEnhancer.create/dispose), on the weak hardware this app is built for.
  //
  // Restarting the box's throb and the ink's in the same pass is also what keeps them in
  // step: they are two animations describing one cue, and the ink clip only lines up with the
  // ring if they share a phase. Hence the other two dependencies, both of which MOUNT a fresh
  // animation at phase zero against a border already somewhere else in its cycle — `hasInk`
  // for the canvas appearing, `shape_style` for it swapping between the square clip and the
  // round one.
  //
  // Deliberately NOT dependencies: `animation_speed`, because both durations change together
  // and the two stay in phase without help — while rewinding on it would snap the box back to
  // rest on every tick of a slider the viewer is dragging; and `animation_style`, because
  // turning the pulse on creates both animations at zero already, and turning it off removes
  // them.
  //
  // Which animations count is isThrobAnimation's problem, and it is exact: the wrapper's own
  // `fade-in` is not part of the throb, and rewinding it would re-fade the highlight every
  // time the lecturer moved their pen.
  //
  // useLayoutEffect, not useEffect. What is at stake is a frame in which the box has already
  // moved to the new moment while the throb is still at the old moment's phase — hand over
  // near the top of a throb and that is a 25%-oversized box, a flicker on the overlay whose
  // whole job is to be the calm thing a viewer can find.
  //
  // React explicitly allows the browser to paint before a passive effect runs, so that frame
  // is a permitted scheduling path, not a hypothetical. Measuring it (box width sampled per
  // frame, handover timed to land at the peak) did not happen to reproduce it — React flushed
  // the passive version before paint in every run — but "did not observe" is not "cannot
  // happen", and a layout effect is the one that promises. The promise costs one
  // getAnimations call, which is not worth deferring past the paint it might spoil.
  useLayoutEffect(() => {
    for (const a of wrapperRef.current?.getAnimations({ subtree: true }) ?? []) {
      // getAnimations() also hands back the wrapper's CSSTransitions — the 350ms glide of
      // left/top/width/height, which is running at precisely this moment, because the
      // highlight just moved. Those have no `animationName` at all, so this must ask rather
      // than assume: reading `.animationName.startsWith` off a transition throws, and it
      // throws inside an effect, which takes the whole player down with it.
      if (isThrobAnimation(a)) {
        a.currentTime = 0;
        a.play();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currActivity?.id, entry, hasInk, settings.shape_style]);

  // scaleRatio is 0 until the container has been measured. Nothing positioned off it means
  // anything yet, and the decoration no longer collapses to nothing on its own: a 12px ring
  // is 12px whatever the scale is, so without this it would flash at the overlay's origin —
  // a high-contrast mark in the wrong place, which is the one failure this overlay must
  // never produce. Better invisible for one frame.
  if (!currActivity || scaleRatio <= 0) {
    return null;
  }

  // Where to draw: the moment we are heading for, or the rectangle partway to it. Identity
  // and id come from the target either way, so the pulse and the moment list are unaffected.
  const shown = inTransit ?? currActivity;

  // Everything below is in CSS pixels. The activity rectangle is converted to CSS px here,
  // once; from that point on nothing in the indicator knows what resolution the video is.
  const activityBox = {
    width: scaleRatio * shown.dim.width,
    height: scaleRatio * shown.dim.height,
  };
  const m = indicatorMetrics(settings, activityBox);

  // The box is CENTRED on the activity and SIZED in px — it is not a 100%-of-wrapper element
  // under `transform: scale()` any more. `translate` is a translation, not a scale, so it
  // moves the box without touching the thickness of anything painted inside it; growing
  // width/height around a centred origin is what the pulse animates instead.
  const boxStyle: CSSProperties = {
    ["--box-w" as string]: m.cssWidth,
    ["--box-h" as string]: m.cssHeight,
    ["--box-w-peak" as string]: m.cssPeakWidth,
    ["--box-h-peak" as string]: m.cssPeakHeight,
    position: "absolute",
    left: "50%",
    top: "50%",
    translate: "-50% -50%",
    width: "var(--box-w)",
    height: "var(--box-h)",
  };

  const indicatorStyle: MantineStyleProp = {
    ...boxStyle,
    backgroundColor: convertColorToRGBA(settings.fill_color, settings.fill_opacity),
    // Literal: no scaleRatio, and no scaling ancestor to multiply it back up.
    //
    // An inset shadow rather than a `border`, because a border is part of the box and this
    // is not. Under the global `box-sizing: border-box` a real border eats the interior, and
    // when the box is narrower than two borders CSS refuses to go negative and grows the
    // BOX instead: a 12px setting on a thin 20px annotation rendered a 24px box, which no
    // longer sat on the ink and no longer agreed with the enhance canvas beside it. An inset
    // shadow is painted, not laid out — the box stays exactly the size the activity says,
    // and a ring too thick for it simply fills it. It follows border-radius, so the fixed
    // circle still gets a round ring.
    boxShadow: `inset 0 0 0 ${m.borderWidth}px ${settings.border_color}`,
    ...(settings.shape_style === "static-circle" ? { borderRadius: "50%" } : {}),
    ...(m.pulsing
      ? {
          animation: `pulse ${1 / settings.animation_speed}s ease-in-out forwards 3`,
        }
      : {}),
  };

  // The pointer shares the box's resting frame so it stays pinned to the corner, but it
  // never carries the pulse: a throbbing box is an attention cue, a throbbing hand is a
  // distraction. Its own size is a screen length, so it no longer changes with the video.
  const pointerStyle: MantineStyleProp = boxStyle;

  const pointerInnerStyle: MantineStyleProp = {
    // Width is the dimension `pointer_scale` controls; the height is left to the artwork, so
    // the hand is not squared off.
    //
    // The tip is this element's top-left, which is also the transform origin — so the artwork
    // hangs down and to the right of wherever indicatorMetrics puts it, away from the thing
    // being pointed at, in both shapes.
    width: `${m.pointerSize}px`,
    position: "absolute",
    left: m.pointerLeft,
    top: m.pointerTop,
    transformOrigin: "0% 0%",
    rotate: "25deg",
  };

  const source = enhanceSource(m, shown, scaleRatio);

  return (
    <Box
      ref={wrapperRef}
      className="highlight-wrapper"
      style={{
        ["--highlight-opacity" as string]: highlightOpacity,
        ["--pulse-duration" as string]: `${1 / settings.animation_speed}s`,
        position: "absolute",
        left: `${scaleRatio * shown.pos.x + leftShift}px`,
        top: `${scaleRatio * shown.pos.y + topShift}px`,
        width: `${scaleRatio * shown.dim.width}px`,
        height: `${scaleRatio * shown.dim.height}px`,
        animation: `fade-in ${opacityDuration}ms ease-in-out`,
        opacity: "var(--highlight-opacity)",
        // Two ways of moving, for one reason. Without an enhance canvas the geometry is
        // CSS-transitioned: cheap, composited, and answerable to nothing. With one, the box
        // carries a copy of the video from underneath it, and a CSS tween would slide that
        // copy across the frame showing pixels borrowed from where the box used to be. So
        // that case walks the activity rectangle itself instead (activityTween.ts) and asks
        // CSS for no geometry at all — the numbers above are already this frame's.
        transition:
          hasInk
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
        // `round` swaps the ink clip from a rectangle to a circle. The mark is round in this
        // shape, and the enhanced patch was a square under it — so the four corners got
        // bolder ink that nothing was pointing at.
        className={[
          "highlight-enhance",
          settings.shape_style === "static-circle" ? "round" : "",
          m.pulsing ? "spreading" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        videoRef={props.videoRef}
        filters={filters}
        source={source}
        width={m.peakWidth}
        height={m.peakHeight}
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
