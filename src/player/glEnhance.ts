// GPU enhance renderer. The enhance filters were SVG reference filters applied via
// CSS `filter: url(#…)` — and reference filters (feConvolveMatrix especially) run in
// Chromium's SOFTWARE filter path, re-executed every frame on the CPU. This class
// renders the same effects as WebGL fragment shaders instead: per-frame cost becomes
// a texture upload (GPU-GPU for <video>) and a couple of draw calls.
//
// Effects (matching the SVG defs in SVGFilters.tsx, which remain as the no-WebGL
// fallback):
//   bold-dark   erode  (3×3 min)  with the same pre/post contrast stretch + saturate
//   bold-light  dilate (3×3 max)  ditto
//   sharpen     3×3 unsharp kernel  [0 -1 0; -1 5 -1; 0 -1 0]
//   invert      colour inversion
//   contrast    linear contrast about 0.5 (the magnifier's slider)
//
// The pre-stretch is monotonic increasing, so min/max commute with it — the whole
// bold chain folds into a single morphology pass.

import type { TFilterStyle } from "../stores/HighlightSettingsStore";

const VERT = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// uSrcOff/uSrcScale map canvas UV -> source-texture UV, so a pass can read a CROP of
// the video (the highlight enhances a region, not the whole frame). Identity when the
// pass reads a full-canvas intermediate texture.

// Pass 1 (optional): morphology + stretch + saturate (the "bolder ink" filters).
const FRAG_MORPH = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uSrcOff;
uniform vec2 uSrcScale;
uniform float uMode; // 0 = erode (min), 1 = dilate (max)
vec3 stretched(vec2 uv) {
  return texture2D(uTex, uSrcOff + uv * uSrcScale).rgb * 0.8 + 0.2;
}
void main() {
  vec3 m = stretched(vUV);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec3 s = stretched(vUV + vec2(float(dx), float(dy)) * uTexel);
      m = uMode < 0.5 ? min(m, s) : max(m, s);
    }
  }
  vec3 c = m * 1.5 - 0.25;
  float grey = dot(c, vec3(0.213, 0.715, 0.072));
  c = clamp(grey + (c - grey) * 2.0, 0.0, 1.0); // saturate(2)
  gl_FragColor = vec4(c, 1.0);
}`;

// Pass 2: sharpen (optional) + invert + contrast, all point/kernel ops in one pass.
const FRAG_FINISH = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uSrcOff;
uniform vec2 uSrcScale;
uniform float uSharpen;  // 0 or 1
uniform float uInvert;   // 0 or 1
uniform float uContrast; // 1 = none
uniform float uFlipY;    // 1 when rendering to the canvas (WebGL is y-up)
vec3 tap(vec2 uv) { return texture2D(uTex, uSrcOff + uv * uSrcScale).rgb; }
void main() {
  vec2 uv = uFlipY > 0.5 ? vec2(vUV.x, 1.0 - vUV.y) : vUV;
  vec3 c = tap(uv);
  if (uSharpen > 0.5) {
    vec3 s = c * 5.0
      - tap(uv + vec2(uTexel.x, 0.0)) - tap(uv - vec2(uTexel.x, 0.0))
      - tap(uv + vec2(0.0, uTexel.y)) - tap(uv - vec2(0.0, uTexel.y));
    c = clamp(s, 0.0, 1.0);
  }
  if (uInvert > 0.5) c = 1.0 - c;
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(c, 1.0);
}`;

export type EnhanceOps = {
  filters: TFilterStyle[];
  contrast?: number;
  /** Source crop in native video pixels; whole frame when omitted. */
  source?: { x: number; y: number; width: number; height: number };
};

export class GLEnhancer {
  private gl: WebGLRenderingContext;
  private morphProg: WebGLProgram;
  private finishProg: WebGLProgram;
  private videoTex: WebGLTexture;
  private fboTex: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private fboW = 0;
  private fboH = 0;

  static create(canvas: HTMLCanvasElement): GLEnhancer | null {
    try {
      const gl = canvas.getContext("webgl", {
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      });
      return gl ? new GLEnhancer(gl) : null;
    } catch {
      return null;
    }
  }

  private constructor(gl: WebGLRenderingContext) {
    this.gl = gl;
    this.morphProg = this.program(VERT, FRAG_MORPH);
    this.finishProg = this.program(VERT, FRAG_FINISH);

    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const prog of [this.morphProg, this.finishProg]) {
      const loc = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    this.videoTex = this.texture();
    this.fboTex = this.texture();
    this.fbo = gl.createFramebuffer()!;
  }

  /** Render one video frame with the given ops into the canvas. */
  draw(video: HTMLVideoElement, ops: EnhanceOps): void {
    const gl = this.gl;
    const W = gl.canvas.width;
    const H = gl.canvas.height;
    if (!W || !H || !video.videoWidth) return;

    // Upload the current frame (GPU-side copy for <video> sources).
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);

    // Canvas UV -> video UV mapping for the source crop.
    const s = ops.source;
    const srcOff: [number, number] = s
      ? [s.x / video.videoWidth, s.y / video.videoHeight]
      : [0, 0];
    const srcScale: [number, number] = s
      ? [s.width / video.videoWidth, s.height / video.videoHeight]
      : [1, 1];

    const bold = ops.filters.includes("bold-dark")
      ? 0
      : ops.filters.includes("bold-light")
        ? 1
        : -1;
    let src = this.videoTex;
    let fromVideo = true; // whether the next pass samples the (cropped) video

    if (bold >= 0) {
      this.ensureFbo(W, H);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, W, H);
      gl.useProgram(this.morphProg);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(gl.getUniformLocation(this.morphProg, "uTex"), 0);
      gl.uniform2f(
        gl.getUniformLocation(this.morphProg, "uTexel"),
        1 / W,
        1 / H
      );
      gl.uniform2f(gl.getUniformLocation(this.morphProg, "uSrcOff"), ...srcOff);
      gl.uniform2f(gl.getUniformLocation(this.morphProg, "uSrcScale"), ...srcScale);
      gl.uniform1f(gl.getUniformLocation(this.morphProg, "uMode"), bold);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      src = this.fboTex;
      fromVideo = false;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.finishProg);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(gl.getUniformLocation(this.finishProg, "uTex"), 0);
    gl.uniform2f(gl.getUniformLocation(this.finishProg, "uTexel"), 1 / W, 1 / H);
    gl.uniform2f(
      gl.getUniformLocation(this.finishProg, "uSrcOff"),
      ...(fromVideo ? srcOff : ([0, 0] as [number, number]))
    );
    gl.uniform2f(
      gl.getUniformLocation(this.finishProg, "uSrcScale"),
      ...(fromVideo ? srcScale : ([1, 1] as [number, number]))
    );
    gl.uniform1f(
      gl.getUniformLocation(this.finishProg, "uSharpen"),
      ops.filters.includes("sharpen") ? 1 : 0
    );
    gl.uniform1f(
      gl.getUniformLocation(this.finishProg, "uInvert"),
      ops.filters.includes("invert") ? 1 : 0
    );
    gl.uniform1f(gl.getUniformLocation(this.finishProg, "uContrast"), ops.contrast ?? 1);
    gl.uniform1f(gl.getUniformLocation(this.finishProg, "uFlipY"), 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.videoTex);
    gl.deleteTexture(this.fboTex);
    gl.deleteFramebuffer(this.fbo);
    gl.deleteProgram(this.morphProg);
    gl.deleteProgram(this.finishProg);
  }

  private ensureFbo(w: number, h: number): void {
    const gl = this.gl;
    if (this.fboW === w && this.fboH === h) return;
    this.fboW = w;
    this.fboH = h;
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh) ?? "shader compile failed");
      }
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) ?? "program link failed");
    }
    gl.useProgram(prog);
    return prog;
  }
}

/**
 * Drive a render callback once per NEW video frame (requestVideoFrameCallback),
 * falling back to requestAnimationFrame. rVFC alone can cut redraw work ~2-5×:
 * a 30fps video on a 144Hz display repaints 30 times/s instead of 144 — and not
 * at all while paused.
 */
export function driveFrames(video: HTMLVideoElement, render: () => void): () => void {
  render(); // paint the current frame immediately (also covers paused video)
  if ("requestVideoFrameCallback" in video) {
    let handle = 0;
    const loop = () => {
      render();
      handle = video.requestVideoFrameCallback(loop);
    };
    handle = video.requestVideoFrameCallback(loop);
    return () => video.cancelVideoFrameCallback(handle);
  }
  let raf = 0;
  const loop = () => {
    render();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}
