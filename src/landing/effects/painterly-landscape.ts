// painterly-landscape: faithful TypeScript port of #2 "Precision Sheet"'s 4-card atmospheric
// landscape shader. Uses a single transient offscreen WebGL context to bake each static landscape
// into a lightweight 2D canvas, staying well inside browser GPU context caps while delivering
// genuine OKLab brush-dab painterly depth in both light and Night Shift dark themes.
import {
  buildFragmentSource,
  color,
  compileProgram,
  grainCSS,
  hashSeed,
  mulberry32,
  normalizePalette,
  paletteKind,
  setUniform,
  type EffectPalette,
  type PaletteKind,
  type UniformValue,
} from "./color";

export interface PainterlyParams {
  readonly horizon: number;
  readonly slope: number;
  readonly side: number;
  readonly hillY: number;
  readonly blur: number;
  readonly brush: number;
  readonly drift: number;
  readonly calm: number;
  readonly calmX: number;
  readonly calmY: number;
}

const DEFAULT_PARAMS: PainterlyParams = {
  horizon: 0.62,
  slope: 0,
  side: 0,
  hillY: 0.3,
  blur: 1,
  brush: 0.35,
  drift: 0,
  calm: 0.4,
  calmX: 0.5,
  calmY: 0.55,
};

const PARAM_KEYS = Object.keys(DEFAULT_PARAMS) as readonly (keyof PainterlyParams)[];

const FRAG = /* glsl */ `
float dabs(float n, float k, float soft) {
  float q = n * k;
  return (floor(q) + smoothstep(0.5 - soft, 0.5 + soft, fract(q))) / k;
}
float strokes(vec2 p, vec2 d, float len, float wid, vec2 off, float soft) {
  vec2 r = vec2(dot(p, d), dot(p, vec2(-d.y, d.x))) + off;
  float n = fx_noise(vec2(r.x * len, r.y * wid)) + 0.5 * fx_noise(vec2(r.x * len * 2.3, r.y * wid * 2.2) + 5.3);
  return dabs(n, 2.5, soft);
}

void main() {
  vec2 uv = fx_uv();
  float asp = u_res.x / u_res.y;
  vec2 p = vec2((uv.x - 0.5) * asp, uv.y);
  float t = u_time * u_drift + u_seed * 0.0137;
  vec2 so = vec2(u_seed * 0.0213, u_seed * 0.0119);
  float bl = 0.25 + 0.75 * u_blur;
  float soft = 0.1 + 0.32 * u_blur;
  float hz = u_horizon;

  vec2 cd = (uv - vec2(u_calmX, u_calmY)) * vec2(asp * 0.45, 1.0);
  float cr = (0.2 + 0.32 * u_calm) * (1.0 + 0.4 * fx_fbm(p * vec2(1.4, 4.5) + so + vec2(t, 0.0)));
  float calm = (1.0 - smoothstep(cr * 0.45, cr, length(cd))) * min(1.0, u_calm * 2.5);
  float bk = u_brush * (1.0 - 0.85 * calm);

  float sy = clamp(uv.y / hz, 0.0, 1.0);
  vec3 col = mix(u_skyTop, u_skyMid, smoothstep(0.0, 0.75, sy));
  col = mix(col, u_skyLow, pow(smoothstep(0.3, 1.0, sy), 1.5));
  vec2 sun = u_sun + vec2(0.16 * sin(t * 2.1), 0.0);
  vec2 ds = (p - sun) * vec2(0.45, 1.0);
  float glow = exp(-dot(ds, ds) * 5.0);
  col = mix(col, u_glow, glow * 0.65);
  float sk = strokes(p, normalize(vec2(1.0, 0.1 * sin(p.x * 1.3 + so.x))), 1.2, 7.5, so + vec2(t * 0.5, 0.0), soft);
  col = mix(col, u_glow, clamp(sk, 0.0, 1.0) * 0.22 * bk * (0.3 + 0.7 * sy));
  col.x -= clamp(-sk, 0.0, 1.0) * 0.035 * bk;

  float farY = hz + 0.035 * fx_fbm(vec2(p.x * 1.8 + 3.1, 1.7) + so) + 0.01 * fx_noise(vec2(p.x * 7.0, 4.0) + so);
  float wf = 0.003 + 0.01 * bl;
  vec3 farCol = mix(u_far, u_skyLow, 0.3 * glow);
  col = mix(col, farCol, smoothstep(farY - wf, farY + wf, uv.y));

  float hm = hz + 0.07 + u_dir * 0.1 * p.x + 0.035 * fx_fbm(vec2(p.x * 1.4 + 9.1, 2.3) + so);
  float wm = 0.005 + 0.025 * bl;
  vec3 midCol = mix(u_mid, u_near, smoothstep(hm, hm + 0.35, uv.y) * 0.5);
  float ms = strokes(p, normalize(vec2(1.0, u_dir * 0.1)), 2.2, 15.0, so + 3.0 + vec2(t * 0.1, 0.0), soft);
  midCol = mix(midCol, u_far, clamp(ms, 0.0, 1.0) * 0.35 * bk);
  col = mix(col, midCol, smoothstep(hm - wm, hm + wm, uv.y));

  float ta = tan(radians(u_slope));
  float hy = hz + u_hillY - u_dir * ta * p.x + 0.065 * fx_fbm(vec2(p.x * 1.1 + 7.3, 4.2) + so);
  float wn = 0.008 + 0.05 * bl;
  float near = smoothstep(hy - wn, hy + wn * 0.6, uv.y);
  float into = clamp((uv.y - hy) / 0.45, 0.0, 1.0);
  float sx = (p.x - sun.x) * 0.6;
  float lit = 0.6 + 0.4 * exp(-sx * sx);
  vec3 nearCol = mix(u_nearLit, u_near, smoothstep(0.0, 0.5, into / lit));
  nearCol = mix(nearCol, u_deep, smoothstep(0.4, 1.0, into));
  vec2 dv = normalize(vec2(1.0, -u_dir * ta));
  float b = 0.7 * strokes(p, dv, 2.4, 15.0, so + 7.0 + vec2(t * 0.12, 0.0), soft)
          + 0.45 * strokes(p, normalize(dv + vec2(0.0, 0.3 * u_dir)), 5.0, 28.0, so + 11.0, soft);
  nearCol = mix(nearCol, u_nearLit, clamp(b, 0.0, 1.0) * 0.6 * bk * (1.0 - 0.6 * into));
  nearCol = mix(nearCol, u_deep, clamp(-b, 0.0, 1.0) * 0.5 * bk);
  col = mix(col, nearCol, near);

  vec2 v = (uv - vec2(0.5, 0.42)) * vec2(1.0, 1.2);
  col.x -= 0.05 * smoothstep(0.4, 1.0, length(v));

  float held = u_capDir > 0.0 ? max(col.x, u_cap) : min(col.x, u_cap);
  float lift = abs(held - col.x);
  col.x = mix(col.x, held, calm);
  col.yz = mix(col.yz, u_ground.yz, calm * min(0.85, 0.45 + 2.5 * lift));
  fxColor = vec4(fx_dither(fx_rgb(col)), 1.0);
}
`;

export interface FeatureCardTheme {
  readonly seed: number;
  readonly light: EffectPalette;
  readonly dark: EffectPalette;
}

/** Four distinct painterly landscapes from #2 Precision Sheet, harmonized for light and Night Shift dark. */
export const FEATURE_CARD_THEMES = {
  check: {
    seed: 11,
    light: normalizePalette({ bg: "#c6d3df", accent: "#3f6a92" }),
    dark: normalizePalette({ bg: "#142030", ink: "#dbe4ee", accent: "#4f8bc2" }),
  },
  complete: {
    seed: 22,
    light: normalizePalette({ bg: "#d9ccb7", accent: "#a8794a" }),
    dark: normalizePalette({ bg: "#241d15", ink: "#ebe2d6", accent: "#b88754" }),
  },
  terminal: {
    seed: 33,
    light: normalizePalette({ bg: "#cdd6c6", accent: "#6c8e63" }),
    dark: normalizePalette({ bg: "#17231a", ink: "#dde8dc", accent: "#6e9e6d" }),
  },
  store: {
    seed: 44,
    light: normalizePalette({ bg: "#bfd0d8", accent: "#2f6c7a" }),
    dark: normalizePalette({ bg: "#122229", ink: "#d8e7ec", accent: "#4d96a8" }),
  },
} as const satisfies Record<string, FeatureCardTheme>;

export type FeatureCardTone = keyof typeof FEATURE_CARD_THEMES;

const L = (c: string) => color.lab(c)[0];
const atL = (c: string, l: number) => color.withLightness(c, Math.min(0.98, Math.max(0.04, l)));
const sat = (c: string, k: number) => color.saturate(c, k);

function tones(P: EffectPalette, kind: PaletteKind): Record<string, string> {
  const { bg, ink, muted, accent } = P;
  const acc = color.chroma(accent) > 0.03 ? accent : color.mix(ink, muted, 0.4);
  const Lb = L(bg);
  if (kind === "dark") {
    return {
      skyTop: color.mix(bg, acc, 0.05),
      skyMid: sat(color.mix(bg, acc, 0.18), 0.9),
      skyLow: sat(atL(color.mix(acc, ink, 0.3), Math.max(0.72, Lb + 0.5)), 0.85),
      glow: atL(color.mix(ink, acc, 0.35), Math.max(0.84, Lb + 0.6)),
      far: sat(atL(color.mix(acc, muted, 0.55), Lb + 0.3), 0.5),
      mid: sat(atL(color.mix(muted, acc, 0.3), Lb + 0.14), 0.45),
      nearLit: sat(atL(color.mix(acc, muted, 0.35), Lb + 0.26), 0.6),
      near: sat(atL(color.mix(bg, muted, 0.4), Lb + 0.07), 0.6),
      deep: atL(bg, Lb + 0.01),
      ground: bg,
    };
  }
  if (kind === "colour") {
    const accFar = color.chroma(acc) > 0.04 && color.hueDistance(bg, acc) > 55;
    const light = L(ink) > Lb ? ink : sat(color.lighten(bg, Math.min(0.16, 0.98 - Lb)), 0.5);
    const field = accFar ? acc : color.lighten(bg, -0.2);
    const Ll = Math.min(0.8, Math.max(L(field), Lb + 0.12));
    return {
      skyTop: color.lighten(bg, -0.06),
      skyMid: bg,
      skyLow: color.mix(bg, light, 0.45),
      glow: color.mix(bg, light, 0.72),
      far: sat(color.mix(bg, light, 0.22), 0.8),
      mid: sat(color.lighten(bg, -0.1), 0.85),
      nearLit: sat(atL(field, Ll), 0.82),
      near: sat(atL(field, Ll - 0.24), 0.85),
      deep: color.mix(atL(field, Ll - 0.38), color.lighten(bg, -0.2), 0.35),
      ground: bg,
    };
  }
  const cool = sat(color.mix(bg, ink, 0.12), 0.25);
  const Ls = Math.min(0.97, Lb + 0.05);
  const Llit = Math.min(Ls - 0.28, Math.max(0.52, L(acc) + 0.12));
  return {
    skyTop: atL(cool, Lb - 0.07),
    skyMid: sat(color.lighten(bg, 0.02), 0.35),
    skyLow: sat(atL(bg, Ls), 0.5),
    glow: atL(bg, Math.min(0.99, Lb + 0.09)),
    far: sat(atL(color.mix(bg, acc, 0.3), Ls - 0.12), 0.5),
    mid: sat(atL(color.mix(bg, acc, 0.6), Ls - 0.22), 0.75),
    nearLit: sat(atL(color.mix(acc, bg, 0.3), Llit), 1.3),
    near: sat(atL(acc, Llit - 0.14), 1.05),
    deep: sat(atL(acc, Llit - 0.25), 0.95),
    ground: bg,
  };
}

function buildUniforms(
  palette: EffectPalette,
  params: PainterlyParams,
  seed: number,
  width: number,
  height: number,
): Record<string, UniformValue> {
  const kind = paletteKind(palette);
  const k = tones(palette, kind);
  const asp = width > 0 && height > 0 ? width / height : 1.6;
  const r = mulberry32(seed);
  const coin = r() < 0.5 ? -1 : 1;
  const dir =
    params.side !== 0
      ? Math.sign(params.side)
      : Math.abs(params.calmX - 0.5) > 0.12
        ? params.calmX < 0.5
          ? 1
          : -1
        : coin;
  const inkLight = L(palette.ink) > L(palette.bg);
  const Lg = L(palette.bg);
  const out: Record<string, UniformValue> = {
    u_dir: dir,
    u_sun: [-dir * asp * (0.16 + 0.14 * r()), params.horizon - 0.06 - 0.06 * r()],
    u_cap: inkLight ? Lg + (kind === "dark" ? 0.08 : 0.03) : Lg - 0.02,
    u_capDir: inkLight ? -1 : 1,
  };
  for (const [name, c] of Object.entries(k)) out[`u_${name}`] = color.lab(c);
  return out;
}

export function painterlyFallbackCSS(tone: FeatureCardTone, scheme: "light" | "dark"): string {
  const spec = FEATURE_CARD_THEMES[tone];
  const palette = spec[scheme];
  const kind = paletteKind(palette);
  const k = tones(palette, kind);
  const r = mulberry32(spec.seed);
  const dir = r() < 0.5 ? -1 : 1;
  const h = DEFAULT_PARAMS.horizon * 100;
  const ang = 180 + dir * (8 + DEFAULT_PARAMS.slope * 0.8);
  return `${grainCSS(0.05)}, linear-gradient(${ang}deg, transparent ${h + DEFAULT_PARAMS.hillY * 100 - 2}%, ${k.nearLit} ${h + DEFAULT_PARAMS.hillY * 100 + 4}%, ${k.near} ${h + DEFAULT_PARAMS.hillY * 100 + 22}%, ${k.deep}), linear-gradient(${k.skyTop}, ${k.skyMid} ${h * 0.6}%, ${k.skyLow} ${h - 1}%, ${k.far} ${h + 1}%, ${k.mid} ${h + 9}%)`;
}

// One shared offscreen WebGL renderer that bakes any number of static painterly landscapes and
// releases its GPU context once idle, so 4 feature cards consume 0 persistent WebGL contexts.
interface SharedBaker {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  locs: Record<string, WebGLUniformLocation | null>;
  releaseTimer: number;
}

let baker: SharedBaker | null = null;
let bakerUnavailable = false;

function releaseBaker(): void {
  if (!baker) return;
  window.clearTimeout(baker.releaseTimer);
  const current = baker;
  baker = null;
  if (!current.gl.isContextLost()) {
    try {
      current.gl.deleteProgram(current.program);
      current.gl.deleteBuffer(current.buffer);
      current.gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // Ignore cleanup errors.
    }
  }
}

function getBaker(sampleUniforms: Record<string, UniformValue>): SharedBaker | null {
  if (bakerUnavailable) return null;
  if (baker && !baker.gl.isContextLost()) {
    window.clearTimeout(baker.releaseTimer);
    baker.releaseTimer = window.setTimeout(releaseBaker, 500);
    return baker;
  }
  releaseBaker();
  const canvas = document.createElement("canvas");
  const attrs: WebGLContextAttributes = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
  };
  const ctx2 = canvas.getContext("webgl2", attrs);
  const gl = ctx2 ?? canvas.getContext("webgl", attrs);
  if (!gl) {
    bakerUnavailable = true;
    return null;
  }
  const fs = buildFragmentSource(ctx2 !== null, PARAM_KEYS, sampleUniforms, FRAG);
  const compiled = compileProgram(gl, ctx2 !== null, fs);
  if (!compiled) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    bakerUnavailable = true;
    return null;
  }
  const locs: Record<string, WebGLUniformLocation | null> = {};
  for (const name of [
    "u_time",
    "u_res",
    "u_seed",
    "u_dpr",
    ...PARAM_KEYS.map((k) => `u_${k}`),
    ...Object.keys(sampleUniforms),
  ]) {
    locs[name] = gl.getUniformLocation(compiled.program, name);
  }
  baker = {
    canvas,
    gl,
    program: compiled.program,
    buffer: compiled.buffer,
    locs,
    releaseTimer: window.setTimeout(releaseBaker, 500),
  };
  return baker;
}

/** Render one painterly-landscape bitmap into a 2D canvas. Returns false if WebGL is unavailable. */
export function renderPainterlyLandscape(
  target: HTMLCanvasElement,
  tone: FeatureCardTone,
  scheme: "light" | "dark",
  width: number,
  height: number,
): boolean {
  const spec = FEATURE_CARD_THEMES[tone];
  const palette = spec[scheme];
  const seed = hashSeed(spec.seed);
  const w = Math.max(120, Math.round(width * 0.6));
  const h = Math.max(80, Math.round(height * 0.6));
  const uniforms = buildUniforms(palette, DEFAULT_PARAMS, seed, width, height);
  const b = getBaker(uniforms);
  if (!b) return false;
  const { canvas, gl, program, locs } = b;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  gl.useProgram(program);
  for (const k of PARAM_KEYS) setUniform(gl, locs[`u_${k}`] ?? null, DEFAULT_PARAMS[k]);
  for (const [k, v] of Object.entries(uniforms)) setUniform(gl, locs[k] ?? null, v);
  setUniform(gl, locs.u_seed ?? null, seed);
  setUniform(gl, locs.u_time ?? null, 4);
  setUniform(gl, locs.u_res ?? null, [w, h]);
  setUniform(gl, locs.u_dpr ?? null, 0.6);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  target.width = w;
  target.height = h;
  const ctx2d = target.getContext("2d");
  if (!ctx2d) return false;
  ctx2d.drawImage(canvas, 0, 0);
  return true;
}
