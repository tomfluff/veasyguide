// Ported from VeasyGuide unchanged (explicit null return added for exhaustiveness).
import type { TPointerStyle } from "../stores/HighlightSettingsStore";

import cursorIcon from "../assets/cursor.svg";
import handIcon from "../assets/hand.svg";

type Props = {
  style: TPointerStyle;
};

const IndicatorPointer = ({ style }: Props) => {
  if (style === "cursor") return <img src={cursorIcon} alt="cursor" className="cursor" />;
  if (style === "hand") return <img src={handIcon} alt="hand" className="hand" />;
  return null;
};

export default IndicatorPointer;
