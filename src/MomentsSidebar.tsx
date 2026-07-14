// The moments, as a table of contents. The timeline lane is a map (proportional, marks
// merge when they collide); this list is the index — every moment gets the same full-width
// row with a thumbnail of the annotated region, so you choose by sight, not by timestamp.
import { useEffect, useRef } from "react";
import type { Activity } from "./analyzer/types";
import { convertSecondsToTimecode } from "./utils/misc";
import { seekTargetFor } from "./player/moments";

type Props = {
  activities: Activity[];
  // activity id → object URL of its thumbnail crop. Filled after analysis completes;
  // rows show a placeholder until then.
  thumbs: ReadonlyMap<number, string>;
  current: Activity | null;
  done: boolean;
  canPlay: boolean;
  lead: number;
  onJump: (t: number) => void;
};

export default function MomentsSidebar({ activities, thumbs, current, done, canPlay, lead, onJump }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const currIndex = current ? activities.indexOf(current) : -1;

  // Follow playback: keep the current row in view. "nearest" so it never yanks the list
  // when the row is already visible.
  useEffect(() => {
    if (currIndex < 0) return;
    listRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currIndex]);

  return (
    // Keys pressed while focus is in the sidebar belong to the sidebar. Without this,
    // Space on a row also reaches the player's document-level hotkeys and toggles play
    // on top of the row's own seek.
    <aside className="moments-side" onKeyDown={(e) => e.stopPropagation()}>
      <div className="side-head">
        <div className="side-title">Moments</div>
        <div className="side-pos" role="status">
          {activities.length === 0
            ? done ? "None found" : "Looking…"
            : currIndex >= 0
              ? <>Now at <b>{currIndex + 1}</b> of <b>{activities.length}</b>{done ? "" : "+"}</>
              : <><b>{activities.length}</b>{done ? "" : "+"} in this lecture</>}
        </div>
      </div>
      <div className="side-list" ref={listRef}>
        {activities.map((a, i) => {
          const now = i === currIndex;
          const url = thumbs.get(a.id);
          return (
            <button
              key={a.id}
              type="button"
              className={now ? "side-row now" : "side-row"}
              aria-current={now ? "true" : undefined}
              disabled={!canPlay}
              onClick={() => onJump(seekTargetFor(a, lead))}
              aria-label={`Moment ${i + 1}, ${convertSecondsToTimecode(a.start)}, ${(a.end - a.start).toFixed(1)} seconds`}
            >
              {url ? (
                <img className="side-thumb" src={url} alt="" />
              ) : (
                <span className="side-thumb ph" aria-hidden="true">{i + 1}</span>
              )}
              <span className="side-meta">
                {now && <span className="side-now">Now</span>}
                <span className="side-t">{convertSecondsToTimecode(a.start)}</span>
                <span className="side-d">{(a.end - a.start).toFixed(1)}s</span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
