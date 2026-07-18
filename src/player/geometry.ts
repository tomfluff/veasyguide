// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

// Where the picture actually sits inside its box.
//
// The analyzer reports activity boxes in VIDEO pixels. The highlight and the magnifier are
// positioned in SCREEN pixels. The picture is contain-fitted and centred inside its element,
// so the picture's top-left corner is NOT the element's top-left corner: a 4:3 lecture in a
// 16:9 player is pillarboxed, a wide video in a tall window is letterboxed. These three
// numbers are the conversion, and every overlay in the player depends on them.
//
//     screenX = leftShift + videoX * scaleRatio
//     screenY = topShift  + videoY * scaleRatio
//
//   PILLARBOX (video narrower than box)      LETTERBOX (video wider than box)
//   +----+-------------+----+                +--------------------------+
//   |    |             |    |                |//////////////////////////| <- topShift
//   |    |   picture   |    |                +--------------------------+
//   |    |             |    |                |         picture          |
//   +----+-------------+----+                +--------------------------+
//        ^ leftShift                         |//////////////////////////|
//                                            +--------------------------+
//
// Extracted from an inline useMemo so it can be tested. Get this wrong and the highlight is
// drawn tens of pixels away from the instructor's pen — silently, and worst for exactly the
// viewer who is relying on the highlight because they cannot easily find the pen themselves.
//
// NOTE ON WHAT TO MEASURE: pass the box the VIDEO ELEMENT occupies, not the player container.
// They coincide today only because the video is the container's only in-flow child. Any layout
// that puts something else in that flow breaks the assumption, not this function.

export type Letterbox = {
  leftShift: number; // px from the box's left edge to the picture's left edge
  topShift: number; // px from the box's top edge to the picture's top edge
  scaleRatio: number; // screen px per video px
};

const ZERO: Letterbox = { leftShift: 0, topShift: 0, scaleRatio: 0 };

export function computeLetterbox(
  boxWidth: number,
  boxHeight: number,
  videoWidth: number,
  videoHeight: number
): Letterbox {
  // A container that hasn't been measured yet reports 0. Returning a 0 scale collapses the
  // overlays to nothing, which is right: better invisible for one frame than drawn in the
  // wrong place.
  if (boxWidth <= 0 || boxHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) return ZERO;

  const scaleRatio = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);
  // Whichever axis isn't the limiting one gets the slack, split evenly. On the limiting axis
  // this rounds to 0, so there is no need to branch on which kind of boxing it is.
  return {
    leftShift: Math.round((boxWidth - videoWidth * scaleRatio) / 2),
    topShift: Math.round((boxHeight - videoHeight * scaleRatio) / 2),
    scaleRatio,
  };
}
