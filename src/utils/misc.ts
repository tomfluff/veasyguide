// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// Ported from VeasyGuide frontend/src/utils/Misc.ts (study-only calcTimeSpan dropped).

export const convertSecondsToTimecode = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds)) return "00:00";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  let timecode = "";
  if (hours > 0) timecode += `${hours.toString().padStart(2, "0")}:`;
  timecode += `${minutes.toString().padStart(2, "0")}:${remainingSeconds
    .toString()
    .padStart(2, "0")}`;
  return timecode;
};

export const convertColorToRGBA = (color: string, opacity: number): string => {
  const hex = color.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity.toFixed(2)})`;
};

export const convertToTitleCase = (str: string): string =>
  str
    .toLowerCase()
    .split(/[ -]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
