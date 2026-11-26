// grain-gradient: faithful TypeScript port of #4 "Sheet and Biro"'s living hero shader.
// Renders a soft OKLab tonal ramp and three drifting warped blobs under a stippled dissolve and
// subtle 24fps film/radio-noise grain. Respects prefers-reduced-motion, phone viewports, tab
// visibility, offscreen pausing, and falls back to a calm CSS gradient when WebGL is unavailable.
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
  type Vec2,
} from "./color";

export interface GrainGradientParams {
  readonly speed: number;
  readonly softness: number;
  readonly warp: number;
  readonly grain: number;
  readonly scatter: number;
  readonly tint: number;
  readonly contrast: number;
  readonly calm: number;
  readonly calmX: number;
  readonly calmY: number;
  readonly grainMotion: number;
}

const DEFAULT_PARAMS: GrainGradientParams = {
  speed: 0.5,
  softness: 0.45,
  warp: 0.6,
  grain: 0.6,
  scatter: 0.5,
  tint: 0.5,
  contrast: 0.55,
  calm: 0.5,
  calmX: 0.25,
  calmY: 0.7,
  grainMotion: 1,
};

const PARAM_KEYS = Object.keys(DEFAULT_PARAMS) as readonly (keyof GrainGradientParams)[];

const FRAG = /* glsl */ `
float blobW(vec2 p, vec4 b, float t) {
  vec2 c = b.xy + 0.13 * vec2(sin(t + b.w), cos(t * 0.83 + b.w * 1.7));
  float r = length(p - c) / (b.z * (0.6 + 0.7 * u_softness));
  return exp(-pow(r, 6.0 - 4.0 * u_softness) * 1.2);
}

float dissolve(float w, float z) {
  return clamp(w + z * u_dissolve * 4.0 * w * (1.0 - w), 0.0, 1.0);
}

void main() {
  vec2 uv = fx_uv();
  vec2 p = fx_p();
  float t = u_time * u_speed * 0.12 + u_seed * 0.37;

  float gc = max(1.0, floor(u_dpr + 0.5));
  vec2 gp = floor(gl_FragCoord.xy / gc);
  float z = fx_hash(gp + vec2(17.0, 3.0)) + fx_hash(gp + vec2(511.0, 97.0)) - 1.0;

  vec2 q = p * 1.1 + u_seed * 0.0123;
  vec2 w = vec2(fx_noise(q + vec2(0.0, t * 0.9)), fx_noise(q * 1.1 + vec2(5.2, 1.3) - vec2(t * 0.7, 0.0)));
  p += w * 0.5 * u_warp;

  float s = dot(p - u_calmP, u_dir) / u_span;
  s += 0.22 * fx_noise(p * 1.6 + vec2(t * 0.5, 3.1));
  vec3 col = mix(u_kNear, u_kFar, dissolve(smoothstep(-0.1, 0.75, s), z));

  col = mix(col, u_k1, dissolve(blobW(p, u_b1, t), fract(z * 7.31 + 0.5) * 2.0 - 1.0));
  col = mix(col, u_k2, dissolve(blobW(p, u_b2, t * 0.9), fract(z * 3.17 + 0.25) * 2.0 - 1.0));
  col = mix(col, u_k0, dissolve(blobW(p, u_b0, t * 1.1), z));

  float m = fx_calm(uv, vec2(u_calmX, u_calmY), 0.35 + 0.4 * u_calm) * u_calm;
  col = mix(col, u_kNear, m);

  float frame = u_grainMotion > 0.5 ? floor(u_time * 24.0) : 0.0;
  float amp = u_grainAmp * u_grain * (1.0 - 0.6 * smoothstep(0.86, 1.0, col.x)) * (1.0 - 0.5 * smoothstep(0.22, 0.0, col.x));
  col.x += fx_grain(gp, frame) * amp;

  fxColor = vec4(fx_dither(fx_rgb(col)), 1.0);
}
`;

export const HERO_PALETTES = {
  light: normalizePalette({
    bg: "#c6d3df",
    surface: "#d6e0e9",
    ink: "#25303a",
    muted: "#546575",
    accent: "#3f6a92",
    accentInk: "#ffffff",
  }),
  dark: normalizePalette({
    bg: "#152030",
    surface: "#1d2a3b",
    ink: "#dbe4ee",
    muted: "#8ea2b8",
    accent: "#5ab9fc",
    accentInk: "#0a0d14",
  }),
} as const;

interface ToneSet {
  readonly grain: number;
  readonly near: string;
  readonly far: string;
  readonly k: readonly [string, string, string];
}

function tones(P: EffectPalette, prm: GrainGradientParams, kind: PaletteKind): ToneSet {
  const { bg, surface, ink, accent } = P;
  const c = prm.contrast;
  const tn = prm.tint;
  const neutral = color.chroma(bg) < 0.035;
  const acc =
    neutral || color.hueDistance(bg, accent) < 55
      ? accent
      : color.withLightness(color.saturate(bg, 1.1), color.lab(accent)[0]);
  const [Lb] = color.lab(bg);
  const [Li] = color.lab(ink);
  const away = Li > Lb ? -1 : 1;
  const near = color.saturate(color.lighten(bg, away * (0.012 + 0.03 * c)), 1.1);
  if (kind === "dark") {
    return {
      grain: 0.04,
      near,
      far: color.mix(bg, surface, 0.7 + 0.3 * c),
      k: [
        color.mix(bg, acc, 0.28 + 0.45 * tn),
        color.mix(bg, acc, 0.1 + 0.2 * tn),
        color.lighten(color.mix(surface, acc, 0.08 + 0.1 * tn), 0.015 + 0.04 * c),
      ],
    };
  }
  if (kind === "colour") {
    return {
      grain: 0.05,
      near,
      far: color.lighten(bg, -away * (0.04 + 0.08 * c)),
      k: [
        color.mix(bg, acc, 0.25 + 0.45 * tn),
        color.mix(bg, ink, 0.06 + 0.1 * c),
        color.saturate(color.lighten(bg, away * (0.035 + 0.06 * c)), 1.08),
      ],
    };
  }
  const tone = color.mix(ink, acc, 0.45 + 0.55 * tn);
  return {
    grain: 0.06,
    near,
    far: color.saturate(color.mix(bg, tone, 0.08 + 0.14 * c), 1.15),
    k: [
      color.saturate(color.mix(bg, acc, 0.22 + 0.5 * tn), 1.25),
      color.saturate(color.lighten(color.mix(bg, acc, 0.1), 0.03), 1.3),
      color.saturate(color.mix(bg, tone, 0.3 + 0.35 * c), 1.4),
    ],
  };
}

function buildUniforms(
  palette: EffectPalette,
  params: GrainGradientParams,
  seed: number,
  width: number,
  height: number,
): Record<string, UniformValue> {
  const r = mulberry32(seed);
  const kind = paletteKind(palette);
  const set = tones(palette, params, kind);
  const asp = width > 0 && height > 0 ? width / height : 4 / 3;
  const calm: Vec2 = [(params.calmX - 0.5) * asp, 0.5 - params.calmY];
  const corners: readonly Vec2[] = [
    [-asp / 2, -0.5],
    [asp / 2, -0.5],
    [-asp / 2, 0.5],
    [asp / 2, 0.5],
  ];
  const far = corners.reduce((a, b) =>
    Math.hypot(b[0] - calm[0], b[1] - calm[1]) > Math.hypot(a[0] - calm[0], a[1] - calm[1]) ? b : a,
  );
  const span = Math.max(0.3, Math.hypot(far[0] - calm[0], far[1] - calm[1]));
  const dir: Vec2 = [(far[0] - calm[0]) / span, (far[1] - calm[1]) / span];
  const perp: Vec2 = [-dir[1], dir[0]];
  const at = (along: number, side: number): Vec2 => [
    Math.max(-asp / 2 + 0.12, Math.min(asp / 2 - 0.12, calm[0] + dir[0] * span * along + perp[0] * side)),
    Math.max(-0.38, Math.min(0.38, calm[1] + dir[1] * span * along + perp[1] * side)),
  ];
  const side = r() < 0.5 ? -1 : 1;
  const b0 = at(0.7 + 0.2 * r(), side * (0.05 + 0.2 * r()));
  const b1 = at(0.3 + 0.2 * r(), -side * (0.2 + 0.25 * r()));
  const b2 = at(0.6 + 0.3 * r(), -side * (0.15 + 0.3 * r()));
  return {
    u_kNear: color.lab(set.near),
    u_kFar: color.lab(set.far),
    u_grainAmp: set.grain,
    u_dissolve: 0.36 * params.scatter,
    u_calmP: calm,
    u_dir: dir,
    u_span: span,
    u_b0: [b0[0], b0[1], 0.38 + 0.12 * r(), r() * 6.283],
    u_b1: [b1[0], b1[1], 0.36 + 0.12 * r(), r() * 6.283],
    u_b2: [b2[0], b2[1], 0.3 + 0.12 * r(), r() * 6.283],
    u_k0: color.lab(set.k[0]),
    u_k1: color.lab(set.k[1]),
    u_k2: color.lab(set.k[2]),
  };
}

function fallbackBackground(palette: EffectPalette, params: GrainGradientParams): string {
  const kind = paletteKind(palette);
  const k = tones(palette, params, kind).k;
  const at = `${(1 - params.calmX) * 100}% ${(1 - params.calmY) * 100}%`;
  const b = color.mix(palette.bg, palette.ink, color.isDark(palette.bg) ? 0.1 : 0.06);
  return `${grainCSS(color.isDark(palette.bg) ? 0.05 : 0.07)}, radial-gradient(70% 90% at ${at}, ${k[0]}, transparent 72%), radial-gradient(80% 100% at 12% 96%, ${b}, transparent 70%), ${palette.bg}`;
}

export interface GrainGradientController {
  isAnimated(): boolean;
  pause(): void;
  resume(): void;
  setScheme(scheme: "light" | "dark"): void;
  destroy(): void;
}

const STILL_TIME = 4;
const MAX_DPR = 1.75;

export function mountGrainGradient(
  host: HTMLElement,
  options: {
    readonly scheme: "light" | "dark";
    readonly seed?: number;
    readonly params?: Partial<GrainGradientParams>;
    readonly onAnimatedChange?: (animated: boolean) => void;
  },
): GrainGradientController {
  const params: GrainGradientParams = { ...DEFAULT_PARAMS, ...options.params };
  const seed = hashSeed(options.seed ?? 11);
  let palette = HERO_PALETTES[options.scheme];
  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  let gl2 = false;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let locs: Record<string, WebGLUniformLocation | null> = {};
  let custom = buildUniforms(palette, params, seed, host.clientWidth, host.clientHeight);
  let width = 0;
  let height = 0;
  let dpr = 1;
  let dirty = true;
  let fallback = false;
  let lost = false;
  let destroyed = false;
  let inView = true;
  let userPaused = false;
  let raf = 0;
  let recoverTimer = 0;
  let lastTs = 0;
  let time = STILL_TIME;
  let dprMQ: MediaQueryList | null = null;

  const reducedMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
  const phoneMQ = window.matchMedia("(max-width: 639px)");
  const isStill = () => reducedMQ.matches || phoneMQ.matches;
  const shouldRun = () => !destroyed && !fallback && !userPaused && inView && !document.hidden && !isStill();

  function applyFallback(): void {
    fallback = true;
    teardownGL();
    host.style.background = fallbackBackground(palette, params);
    host.dataset.fxFallback = "1";
    options.onAnimatedChange?.(false);
  }

  function teardownGL(): void {
    if (gl && !gl.isContextLost()) {
      try {
        if (program) gl.deleteProgram(program);
        if (buffer) gl.deleteBuffer(buffer);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        // Ignore driver cleanup errors.
      }
    }
    canvas?.remove();
    canvas = null;
    gl = null;
    program = null;
    buffer = null;
    locs = {};
  }

  function initGL(): boolean {
    if (fallback || destroyed) return false;
    const nextCanvas = document.createElement("canvas");
    nextCanvas.className = "lp-fx-canvas";
    nextCanvas.setAttribute("aria-hidden", "true");
    const attrs: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    };
    const ctx2 = nextCanvas.getContext("webgl2", attrs);
    const ctx = ctx2 ?? nextCanvas.getContext("webgl", attrs);
    if (!ctx) {
      applyFallback();
      return false;
    }
    gl2 = ctx2 !== null;
    const fs = buildFragmentSource(gl2, PARAM_KEYS, custom, FRAG);
    const compiled = compileProgram(ctx, gl2, fs);
    if (!compiled) {
      ctx.getExtension("WEBGL_lose_context")?.loseContext();
      applyFallback();
      return false;
    }
    canvas = nextCanvas;
    gl = ctx;
    program = compiled.program;
    buffer = compiled.buffer;
    locs = {};
    const names = [
      "u_time",
      "u_res",
      "u_seed",
      "u_dpr",
      ...PARAM_KEYS.map((k) => `u_${k}`),
      ...Object.keys(custom),
    ];
    for (const name of names) locs[name] = ctx.getUniformLocation(program, name);
    nextCanvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      if (canvas !== nextCanvas) return;
      lost = true;
      window.clearTimeout(recoverTimer);
      recoverTimer = window.setTimeout(() => {
        recoverTimer = 0;
        if (destroyed || canvas !== nextCanvas) return;
        teardownGL();
        lost = false;
        if (initGL()) {
          fit();
          draw(isStill() ? STILL_TIME : time);
        }
      }, 60);
    });
    host.insertBefore(nextCanvas, host.firstChild);
    delete host.dataset.fxFallback;
    dirty = true;
    options.onAnimatedChange?.(true);
    return true;
  }

  function fit(): void {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    if (fallback) {
      width = w;
      height = h;
      host.style.background = fallbackBackground(palette, params);
      return;
    }
    if (!canvas) return;
    width = w;
    height = h;
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const cw = Math.max(1, Math.round(w * dpr));
    const ch = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      custom = buildUniforms(palette, params, seed, w, h);
      dirty = true;
    }
  }

  function draw(t: number): void {
    if (fallback || lost || !gl || !program || !canvas) return;
    if (!canvas.width || !canvas.height) fit();
    if (!canvas.width || !canvas.height) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    if (dirty) {
      for (const k of PARAM_KEYS) setUniform(gl, locs[`u_${k}`] ?? null, params[k]);
      for (const [k, v] of Object.entries(custom)) setUniform(gl, locs[k] ?? null, v);
      setUniform(gl, locs.u_seed ?? null, seed);
      dirty = false;
    }
    setUniform(gl, locs.u_grainMotion ?? null, isStill() || userPaused ? 0 : params.grainMotion);
    setUniform(gl, locs.u_time ?? null, t);
    setUniform(gl, locs.u_res ?? null, [canvas.width, canvas.height]);
    setUniform(gl, locs.u_dpr ?? null, dpr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function loop(ts: number): void {
    raf = 0;
    if (!shouldRun()) return;
    const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.1) : 0;
    lastTs = ts;
    time += dt;
    draw(time);
    raf = requestAnimationFrame(loop);
  }

  function sync(): void {
    if (destroyed) return;
    if (shouldRun()) {
      if (!raf) {
        lastTs = 0;
        raf = requestAnimationFrame(loop);
      }
    } else {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (inView && !document.hidden) draw(isStill() ? STILL_TIME : time);
    }
  }

  const ro = new ResizeObserver(() => {
    fit();
    if (!raf) draw(isStill() ? STILL_TIME : time);
  });
  ro.observe(host);

  const io = new IntersectionObserver(
    (entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      inView = entry.isIntersecting;
      sync();
    },
    { rootMargin: "12% 0px" },
  );
  io.observe(host);

  const onSync = () => sync();
  document.addEventListener("visibilitychange", onSync);
  reducedMQ.addEventListener("change", onSync);
  phoneMQ.addEventListener("change", onSync);

  const onDprChange = () => {
    if (destroyed) return;
    watchDpr();
    fit();
    if (!raf) draw(isStill() ? STILL_TIME : time);
  };
  function watchDpr(): void {
    dprMQ?.removeEventListener("change", onDprChange);
    dprMQ = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprMQ.addEventListener("change", onDprChange, { once: true });
  }
  watchDpr();

  if (initGL()) {
    fit();
    draw(isStill() ? STILL_TIME : time);
  }
  sync();

  return {
    isAnimated() {
      return !destroyed && !fallback;
    },
    pause() {
      userPaused = true;
      sync();
    },
    resume() {
      userPaused = false;
      sync();
    },
    setScheme(scheme: "light" | "dark") {
      palette = HERO_PALETTES[scheme];
      custom = buildUniforms(palette, params, seed, width || host.clientWidth, height || host.clientHeight);
      dirty = true;
      if (fallback) host.style.background = fallbackBackground(palette, params);
      else draw(isStill() ? STILL_TIME : time);
    },
    destroy() {
      destroyed = true;
      window.clearTimeout(recoverTimer);
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      dprMQ?.removeEventListener("change", onDprChange);
      dprMQ = null;
      document.removeEventListener("visibilitychange", onSync);
      reducedMQ.removeEventListener("change", onSync);
      phoneMQ.removeEventListener("change", onSync);
      teardownGL();
    },
  };
}
