// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// Player-space types. The analyzer works in downscaled analysis pixels; the player
// and overlays work in native video pixels (then scaled to the container by
// scaleRatio, as in the original VeasyGuide player).

import type { Activity, AnalysisMeta } from "../analyzer/types";

export type PlayerActivity = {
  id: number;
  start: number;
  end: number;
  pos: { x: number; y: number };
  dim: { width: number; height: number };
};

export function toPlayerActivity(a: Activity, meta: AnalysisMeta): PlayerActivity {
  const s = meta.scale;
  return {
    id: a.id,
    start: a.start,
    end: a.end,
    pos: { x: a.box.x * s, y: a.box.y * s },
    dim: { width: a.box.w * s, height: a.box.h * s },
  };
}
