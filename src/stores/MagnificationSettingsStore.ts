// Ported from VeasyGuide. Same changes as HighlightSettingsStore: localStorage,
// no devtools; filter types re-exported from the highlight store as before.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createSelectors } from "./createSelectors";
import { filterStyleOptions, type TFilterStyle } from "./HighlightSettingsStore";

export { filterStyleOptions };
export type { TFilterStyle };

const initialState = {
  zoom_strength: 0.5,
  zoom_speed: 1,
  pause_on_zoom: false,
  // Was `sharpness`, but it drives CSS contrast() — it never sharpened anything, and
  // its label printed `sharpness - 1` (so "1x" meant contrast 2). Renamed to what it
  // is; real edge enhancement is now the `sharpen` enhance filter.
  contrast: 1,
  filter_style: [] as TFilterStyle[],
};

export type TMagnificationSettings = typeof initialState;

export const useMagnificationSettingsStore = createSelectors(
  create<TMagnificationSettings>()(
    persist(() => initialState, {
      name: "magnification-settings",
      storage: createJSONStorage(() => localStorage),
    })
  )
);

export const resetMagnificationSettings = () => {
  useMagnificationSettingsStore.setState(initialState);
};

export const setMagnificationSettings = (
  newSettings: Partial<TMagnificationSettings>
) => {
  useMagnificationSettingsStore.setState((state) => ({ ...state, ...newSettings }));
};

// Dev-only handle: settings live inside popovers that close on focus loss, which makes
// them awkward to drive from an automated browser. Never shipped.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__magSettings = {
    get: () => useMagnificationSettingsStore.getState(),
    set: setMagnificationSettings,
  };
}
