// GPU port of the per-pixel half of pipeline.ts (toGray, diffMask, dilate).
//
// Why: profiling a real analysis run put 0% of the wall time in decode (Mediabunny
// pipelines it off-thread), 39% in `sample.draw(ctx)` + `getImageData` and 61% in the
// JS pixel loops. Both of those are exactly what a fragment shader removes: the decoded
// frame is already a GPU texture, so we upload it as one (no readback of the full frame),
// run the diff chain as draw calls, and read back only the finished mask.
//
// What stays on the CPU: componentRegions (flood fill + Hu moments) — sequential,
// region-shaped work that a fragment shader is bad at, and already cheap (~0.4 ms/frame).
//
// Parity with the CPU path is close but not bit-exact: the downscale is a GPU mipmap
// (trilinear) rather than the 2D canvas' resampler, so a handful of pixels land either
// side of the diff threshold. Region boxes move by a pixel at most. pipeline.ts remains
// the reference implementation and the fallback when WebGL2 is missing.

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Downscale the full-res frame to analysis resolution: an explicit box filter averaging
// the source texels each analysis pixel covers (uRatio = source size / analysis size).
// Trilinear mipmapping was the obvious alternative and it measurably over-blurs — it cost
// ~4% of detected activities, because a softer downscale pushes marginal frame diffs under
// the threshold. 4x4 taps track the 2D canvas' resampler closely enough to match it.
const FRAG_DOWN = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uSrcTexel; // 1 / source size
uniform vec2 uRatio;    // source size / analysis size
out vec4 oCol;
void main() {
  vec4 sum = vec4(0.0);
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      // Sample centres of the 16 sub-cells of this analysis pixel's source footprint.
      vec2 off = (vec2(float(x), float(y)) + 0.5) / 4.0 - 0.5;
      sum += texture(uTex, vUV + off * uRatio * uSrcTexel);
    }
  }
  oCol = sum / 16.0;
}`;

// The diff pass. Output channels, chosen so ONE readback carries everything the CPU
// still needs:
//   R = raw diff mask (0 or 1)
//   G = |gray delta|            -> Region.meanDiff
//   B = unused
//   A = gray of the current frame -> the debug composite
//
// B used to carry a per-pixel HSV scene score, summed on readback into PySceneDetect's
// contentScore. That detector is gone (see pipeline.ts / decisions.md): a mean over every
// pixel cannot see a slide change on a deck with a consistent style. Scene cuts are now read
// off the mask's occupancy, which the readback below already walks.
const FRAG_DIFF = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform float uThresh; // diff threshold, 0..255
out vec4 oCol;

// Matches pipeline.ts toGray: OpenCV BGR2GRAY weights, truncated to an integer.
float gray255(vec3 c) { return floor(dot(c * 255.0, vec3(0.299, 0.587, 0.114))); }

void main() {
  vec3 a = texture(uPrev, vUV).rgb;
  vec3 b = texture(uCur, vUV).rgb;

  float mag = abs(gray255(a) - gray255(b));

  oCol = vec4(mag >= uThresh ? 1.0 : 0.0, mag / 255.0, 0.0, gray255(b) / 255.0);
}`;

// 3x3 neighbourhood op on the mask in R; G/B/A pass through from the centre pixel.
// uMode 0 = box3Blur (keep when >= 3 of 9 neighbours are set), 1 = dilate (3x3 max).
// Both leave a 1px border cleared, exactly as the CPU versions do.
const FRAG_MASK = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uMode;
out vec4 oCol;
void main() {
  vec4 c = texture(uTex, vUV);
  vec2 px = vUV / uTexel;
  vec2 dim = vec2(1.0) / uTexel;
  if (px.x < 1.0 || px.y < 1.0 || px.x > dim.x - 1.0 || px.y > dim.y - 1.0) {
    oCol = vec4(0.0, c.gba);
    return;
  }
  float sum = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      sum += texture(uTex, vUV + vec2(float(dx), float(dy)) * uTexel).r;
    }
  }
  float on = uMode < 0.5 ? (sum >= 3.0 ? 1.0 : 0.0) : (sum > 0.0 ? 1.0 : 0.0);
  oCol = vec4(on, c.gba);
}`;

export type GLFrame = {
  mask: Uint8Array; // 0/1, blurred + dilated
  mag: Uint8Array; // |gray delta| per pixel
  gray: Uint8Array; // current frame, for the debug composite
  frac: number; // share of the frame the mask covers — the scene-cut signal
};

export class GLAnalyzer {
  private gl: WebGL2RenderingContext;
  private w: number;
  private h: number;
  private downProg: WebGLProgram;
  private diffProg: WebGLProgram;
  private maskProg: WebGLProgram;
  private videoTex: WebGLTexture;
  private frames: [WebGLTexture, WebGLTexture]; // prev / cur, ping-ponged
  private work: [WebGLTexture, WebGLTexture]; // mask passes, ping-ponged
  private fbo: WebGLFramebuffer;
  private cur = 0; // index into `frames` holding the frame just uploaded
  private hasPrev = false;
  private rgba: Uint8Array;
  private mask: Uint8Array;
  private mag: Uint8Array;
  private gray: Uint8Array;

  static create(w: number, h: number): GLAnalyzer | null {
    try {
      const gl = new OffscreenCanvas(w, h).getContext("webgl2");
      return gl ? new GLAnalyzer(gl, w, h) : null;
    } catch {
      return null;
    }
  }

  private constructor(gl: WebGL2RenderingContext, w: number, h: number) {
    this.gl = gl;
    this.w = w;
    this.h = h;
    this.downProg = this.program(FRAG_DOWN);
    this.diffProg = this.program(FRAG_DIFF);
    this.maskProg = this.program(FRAG_MASK);

    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const prog of [this.downProg, this.diffProg, this.maskProg]) {
      const loc = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    // The video texture is sampled between texels by the box filter, so it wants LINEAR;
    // the rest are exact-size render targets read at texel centres, so NEAREST is right.
    this.videoTex = this.texture(gl.LINEAR);
    this.frames = [this.target(), this.target()];
    this.work = [this.target(), this.target()];
    this.fbo = gl.createFramebuffer()!;
    gl.viewport(0, 0, w, h);

    const n = w * h;
    this.rgba = new Uint8Array(n * 4);
    this.mask = new Uint8Array(n);
    this.mag = new Uint8Array(n);
    this.gray = new Uint8Array(n);
  }

  /** Forget the previous frame — a new segment must not diff across its boundary. */
  reset(): void {
    this.hasPrev = false;
  }

  /**
   * Upload `src` as the current frame and run the diff chain against the previous one.
   * Returns null for the first frame after a reset (nothing to diff against yet).
   */
  process(src: VideoFrame, thresh: number, dilateIters: number): GLFrame | null {
    const gl = this.gl;

    // Upload at native resolution, then box-downscale into the frame texture.
    const next = 1 - this.cur;
    const sw = src.displayWidth;
    const sh = src.displayHeight;
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.pass(this.downProg, this.frames[next], [["uTex", this.videoTex]], (p) => {
      gl.uniform2f(gl.getUniformLocation(p, "uSrcTexel"), 1 / sw, 1 / sh);
      gl.uniform2f(gl.getUniformLocation(p, "uRatio"), sw / this.w, sh / this.h);
    });
    this.cur = next;

    if (!this.hasPrev) {
      this.hasPrev = true;
      return null;
    }

    const prev = this.frames[1 - this.cur];
    this.pass(this.diffProg, this.work[0], [["uPrev", prev], ["uCur", this.frames[this.cur]]], (p) => {
      gl.uniform1f(gl.getUniformLocation(p, "uThresh"), thresh);
    });

    // Blur, then `dilateIters` passes of 3x3 max — the same passes the CPU runs, so the
    // border handling and the effective kernel come out identical.
    let from = 0;
    for (let i = 0; i <= dilateIters; i++) {
      const mode = i === 0 ? 0 : 1; // first pass is the blur
      this.pass(this.maskProg, this.work[1 - from], [["uTex", this.work[from]]], (p) => {
        gl.uniform2f(gl.getUniformLocation(p, "uTexel"), 1 / this.w, 1 / this.h);
        gl.uniform1f(gl.getUniformLocation(p, "uMode"), mode);
      });
      from = 1 - from;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.work[from], 0);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, this.rgba);

    let on = 0;
    for (let i = 0, p = 0; i < this.mask.length; i++, p += 4) {
      const m = this.rgba[p] > 127 ? 1 : 0;
      this.mask[i] = m;
      on += m;
      this.mag[i] = this.rgba[p + 1];
      this.gray[i] = this.rgba[p + 3];
    }
    return { mask: this.mask, mag: this.mag, gray: this.gray, frac: on / this.mask.length };
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of [this.videoTex, ...this.frames, ...this.work]) gl.deleteTexture(t);
    gl.deleteFramebuffer(this.fbo);
    for (const p of [this.downProg, this.diffProg, this.maskProg]) gl.deleteProgram(p);
  }

  /** Render one full-screen pass of `prog` into `dst`, binding the given textures by name. */
  private pass(
    prog: WebGLProgram,
    dst: WebGLTexture,
    textures: [string, WebGLTexture][],
    uniforms?: (p: WebGLProgram) => void
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
    gl.useProgram(prog);
    textures.forEach(([name, tex], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(prog, name), unit);
    });
    uniforms?.(prog);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private target(): WebGLTexture {
    const gl = this.gl;
    const tex = this.texture(gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return tex;
  }

  private texture(filter: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private program(fs: string): WebGLProgram {
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
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) ?? "program link failed");
    }
    return prog;
  }
}
