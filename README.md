# VeasyGuide

**[Try it → veasyguide.github.io/app](https://veasyguide.github.io/app/)**

[![The VeasyGuide web app: a lecture slide with the instructor's handwriting highlighted, and a
Moments sidebar listing each detected action with its timestamp](docs/media/web_app_demo_poster.png)](https://veasyguide.github.io/static/videos/web_app_demo.mp4)

*↑ [Watch the 80-second demo](https://veasyguide.github.io/static/videos/web_app_demo.mp4).* A
lecture is dropped onto the page; analysis starts at once and playback begins within seconds.
Each thing the instructor writes is highlighted in place and listed in the Moments sidebar with
its timestamp and screen position. (The clip is also in
[`docs/media/`](docs/media/web_app_demo.mp4), so a clone has it offline.)

Lecture videos are hard to follow when you can't see where the instructor is pointing.
VeasyGuide watches the video for you: it finds every moment the instructor writes, points, or
sketches, then highlights that spot and magnifies it as you watch. Built for low-vision
learners; useful to anyone who has lost the thread of a lecture.

Everything runs **in your browser** — drop in a video and it's analysed on your own machine.
No upload, no account, no server ever sees the video.

VeasyGuide is the successor to a [research study](https://veasyguide.github.io/) on
lecture-video accessibility for low-vision learners: the detection pipeline and player were
validated in that study, then rebuilt here as a standalone tool anyone can open and use.

## How it works

On a slide, whatever changes is whatever matters. A pen stroke, a cursor, a sketch — they're
the only things moving against a static slide. So VeasyGuide decodes sampled frames with
WebCodecs, diffs them, groups the changed regions into events, and that is the detection — no
machine-learning model, nothing to download. Because there's no model, the whole thing runs
client-side, which is why your video never leaves your device. Analysis streams ahead of
playback, so a long lecture doesn't mean a long wait.

Deeper dives live in [`docs/`](docs/README.md):

| | |
|---|---|
| [architecture.md](docs/architecture.md) | How a dropped video becomes highlights on screen |
| [decisions.md](docs/decisions.md) | Why each major call was made, and what we rejected |
| [parameters.md](docs/parameters.md) | Every analysis parameter, and the reasoning behind it |
| [research-data.md](docs/research-data.md) | Data captured for future ML — and the privacy line |
| [debug-tools.md](docs/debug-tools.md) | `?debug` / `?research` / `?snippets`, and honest benchmarking |
| [porting-notes.md](docs/porting-notes.md) | Bugs found in the original study code |

## The original analyzer

Detection here is a TypeScript reimplementation of the study's offline Python pipeline. That
original script is kept in [`python-analyzer/`](python-analyzer/) for provenance and
reproducibility — same detection idea (frame-diff → region-of-interest graph → activity
typing), runnable on its own with its own requirements and instructions. It's the reference
the browser port is checked against.

## Requirements

A Chromium browser (Chrome, Edge or Arc) is what it's built and tested against. Firefox has
shipped WebCodecs since 2024 and works too, unbenchmarked. Your video needs a codec your
machine can decode — H.264, VP9 and AV1 work; HEVC/H.265 often doesn't.

## Develop

Requires Node 22+.

```bash
npm install
npm run dev        # http://localhost:5173
```

Drop a lecture video onto the page. A `?test=<name>` query param dev-loads a clip from
`public/_test/` for headless smoke tests (DEV only, never shipped).

Run the pipeline/clusterer self-check (no browser needed):

```bash
node --experimental-strip-types src/analyzer/selfcheck.ts
```

## Build & deploy

```bash
npm run typecheck  # tsc -b
npm run build      # tsc + vite build → dist/ (static site)
npm run preview
```

Typecheck with `npm run typecheck`, never `tsc --noEmit`: the root `tsconfig.json` is
solution-style (`"files": []` + references), so `--noEmit` there checks **nothing** — it finds
no files, exits 0, and looks just like a pass. Only build mode (`tsc -b`) follows the
references to the projects that hold the code.

Pushing to `main` builds and publishes to
[veasyguide.github.io/app](https://veasyguide.github.io/app/) via GitHub Pages
(`.github/workflows/deploy.yml`).

## License

[AGPL-3.0](LICENSE). Because it's network-served software, the app links back to this source
from its About panel — which is what the AGPL asks of a hosted app.
