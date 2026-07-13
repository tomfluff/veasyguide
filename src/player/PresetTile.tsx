// A preset, drawn as a picture of itself.
//
// The four presets used to be four text buttons. But "Bold" versus "High contrast" is a
// VISUAL difference, and asking a low-vision viewer to read the words and imagine the result
// inverts the whole point of the product. Each tile renders a miniature slide with the
// highlight drawn at that preset's own settings, so the choice is made by sight.
import type { Preset } from "./presets";

// Border width does NOT scale linearly into the tile. A 4px border on a ~900px-wide video is
// 0.4px in a 90px tile — invisible, and all four presets would look identical. This maps the
// 0-12px range onto 0-6px, which preserves the ORDER (Minimal < Standard < Bold) at a size
// the eye can actually resolve. It is a caricature, deliberately.
const miniBorder = (px: number) => (px === 0 ? 0 : Math.max(1, Math.round(px / 2)));

export default function PresetTile({
  preset,
  selected,
  onSelect,
}: {
  preset: Preset;
  selected: boolean;
  onSelect: () => void;
}) {
  const h = preset.highlight;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={selected ? "ap-tile sel" : "ap-tile"}
    >
      <span className="ap-mini" aria-hidden="true">
        <span
          className="ap-mini-box"
          style={{
            border: h.border_width
              ? `${miniBorder(h.border_width)}px solid ${h.border_color}`
              : "none",
          }}
        >
          {/* fill_opacity dims the fill only, never the border — so the fill is its own
              layer rather than an opacity on the box. */}
          <span
            className="ap-mini-fill"
            style={{ backgroundColor: h.fill_color, opacity: h.fill_opacity }}
          />
        </span>
        {h.pointer_style !== "none" && (
          <span
            className="ap-mini-ptr"
            style={{ fontSize: `${11 * h.pointer_scale}px` }}
          >
            {h.pointer_style === "hand" ? "✋" : "➤"}
          </span>
        )}
      </span>
      <span className="ap-tile-name">{preset.name}</span>
    </button>
  );
}
