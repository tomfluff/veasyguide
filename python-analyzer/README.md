# Original analyzer (Python)

The activity-detection script from the [VeasyGuide research study](https://veasyguide.github.io/),
kept here for provenance and reproducibility. This is the offline pipeline the in-browser
analyzer ([`../src/analyzer`](../src/analyzer)) was ported from: it reads a lecture video and
produces the same kind of result — scenes, plus pointing / marking / sketching / animation
activities with their positions, times and types.

It's the study code as it ran, with two deliberate changes:

- **OCR removed.** The original had an optional `easyocr` pass (off by default); it's gone,
  along with its dependency.
- **A command line instead of a hardcoded `main`.** The original looped over a fixed video
  name; this takes a path.

The Flask server, cloud storage, and study data that surrounded it in the original repo are
**not** included — this is just the analyzer.

## Install

Python 3.10+ recommended.

```bash
python -m venv .venv
# Windows:       .venv\Scripts\activate
# macOS / Linux: source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
python analyzer.py path/to/lecture.mp4 -o analysis.json
```

The output JSON holds the video metadata, the analysis parameters used, the detected
`scenes`, and the list of `activities` — each with position, size, start/end time, and a
`type` of `pointing`, `marking`, `sketching`, `animation` or `add_sub`.

## Files

| | |
|---|---|
| `analyzer.py` | The pipeline: scene detection, frame-pair sampling, frame-diff contours, the region-of-interest graph, and activity typing. Includes an optional `visualize()` that draws the detections onto a copy of the video (needs `moviepy` — commented in `requirements.txt`). |
| `roi.py` | The region-of-interest graph, node, and activity classes `analyzer.py` depends on. |

## Notes

- `opencv-python` (`cv2`) was missing from the original requirements even though the code
  imports it; it's pinned here explicitly.
- The detection defaults (sampling rate, area and distance thresholds) are the study's
  values — the same numbers documented in [`../docs/parameters.md`](../docs/parameters.md).
