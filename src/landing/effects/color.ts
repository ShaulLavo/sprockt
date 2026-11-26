// Shared OKLab / OKLCH color math, deterministic PRNG, and GLSL shader helpers for landing effects.
// Ported cleanly to TypeScript from the Sheet and Biro / Precision Sheet effects runtime.

export interface EffectPalette {
  readonly bg: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly accent: string;
  readonly accentInk: string;
}

export type PaletteKind = "light" | "dark" | "colour";
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];
export type UniformValue = number | Vec2 | Vec3 | Vec4;

export function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}

function toLin(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function toGam(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

export function hexToRgb(hex: string): Vec3 {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) {
    h = h
      .slice(0, 3)
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const n = Number.parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(c: Vec3): string {
  return (
    "#" +
    c
      .map((v) =>
        Math.round(clamp(v, 0, 1) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

function rgbToLab(rgb: Vec3): Vec3 {
  const r = toLin(rgb[0]);
  const g = toLin(rgb[1]);
  const b = toLin(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function labToLinear(lab: Vec3): Vec3 {
  const [L, a, b] = lab;
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut(lin: Vec3): boolean {
  return (
    lin[0] >= -1e-4 &&
    lin[0] <= 1 + 1e-4 &&
    lin[1] >= -1e-4 &&
    lin[1] <= 1 + 1e-4 &&
    lin[2] >= -1e-4 &&
    lin[2] <= 1 + 1e-4
  );
}

function labToRgb(lab: Vec3): Vec3 {
  let lin = labToLinear(lab);
  if (!inGamut(lin)) {
    const L = clamp(lab[0], 0, 1);
    const a = lab[1];
    const b = lab[2];
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 18; i++) {
      const k = (lo + hi) / 2;
      if (inGamut(labToLinear([L, a * k, b * k]))) lo = k;
      else hi = k;
    }
    lin = labToLinear([L, a * lo, b * lo]);
  }
  return [toGam(clamp(lin[0], 0, 1)), toGam(clamp(lin[1], 0, 1)), toGam(clamp(lin[2], 0, 1))];
}

export const color = {
  rgb: hexToRgb,
  lab(c: string): Vec3 {
    return rgbToLab(hexToRgb(c));
  },
  fromLab(L: Vec3): string {
    return rgbToHex(labToRgb(L));
  },
  lch(c: string): Vec3 {
    const [L, a, b] = rgbToLab(hexToRgb(c));
    return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
  },
  fromLch([L, C, h]: Vec3): string {
    const r = (h * Math.PI) / 180;
    return color.fromLab([L, C * Math.cos(r), C * Math.sin(r)]);
  },
  mix(a: string, b: string, t = 0.5): string {
    const A = color.lab(a);
    const B = color.lab(b);
    return color.fromLab([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
  },
  lighten(c: string, d = 0.08): string {
    const [L, a, b] = color.lab(c);
    return color.fromLab([clamp(L + d, 0, 1), a, b]);
  },
  saturate(c: string, k = 1.2): string {
    const [L, C, h] = color.lch(c);
    return color.fromLch([L, C * k, h]);
  },
  withLightness(c: string, L: number): string {
    const [, C, h] = color.lch(c);
    return color.fromLch([clamp(L, 0, 1), C, h]);
  },
  isDark(c: string): boolean {
    return color.lab(c)[0] < 0.6;
  },
  chroma(c: string): number {
    return color.lch(c)[1];
  },
  hueDistance(a: string, b: string): number {
    const A = color.lch(a);
    const B = color.lch(b);
    if (A[1] < 0.03 || B[1] < 0.03) return 0;
    const d = Math.abs(A[2] - B[2]) % 360;
    return d > 180 ? 360 - d : d;
  },
};

export function normalizePalette(p: Partial<EffectPalette>): EffectPalette {
  const bg = p.bg ?? "#ffffff";
  const ink = p.ink ?? (color.isDark(bg) ? "#f2f2f2" : "#111111");
  return {
    bg,
    surface: p.surface ?? color.mix(bg, ink, 0.05),
    ink,
    muted: p.muted ?? color.mix(ink, bg, 0.45),
    accent: p.accent ?? ink,
    accentInk: p.accentInk ?? bg,
  };
}

export function paletteKind(p: EffectPalette): PaletteKind {
  const [L, C] = color.lch(p.bg);
  if (C > 0.07) return "colour";
  return L < 0.55 ? "dark" : "light";
}

export function hashSeed(s: number | string): number {
  if (typeof s === "number" && Number.isFinite(s)) return Math.abs(Math.floor(s)) % 10000;
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 10000;
}

export function mulberry32(seed: number | string): () => number {
  let a = (hashSeed(seed) * 2654435761) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function grainCSS(opacity = 0.08, frequency = 0.85): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='${frequency}' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 ${opacity * 2.2} 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>`;
  return `url("data:image/svg+xml,${svg.replace(/"/g, "'").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/ /g, "%20")}")`;
}

export const GLSL_LIB = /* glsl */ `
#if __VERSION__ >= 300
out vec4 fxColor;
uint fx_u32(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float fx_hash(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)) + ivec2(8192));
  return float(fx_u32(q.x + fx_u32(q.y + fx_u32(uint(u_seed) + 1u)))) * (1.0 / 4294967295.0);
}
#else
#define fxColor gl_FragColor
float fx_hash(vec2 p) {
  p = mod(floor(p), 1024.0);
  vec3 q = fract(vec3(p.x, p.y, p.x + p.y) * vec3(0.1031, 0.11369, 0.13787) + fract(u_seed * 0.00731));
  q += dot(q, q.yzx + 31.32);
  return fract((q.x + q.y) * q.z);
}
#endif
const float FX_TAU = 6.28318530718;
vec2 fx_grad(vec2 i) { float a = fx_hash(i) * FX_TAU; return vec2(cos(a), sin(a)); }
float fx_noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(fx_grad(i), f);
  float b = dot(fx_grad(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(fx_grad(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(fx_grad(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fx_fbm(vec2 p) {
  float s = fx_noise(p);
  p = mat2(1.6, 1.2, -1.2, 1.6) * p + 11.3;
  s += 0.5 * fx_noise(p);
  p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.7;
  s += 0.25 * fx_noise(p);
  return s / 1.2;
}
float fx_ign(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
float fx_grain(vec2 px, float frame) {
  vec2 o = vec2(frame * 41.0, frame * 73.0);
  return fx_hash(px + o) + fx_hash(px + o + vec2(1913.0, 2741.0)) - 1.0;
}
vec3 fx_srgb(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 fx_rgb(vec3 lab) {
  vec3 lms = vec3(lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z,
                  lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z,
                  lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z);
  lms = lms * lms * lms;
  vec3 c = vec3(dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
                dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
                dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010)));
  return fx_srgb(c);
}
vec3 fx_dither(vec3 c) {
  float n = fx_hash(gl_FragCoord.xy + vec2(3.0, 7.0)) + fx_ign(gl_FragCoord.xy) - 1.0;
  return c + n / 255.0;
}
vec2 fx_uv() { return vec2(gl_FragCoord.x / u_res.x, 1.0 - gl_FragCoord.y / u_res.y); }
vec2 fx_p() { return (gl_FragCoord.xy - 0.5 * u_res) / u_res.y; }
float fx_calm(vec2 uv, vec2 at, float r) {
  vec2 d = (uv - at) * vec2(u_res.x / u_res.y, 1.0);
  return 1.0 - smoothstep(r * 0.35, r, length(d));
}
`;

export const VERT_GL2 =
  "#version 300 es\nin vec2 a_pos;\nvoid main() { gl_Position = vec4(a_pos, 0.0, 1.0); }";
export const VERT_GL1 = "attribute vec2 a_pos;\nvoid main() { gl_Position = vec4(a_pos, 0.0, 1.0); }";

function glslType(v: UniformValue): string {
  if (typeof v === "number") return "float";
  if (v.length === 2) return "vec2";
  if (v.length === 3) return "vec3";
  return "vec4";
}

export function buildFragmentSource(
  gl2: boolean,
  paramKeys: readonly string[],
  custom: Readonly<Record<string, UniformValue>>,
  body: string,
): string {
  let s = gl2 ? "#version 300 es\n" : "";
  s += "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n";
  s += "uniform float u_time;\nuniform vec2 u_res;\nuniform float u_seed;\nuniform float u_dpr;\n";
  for (const k of paramKeys) s += `uniform float u_${k};\n`;
  for (const [k, v] of Object.entries(custom)) s += `uniform ${glslType(v)} ${k};\n`;
  return `${s}${GLSL_LIB}\n#line 1\n${body}`;
}

export function compileProgram(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  gl2: boolean,
  fragmentSource: string,
): { program: WebGLProgram; buffer: WebGLBuffer } | null {
  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  };
  const v = compile(gl.VERTEX_SHADER, gl2 ? VERT_GL2 : VERT_GL1);
  const f = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!v || !f) {
    if (v) gl.deleteShader(v);
    if (f) gl.deleteShader(f);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(v);
    gl.deleteShader(f);
    return null;
  }
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.bindAttribLocation(program, 0, "a_pos");
  gl.linkProgram(program);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    gl.deleteProgram(program);
    return null;
  }
  const buffer = gl.createBuffer();
  if (!buffer) {
    gl.deleteProgram(program);
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  return { program, buffer };
}

export function setUniform(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  loc: WebGLUniformLocation | null,
  v: UniformValue,
): void {
  if (!loc) return;
  if (typeof v === "number") gl.uniform1f(loc, v);
  else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
  else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
  else gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
}
