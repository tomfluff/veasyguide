// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Appearance sheet: preset tiles up front, everything else behind a drill-in.
//
// Two decisions shape this file.
//
// FIRST: the presets are pictures, not words (see PresetTile). Most viewers will pick a tile
// and never open anything else, so the tiles are the whole first screen.
//
// SECOND: the sheet drills instead of growing. The old version was one long scroll — six
// stacked sections, ~470px tall — which covered most of the video it was supposed to be
// previewing against. Here the panel is a fixed 340x260 and you go DEEPER, not longer, so
// the band of video it occludes never changes. That is the same trade every TV and streaming
// player makes, for the same reason.
//
// Every hint is visible text. No tooltips: a hover tooltip is invisible to a keyboard user, a
// screen-reader user and anyone driving a magnifier — which is the audience.
import { useState } from "react";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import {
  useHighlightSettingsStore,
  setHighlightSettings,
  filterStyleOptions,
  filterStyleLabels,
  pointerStyleOptions,
  shapeStyleOptions,
  animationStyleOptions,
  type TFilterStyle,
} from "../stores/HighlightSettingsStore";
import {
  useMagnificationSettingsStore,
  setMagnificationSettings,
} from "../stores/MagnificationSettingsStore";
import { PRESETS, applyPreset, matchPreset } from "./presets";
import PresetTile from "./PresetTile";
import "./appearance.css";

type Screen = "root" | "box" | "pointer" | "zoom" | "motion" | "ink";

const BORDER_COLORS = ["#ff0000", "#000000", "#0057ff", "#00a3a3", "#ffffff"];
const FILL_COLORS = ["#ffcc00", "#ffff00", "#00e5ff", "#ff8a00", "#ffffff"];
// Spoken names for the swatches: a screen reader announcing "#00a3a3" tells the user
// nothing, least of all a low-vision user choosing a color they can distinguish.
const COLOR_NAMES: Record<string, string> = {
  "#ff0000": "Red",
  "#000000": "Black",
  "#0057ff": "Blue",
  "#00a3a3": "Teal",
  "#ffffff": "White",
  "#ffcc00": "Amber",
  "#ffff00": "Yellow",
  "#00e5ff": "Cyan",
  "#ff8a00": "Orange",
};

/* ---- primitives ------------------------------------------------------- */

// A drill row: what it is, what it currently says, and a chevron.
const NavRow = ({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick: () => void;
}) => (
  <button type="button" className="ap-nav" onClick={onClick}>
    <span className="ap-nav-label">{label}</span>
    <span className="ap-nav-value">{value}</span>
    <IconChevronRight size={16} stroke={2} />
  </button>
);

const Row = ({
  label,
  children,
  value,
}: {
  label: string;
  children: React.ReactNode;
  value?: string;
}) => (
  <div className="ap-row">
    <span className="ap-label">{label}</span>
    <span className="ap-control">{children}</span>
    {value && <span className="ap-value">{value}</span>}
  </div>
);

// A native range input, not a Mantine Slider: it is keyboard-operable and screen-reader
// correct with no JS, and it takes the sheet's dark styling without fighting a theme.
const Range = ({
  min,
  max,
  step,
  value,
  onChange,
  label,
  disabled,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  label: string;
  disabled?: boolean;
}) => (
  <input
    type="range"
    className="ap-range"
    min={min}
    max={max}
    step={step}
    value={value}
    disabled={disabled}
    aria-label={label}
    onChange={(e) => onChange(Number(e.currentTarget.value))}
  />
);

const Choice = <T extends string>({
  options,
  value,
  onChange,
  labels,
  label,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  labels: Record<T, string>;
  label: string;
}) => (
  <span className="ap-seg" role="radiogroup" aria-label={label}>
    {options.map((o) => (
      <button
        type="button"
        key={o}
        role="radio"
        aria-checked={value === o}
        className={value === o ? "ap-seg-btn sel" : "ap-seg-btn"}
        onClick={() => onChange(o)}
      >
        {labels[o]}
      </button>
    ))}
  </span>
);

const Swatches = ({
  colors,
  value,
  onChange,
  label,
}: {
  colors: string[];
  value: string;
  onChange: (c: string) => void;
  label: string;
}) => (
  <span className="ap-swatches" role="radiogroup" aria-label={label}>
    {colors.map((c) => (
      <button
        type="button"
        key={c}
        role="radio"
        aria-checked={value === c}
        aria-label={COLOR_NAMES[c] ?? c}
        style={{ backgroundColor: c }}
        className={value === c ? "ap-swatch sel" : "ap-swatch"}
        onClick={() => onChange(c)}
      />
    ))}
  </span>
);

/* ---- screens ---------------------------------------------------------- */

// Ink is ONE row in the drill list, not two. The filters genuinely are per-surface — what
// helps at 1.7x magnification can look noisy at 1x — but surfacing that as two near-identical
// sections made the menu read as if it were repeating itself. The split lives inside.
function InkScreen() {
  const hl = useHighlightSettingsStore();
  const mag = useMagnificationSettingsStore();
  const [surface, setSurface] = useState<"highlight" | "zoom">("highlight");

  const selected = surface === "highlight" ? hl.filter_style : mag.filter_style;
  const commit = (filter_style: TFilterStyle[]) =>
    surface === "highlight"
      ? setHighlightSettings({ filter_style })
      : setMagnificationSettings({ filter_style });

  return (
    <>
      <p className="ap-hint">
        Alters the video itself. Which "bolder ink" helps depends on whether the slide is
        light or dark — and on how far you are zoomed in, which is why the two are set apart.
      </p>
      <Row label="Apply to">
        <Choice
          label="Which surface the ink applies to"
          options={["highlight", "zoom"] as const}
          value={surface}
          onChange={setSurface}
          labels={{ highlight: "The highlight", zoom: "The zoom" }}
        />
      </Row>
      <div className="ap-chips">
        {filterStyleOptions.map((option) => {
          const on = selected.includes(option);
          return (
            <button
              type="button"
              key={option}
              aria-pressed={on}
              className={on ? "ap-chip on" : "ap-chip"}
              onClick={() =>
                commit(
                  on
                    ? selected.filter((f) => f !== option)
                    : [...selected, option].sort(
                        (a, b) =>
                          filterStyleOptions.indexOf(a) - filterStyleOptions.indexOf(b)
                      )
                )
              }
            >
              <span className="ap-chip-name">{filterStyleLabels[option].label}</span>
              <span className="ap-chip-hint">{filterStyleLabels[option].hint}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export default function AppearanceSheet() {
  const hl = useHighlightSettingsStore();
  const mag = useMagnificationSettingsStore();
  const active = matchPreset(hl, mag);
  const [screen, setScreen] = useState<Screen>("root");

  const inkCount = hl.filter_style.length + mag.filter_style.length;

  const TITLES: Record<Exclude<Screen, "root">, string> = {
    box: "The box",
    pointer: "The pointer",
    zoom: "The zoom",
    motion: "Motion",
    ink: "Ink",
  };
  // The tab strip needs short labels — the full titles overflow 340px and clip "Ink" to "In".
  const TABS: Record<Exclude<Screen, "root">, string> = {
    box: "Box",
    pointer: "Pointer",
    zoom: "Zoom",
    motion: "Motion",
    ink: "Ink",
  };

  if (screen === "root") {
    return (
      <div className="ap-sheet">
        <p className="ap-title">Pick what you can see best</p>
        <p className="ap-hint">The video above is the preview — it changes as you choose.</p>

        <div className="ap-tiles" role="radiogroup" aria-label="Appearance preset">
          {PRESETS.map((p) => (
            <PresetTile
              key={p.name}
              preset={p}
              selected={active?.name === p.name}
              onSelect={() => applyPreset(p)}
            />
          ))}
        </div>

        {/* Custom is a real state, not an absence. Settings persist, so a returning viewer
            who once nudged a slider would otherwise see four tiles, none selected, and no
            explanation. It reports; it is not a choice, so it is not a button. */}
        <p className="ap-status" aria-live="polite">
          {active ? active.hint : "Custom — your own settings."}
        </p>

        <NavRow
          label="Fine-tune"
          value={active ? active.name : "Custom"}
          onClick={() => setScreen("box")}
        />
      </div>
    );
  }

  return (
    <div className="ap-sheet">
      <div className="ap-head">
        <button type="button" className="ap-back" onClick={() => setScreen("root")}>
          <IconChevronLeft size={18} stroke={2} />
          Presets
        </button>
        <span className="ap-head-title">{TITLES[screen]}</span>
      </div>

      <div className="ap-tabs" role="tablist" aria-label="Fine-tune group">
        {(["box", "pointer", "zoom", "motion", "ink"] as const).map((s) => (
          <button
            type="button"
            key={s}
            role="tab"
            aria-selected={screen === s}
            className={screen === s ? "ap-tab sel" : "ap-tab"}
            onClick={() => setScreen(s)}
          >
            {TABS[s]}
          </button>
        ))}
      </div>

      <div className="ap-body">
        {screen === "box" && (
          <>
            <Row label="Border" value={`${hl.border_width}px`}>
              <Range
                label="Border width"
                min={0}
                max={12}
                step={1}
                value={hl.border_width}
                onChange={(border_width) => setHighlightSettings({ border_width })}
              />
            </Row>
            <Row label="Colour">
              <Swatches
                label="Border colour"
                colors={BORDER_COLORS}
                value={hl.border_color}
                onChange={(border_color) => setHighlightSettings({ border_color })}
              />
            </Row>
            <Row label="Fill" value={`${Math.round(hl.fill_opacity * 100)}%`}>
              <Range
                label="Fill opacity"
                min={0}
                max={1}
                step={0.05}
                value={hl.fill_opacity}
                onChange={(fill_opacity) => setHighlightSettings({ fill_opacity })}
              />
            </Row>
            <Row label="Fill colour">
              <Swatches
                label="Fill colour"
                colors={FILL_COLORS}
                value={hl.fill_color}
                onChange={(fill_color) => setHighlightSettings({ fill_color })}
              />
            </Row>
            <Row label="Shape">
              <Choice
                label="Highlight shape"
                options={shapeStyleOptions}
                value={hl.shape_style}
                onChange={(shape_style) => setHighlightSettings({ shape_style })}
                labels={{ "dynamic-square": "Follows the ink", "static-circle": "Fixed circle" }}
              />
            </Row>
            <Row label="Size" value={`${Math.round(hl.base_scale * 100)}%`}>
              <Range
                label="Highlight size"
                min={0.5}
                max={2}
                step={0.1}
                value={hl.base_scale}
                onChange={(base_scale) => setHighlightSettings({ base_scale })}
              />
            </Row>
          </>
        )}

        {screen === "pointer" && (
          <>
            <Row label="Style">
              <Choice
                label="Pointer style"
                options={pointerStyleOptions}
                value={hl.pointer_style}
                onChange={(pointer_style) => setHighlightSettings({ pointer_style })}
                labels={{ none: "Off", hand: "Hand", cursor: "Cursor" }}
              />
            </Row>
            <Row label="Size" value={`${Math.round(hl.pointer_scale * 100)}%`}>
              <Range
                label="Pointer size"
                min={0.5}
                max={3}
                step={0.1}
                value={hl.pointer_scale}
                disabled={hl.pointer_style === "none"}
                onChange={(pointer_scale) => setHighlightSettings({ pointer_scale })}
              />
            </Row>
          </>
        )}

        {screen === "zoom" && (
          <>
            <p className="ap-hint">Applies when you turn magnification on (Z).</p>
            <Row label="Strength" value={`${(1 + mag.zoom_strength).toFixed(1)}×`}>
              <Range
                label="Zoom strength"
                min={0}
                max={1}
                step={0.05}
                value={mag.zoom_strength}
                onChange={(zoom_strength) => setMagnificationSettings({ zoom_strength })}
              />
            </Row>
            <Row label="Speed" value={`${mag.zoom_speed}×`}>
              <Range
                label="Zoom speed"
                min={0.5}
                max={3}
                step={0.1}
                value={mag.zoom_speed}
                onChange={(zoom_speed) => setMagnificationSettings({ zoom_speed })}
              />
            </Row>
            <Row label="Contrast" value={`${mag.contrast.toFixed(2)}×`}>
              <Range
                label="Zoom contrast"
                min={1}
                max={3}
                step={0.05}
                value={mag.contrast}
                onChange={(contrast) => setMagnificationSettings({ contrast })}
              />
            </Row>
            <Row label="Pause">
              <Choice
                label="Pause the video when zooming in"
                options={["off", "on"] as const}
                value={mag.pause_on_zoom ? "on" : "off"}
                onChange={(v) => setMagnificationSettings({ pause_on_zoom: v === "on" })}
                labels={{ off: "Keep playing", on: "Pause on zoom" }}
              />
            </Row>
          </>
        )}

        {screen === "motion" && (
          <>
            <p className="ap-hint">
              Off by default. A pulse can help you find the box — but it is motion, and motion
              harms some viewers. Turning it on here overrides your system's reduce-motion
              setting.
            </p>
            <Row label="Pulse">
              <Choice
                label="Pulse"
                options={animationStyleOptions}
                value={hl.animation_style}
                onChange={(animation_style) => setHighlightSettings({ animation_style })}
                labels={{ none: "Off", pulse: "On" }}
              />
            </Row>
            <Row label="Speed" value={`${hl.animation_speed}×`}>
              <Range
                label="Pulse speed"
                min={0.5}
                max={3}
                step={0.1}
                value={hl.animation_speed}
                disabled={hl.animation_style === "none"}
                onChange={(animation_speed) => setHighlightSettings({ animation_speed })}
              />
            </Row>
          </>
        )}

        {screen === "ink" && <InkScreen />}
      </div>

      <p className="ap-foot">
        {inkCount > 0 ? `Ink: ${inkCount} on` : "No ink filters"} ·{" "}
        {active ? active.name : "Custom"}
      </p>
    </div>
  );
}
