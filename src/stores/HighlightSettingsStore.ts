// Ported from VeasyGuide. Changes vs original:
// - localStorage instead of sessionStorage (settings should survive across visits)
// - option arrays are `as const`, so T* types are real unions (they degraded to
//   plain `string` in the original)
// - devtools middleware dropped (study debugging aid)
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createSelectors } from "./createSelectors";

export const pointerStyleOptions = ["none", "cursor", "hand"] as const;
export const animationStyleOptions = ["none", "pulse"] as const;
export const shapeStyleOptions = ["static-circle", "dynamic-square"] as const;

// Enhance filters, applied to a canvas copy of the video region (see SVGFilters).
// Renamed from the study's `thicker` / `thicker-[dark]`, which said what they did to
// pixels rather than when to use them — and whose `[...]` was fragile inside url(#…).
export const filterStyleOptions = ["bold-dark", "bold-light", "sharpen", "invert"] as const;
export type TFilterStyle = (typeof filterStyleOptions)[number];

export const filterStyleLabels: Record<TFilterStyle, { label: string; hint: string }> = {
  "bold-dark": { label: "Bolder ink", hint: "Thickens dark writing on a light slide" },
  "bold-light": { label: "Bolder ink (dark slide)", hint: "Thickens light writing on a dark slide" },
  sharpen: { label: "Sharpen", hint: "Edge enhancement — crisper strokes and text" },
  invert: { label: "Invert", hint: "Inverts colours in the enhanced region" },
};

// Drop anything persisted from an older build (the filter ids changed).
export const sanitizeFilters = (list: readonly string[]): TFilterStyle[] =>
  list.filter((f): f is TFilterStyle =>
    (filterStyleOptions as readonly string[]).includes(f)
  );

export type TPointerStyle = (typeof pointerStyleOptions)[number];
export type TAnimationStyle = (typeof animationStyleOptions)[number];
export type TShapeStyle = (typeof shapeStyleOptions)[number];

const initialState = {
  fill_color: "#ffcc00",
  fill_opacity: 0.15,
  base_size: 50,
  base_scale: 1,
  filter_style: [] as TFilterStyle[],
  shape_style: "dynamic-square" as TShapeStyle,
  border_width: 4,
  border_color: "#ff0000",
  pointer_style: "hand" as TPointerStyle,
  pointer_scale: 1,
  animation_style: "none" as TAnimationStyle,
  animation_speed: 1,
};

export type THighlightSettings = typeof initialState;

export const useHighlightSettingsStore = createSelectors(
  create<THighlightSettings>()(
    persist(() => initialState, {
      name: "highlight-settings",
      storage: createJSONStorage(() => localStorage),
    })
  )
);

export const resetHighlightSettings = () => {
  useHighlightSettingsStore.setState(initialState);
};

export const setHighlightSettings = (newSettings: Partial<THighlightSettings>) => {
  useHighlightSettingsStore.setState((state) => ({ ...state, ...newSettings }));
};
