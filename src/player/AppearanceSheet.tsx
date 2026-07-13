// The Appearance sheet: four presets, a derived Custom, and a Customize disclosure.
//
// This replaces two popovers — "Highlight settings" and "Magnification settings" — which split
// the controls by which COMPONENT renders them rather than by what a viewer is trying to do.
// Someone who wants the box easier to see had to know that "make it bolder" lives under the
// sparkles icon while "make it bigger when it zooms" lives under the magnifier icon. The
// groups below are the questions a viewer actually asks.
//
// Every hint is visible text. There are no tooltips: a hover tooltip is invisible to a
// keyboard user, a screen-reader user and anyone driving a magnifier, which is the audience.
import { Button, Collapse, ColorSwatch, Group, Slider, Stack, Switch, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
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
import "./appearance.css";

const BORDER_COLORS = ["#ff0000", "#000000", "#0057ff", "#00a3a3", "#ffffff"];
const FILL_COLORS = ["#ffcc00", "#ffff00", "#00e5ff", "#ff8a00", "#ffffff"];

// One row: a label wide enough to scan down, then the control, then its value.
const Row = ({ label, children, value }: { label: string; children: React.ReactNode; value?: string }) => (
  <Group gap="sm" wrap="nowrap" align="center" className="ap-row">
    <Text className="ap-label">{label}</Text>
    <div className="ap-control">{children}</div>
    {value && <Text className="ap-value">{value}</Text>}
  </Group>
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
  <Group gap={6} role="radiogroup" aria-label={label}>
    {colors.map((c) => (
      <ColorSwatch
        key={c}
        component="button"
        color={c}
        size={28}
        role="radio"
        aria-checked={value === c}
        aria-label={c}
        onClick={() => onChange(c)}
        className={value === c ? "ap-swatch sel" : "ap-swatch"}
      />
    ))}
  </Group>
);

// Toggle chips for the enhance filters. These stay SEPARATE for the highlight and the
// magnifier: enhancement that helps under 1.7x magnification can look noisy at 1x, and a
// viewer may reasonably want it in one and not the other.
const InkChips = ({
  selected,
  onToggle,
}: {
  selected: readonly TFilterStyle[];
  onToggle: (next: TFilterStyle[]) => void;
}) => (
  <Stack gap={6}>
    {filterStyleOptions.map((option) => {
      const on = selected.includes(option);
      return (
        <Group key={option} gap="xs" wrap="nowrap" align="center">
          <Button
            variant={on ? "filled" : "default"}
            size="xs"
            aria-pressed={on}
            style={{ flex: "none", minWidth: 184 }}
            onClick={() =>
              onToggle(
                on
                  ? selected.filter((f) => f !== option)
                  : [...selected, option].sort(
                      (a, b) => filterStyleOptions.indexOf(a) - filterStyleOptions.indexOf(b)
                    )
              )
            }
          >
            {filterStyleLabels[option].label}
          </Button>
          <Text size="xs" c="dimmed">
            {filterStyleLabels[option].hint}
          </Text>
        </Group>
      );
    })}
  </Stack>
);

export default function AppearanceSheet() {
  const hl = useHighlightSettingsStore();
  const mag = useMagnificationSettingsStore();
  const active = matchPreset(hl, mag);
  const [open, disclosure] = useDisclosure(false);

  return (
    <Stack gap="sm" className="appearance-sheet">
      <div>
        <Text fw={650} size="md">
          Pick what you can see best
        </Text>
        <Text size="xs" c="dimmed">
          The video above is the preview — it changes as you choose.
        </Text>
      </div>

      <Group gap={8} role="radiogroup" aria-label="Appearance preset">
        {PRESETS.map((p) => {
          const sel = active?.name === p.name;
          return (
            <Button
              key={p.name}
              role="radio"
              aria-checked={sel}
              variant={sel ? "filled" : "default"}
              onClick={() => applyPreset(p)}
              className="ap-preset"
            >
              {p.name}
            </Button>
          );
        })}
        {/* Custom is a real, visible state — not an absence. Settings persist, so a returning
            user who once nudged a slider would otherwise see four cards, none selected, and no
            explanation of why. It is a status, not a choice, so it is not a button. */}
        <span className={active ? "ap-custom" : "ap-custom sel"} aria-live="polite">
          {active ? "Custom" : "Custom (yours)"}
        </span>
      </Group>

      <Text size="xs" c="dimmed">
        {active ? active.hint : "Your own settings. Pick a preset above to start over."}
      </Text>

      <Button
        variant="subtle"
        size="sm"
        onClick={disclosure.toggle}
        aria-expanded={open}
        leftSection={open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
        className="ap-customize"
      >
        Customize
      </Button>

      <Collapse in={open}>
        <Stack gap="lg" className="ap-groups">
          <section>
            <h4>The box</h4>
            <Row label="Border" value={`${hl.border_width}px`}>
              <Slider
                min={0}
                max={12}
                step={1}
                value={hl.border_width}
                onChange={(border_width) => setHighlightSettings({ border_width })}
                label={null}
                aria-label="Border width"
              />
            </Row>
            <Row label="Border colour">
              <Swatches
                label="Border colour"
                colors={BORDER_COLORS}
                value={hl.border_color}
                onChange={(border_color) => setHighlightSettings({ border_color })}
              />
            </Row>
            <Row label="Fill" value={`${Math.round(hl.fill_opacity * 100)}%`}>
              <Slider
                min={0}
                max={1}
                step={0.05}
                value={hl.fill_opacity}
                onChange={(fill_opacity) => setHighlightSettings({ fill_opacity })}
                label={null}
                aria-label="Fill opacity"
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
              <Group gap={6}>
                {shapeStyleOptions.map((s) => (
                  <Button
                    key={s}
                    size="xs"
                    variant={hl.shape_style === s ? "filled" : "default"}
                    aria-pressed={hl.shape_style === s}
                    onClick={() => setHighlightSettings({ shape_style: s })}
                  >
                    {s === "dynamic-square" ? "Follows the ink" : "Fixed circle"}
                  </Button>
                ))}
              </Group>
            </Row>
            <Row label="Size" value={`${Math.round(hl.base_scale * 100)}%`}>
              <Slider
                min={0.5}
                max={2}
                step={0.1}
                value={hl.base_scale}
                onChange={(base_scale) => setHighlightSettings({ base_scale })}
                label={null}
                aria-label="Highlight size"
              />
            </Row>
          </section>

          <section>
            <h4>The pointer</h4>
            <Row label="Style">
              <Group gap={6}>
                {pointerStyleOptions.map((s) => (
                  <Button
                    key={s}
                    size="xs"
                    variant={hl.pointer_style === s ? "filled" : "default"}
                    aria-pressed={hl.pointer_style === s}
                    onClick={() => setHighlightSettings({ pointer_style: s })}
                  >
                    {s === "none" ? "None" : s === "hand" ? "Hand" : "Cursor"}
                  </Button>
                ))}
              </Group>
            </Row>
            <Row label="Size" value={`${Math.round(hl.pointer_scale * 100)}%`}>
              <Slider
                min={0.5}
                max={3}
                step={0.1}
                value={hl.pointer_scale}
                onChange={(pointer_scale) => setHighlightSettings({ pointer_scale })}
                label={null}
                aria-label="Pointer size"
                disabled={hl.pointer_style === "none"}
              />
            </Row>
          </section>

          <section>
            <h4>The zoom</h4>
            <Text size="xs" c="dimmed" mb={6}>
              Applies when you turn magnification on (Z).
            </Text>
            <Row label="Strength" value={`${(1 + mag.zoom_strength).toFixed(1)}×`}>
              <Slider
                min={0}
                max={1}
                step={0.05}
                value={mag.zoom_strength}
                onChange={(zoom_strength) => setMagnificationSettings({ zoom_strength })}
                label={null}
                aria-label="Zoom strength"
              />
            </Row>
            <Row label="Speed" value={`${mag.zoom_speed}×`}>
              <Slider
                min={0.5}
                max={3}
                step={0.1}
                value={mag.zoom_speed}
                onChange={(zoom_speed) => setMagnificationSettings({ zoom_speed })}
                label={null}
                aria-label="Zoom speed"
              />
            </Row>
            <Row label="Contrast" value={`${mag.contrast.toFixed(2)}×`}>
              <Slider
                min={1}
                max={3}
                step={0.05}
                value={mag.contrast}
                onChange={(contrast) => setMagnificationSettings({ contrast })}
                label={null}
                aria-label="Zoom contrast"
              />
            </Row>
            <Row label="Pause on zoom">
              <Switch
                checked={mag.pause_on_zoom}
                onChange={(e) =>
                  setMagnificationSettings({ pause_on_zoom: e.currentTarget.checked })
                }
                aria-label="Pause the video when zooming in"
              />
            </Row>
          </section>

          <section>
            <h4>Motion</h4>
            <Text size="xs" c="dimmed" mb={6}>
              Off by default. A pulse can help you find the box — but it is motion, and motion
              is harmful to some viewers. Your system's reduce-motion setting is respected.
            </Text>
            <Row label="Pulse">
              <Group gap={6}>
                {animationStyleOptions.map((a) => (
                  <Button
                    key={a}
                    size="xs"
                    variant={hl.animation_style === a ? "filled" : "default"}
                    aria-pressed={hl.animation_style === a}
                    onClick={() => setHighlightSettings({ animation_style: a })}
                  >
                    {a === "none" ? "Off" : "On"}
                  </Button>
                ))}
              </Group>
            </Row>
            <Row label="Speed" value={`${hl.animation_speed}×`}>
              <Slider
                min={0.5}
                max={3}
                step={0.1}
                value={hl.animation_speed}
                onChange={(animation_speed) => setHighlightSettings({ animation_speed })}
                label={null}
                aria-label="Pulse speed"
                disabled={hl.animation_style === "none"}
              />
            </Row>
          </section>

          <section>
            <h4>Ink — inside the highlight</h4>
            <Text size="xs" c="dimmed" mb={6}>
              Alters the video inside the highlighted region. Which "bolder ink" you want
              depends on whether the slide is light or dark.
            </Text>
            <InkChips
              selected={hl.filter_style}
              onToggle={(filter_style) => setHighlightSettings({ filter_style })}
            />
          </section>

          <section>
            <h4>Ink — inside the zoom</h4>
            <Text size="xs" c="dimmed" mb={6}>
              Kept separate: enhancement that helps at 1.7× can look noisy at 1×.
            </Text>
            <InkChips
              selected={mag.filter_style}
              onToggle={(filter_style) => setMagnificationSettings({ filter_style })}
            />
          </section>
        </Stack>
      </Collapse>
    </Stack>
  );
}
