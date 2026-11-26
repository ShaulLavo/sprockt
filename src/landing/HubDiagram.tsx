// The Waffle hub diagram from #4 "Sheet and Biro" (set-a/dir-1 diagram.js + diagram.css):
// Waffle at the centre connects the 6 browser-side parts around it with concentric hairline rings,
// a radial accent halo, port dots, a continuous 3.2s staggered comet/glow/spark/hit loop across
// every spoke, hover-focus path highlighting, and a WCAG pause/play disc. Freezes on the busiest
// lit still frame under prefers-reduced-motion or on phones (<= 639px).
import { useEffect, useId, useRef, useState } from "react";
import { LANDING_COPY } from "./copy";
import { Icon, type IconName } from "./icons";
import { LOGOS } from "./logos";

interface SpokeSpec {
  readonly id: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly logo?: string;
}

const SPOKES: readonly SpokeSpec[] = [
  { id: "singapore", label: "Singapore", icon: "code" },
  { id: "ghostty", label: "Ghostty WebGPU", icon: "monitor" },
  { id: "bun", label: "Bun 1.4.5", logo: LOGOS.bun },
  { id: "tsrs", label: "tsrs", logo: LOGOS.typescript },
  { id: "bash", label: "bash-web", icon: "terminal" },
  { id: "indexeddb", label: "IndexedDB", icon: "drive" },
];

interface Point {
  readonly x: number;
  readonly y: number;
}

interface NodeBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface EdgeGeom {
  readonly id: string;
  readonly to: string;
  readonly a: Point;
  readonly b: Point;
  readonly len: number;
  readonly tail: number;
}

interface FireEvent {
  readonly edgeIndex: number;
  readonly to: string;
  readonly t0: number;
  readonly dur: number;
  readonly hitT: number;
}

interface HubLayout {
  readonly width: number;
  readonly height: number;
  readonly compact: boolean;
  readonly center: NodeBox;
  readonly spokes: readonly NodeBox[];
  readonly rings: readonly { readonly r: number; readonly opacity: number }[];
  readonly haloRadius: number;
  readonly edges: readonly EdgeGeom[];
  readonly events: readonly FireEvent[];
  readonly cycle: number;
  readonly stillT: number;
}

const HIT_DURATION = 0.95;
const DECAY_DURATION = 0.9;
const CYCLE_SECONDS = 3.2;

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

function ease(u: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * clamp(u, 0, 1));
}

function unease(y: number): number {
  return Math.acos(1 - 2 * clamp(y, 0, 1)) / Math.PI;
}

function rayPort(box: NodeBox, angle: number, extra = 0): Point {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const hw = box.w / 2 + extra;
  const hh = box.h / 2 + extra;
  const t = Math.min(
    Math.abs(c) > 1e-6 ? hw / Math.abs(c) : 1e9,
    Math.abs(s) > 1e-6 ? hh / Math.abs(s) : 1e9,
  );
  return { x: box.x + c * t, y: box.y + s * t };
}

function pointAlong(a: Point, b: Point, dist: number, len: number): Point {
  const u = len > 0 ? clamp(dist / len, 0, 1) : 0;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

function computeState(
  edges: readonly EdgeGeom[],
  events: readonly FireEvent[],
  lt: number,
): {
  run: (FireEvent | null)[];
  lit: number[];
  hits: Set<string>;
  coreHit: boolean;
} {
  const run: (FireEvent | null)[] = edges.map(() => null);
  const lit: number[] = edges.map(() => 0);
  const hits = new Set<string>();
  let coreHit = lt >= 0.08 && lt < 1.15;

  for (const f of events) {
    const dt = lt - f.t0;
    if (dt < 0) continue;
    if (dt < f.dur) run[f.edgeIndex] = f;
    const ht = dt - f.hitT;
    if (ht >= 0 && ht < HIT_DURATION) hits.add(f.to);
    if (dt >= 0 && dt < 0.25) coreHit = true;
  }

  for (let i = 0; i < edges.length; i++) {
    if (run[i]) {
      lit[i] = 1;
      continue;
    }
    const f = events[i];
    if (!f) continue;
    const dt = lt - f.t0;
    if (dt >= f.hitT) {
      lit[i] = clamp(1 - (dt - f.hitT) / DECAY_DURATION, 0, 1);
    }
  }

  return { run, lit, hits, coreHit };
}

function computeLayout(
  width: number,
  height: number,
  coreSize: { w: number; h: number },
  spokeSizes: readonly { w: number; h: number }[],
): HubLayout {
  const compact = width < 480;
  const pad = compact ? 16 : 26;
  const cx = width / 2;
  const cy = height / 2;
  const center: NodeBox = { id: "waffle", x: cx, y: cy, w: coreSize.w, h: coreSize.h };
  const maxW = Math.max(40, ...spokeSizes.map((s) => s.w));
  const maxH = Math.max(28, ...spokeSizes.map((s) => s.h));
  const rx = Math.max(54, width / 2 - pad - maxW / 2);
  const ry = Math.max(54, height / 2 - pad - maxH / 2);
  const n = SPOKES.length;
  const a0 = -Math.PI / 2 + Math.PI / n;

  const spokes: NodeBox[] = SPOKES.map((spoke, i) => {
    const angle = a0 + (2 * Math.PI * i) / n;
    const sz = spokeSizes[i] ?? { w: 100, h: 32 };
    return {
      id: spoke.id,
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
      w: sz.w,
      h: sz.h,
    };
  });

  const step = clamp(Math.min(width, height) * 0.19, 46, 112);
  const far = Math.max(
    Math.hypot(cx, cy),
    Math.hypot(width - cx, cy),
    Math.hypot(cx, height - cy),
    Math.hypot(width - cx, height - cy),
  );
  const ringCount = Math.max(2, Math.floor(far / step));
  const rings: { r: number; opacity: number }[] = [];
  for (let k = 1; k <= ringCount; k++) {
    const opacity = Math.round(Math.max(0, 1 - (k - 0.6) / (ringCount * 0.82)) * 100) / 100;
    if (opacity > 0.02) rings.push({ r: Math.round(step * k * 10) / 10, opacity });
  }

  const edges: EdgeGeom[] = spokes.map((sp) => {
    const angle = Math.atan2(sp.y - center.y, sp.x - center.x);
    const a = rayPort(center, angle, 2);
    const b = rayPort(sp, angle + Math.PI, 0);
    const len = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const tail = clamp(len * 0.4, 30, 112);
    return { id: sp.id, to: sp.id, a, b, len, tail };
  });

  // Staggered ripple program scaled to a 3.2s cycle (matching diagram.js).
  const rawEvents: FireEvent[] = [];
  const gap = 0.28;
  let end0 = 0.5;
  edges.forEach((edge, i) => {
    const t0 = 0.35 + i * gap;
    const dur = clamp((edge.len + edge.tail) / 205, 0.55, 2.3);
    const hitT = dur * unease(edge.len / (edge.len + edge.tail));
    rawEvents.push({ edgeIndex: i, to: edge.to, t0, dur, hitT });
    end0 = Math.max(end0, t0 + dur);
  });
  const rest = CYCLE_SECONDS * 0.28;
  const scale = clamp((CYCLE_SECONDS - rest) / end0, 0.25, 1.6);
  const events: FireEvent[] = rawEvents.map((f) => ({
    edgeIndex: f.edgeIndex,
    to: f.to,
    t0: f.t0 * scale,
    dur: f.dur * scale,
    hitT: f.hitT * scale,
  }));
  const cycle = clamp(end0 * scale + rest, 2.5, 4);

  // Pick the busiest moment as the reduced-motion / phone still frame.
  let stillT = cycle * 0.45;
  let bestScore = -1;
  for (let k = 0; k < 120; k++) {
    const lt = (cycle * k) / 120;
    const st = computeState(edges, events, lt);
    let score = 0;
    st.run.forEach((f) => {
      if (f) {
        const u = (lt - f.t0) / f.dur;
        score += u > 0.25 && u < 0.62 ? 2.2 : 0.6;
      }
    });
    st.lit.forEach((a) => {
      if (a > 0.5) score += 1;
    });
    score += st.hits.size * 0.5;
    if (score > bestScore + 0.01) {
      bestScore = score;
      stillT = lt;
    }
  }

  return {
    width,
    height,
    compact,
    center,
    spokes,
    rings,
    haloRadius: Math.min(width, height) * (compact ? 0.36 : 0.3),
    edges,
    events,
    cycle,
    stillT,
  };
}

export function HubDiagram(props: { readonly scheme: "light" | "dark" }) {
  const uid = useId().replace(/:/g, "");
  const rootRef = useRef<HTMLElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);
  const spokeRefs = useRef<(HTMLDivElement | null)[]>([]);
  const edgeGRefs = useRef<(SVGGElement | null)[]>([]);
  const litRefs = useRef<(SVGLineElement | null)[]>([]);
  const glowRefs = useRef<(SVGLineElement | null)[]>([]);
  const cometRefs = useRef<(SVGLineElement | null)[]>([]);
  const gradRefs = useRef<(SVGLinearGradientElement | null)[]>([]);
  const haloRefs = useRef<(SVGCircleElement | null)[]>([]);
  const sparkRefs = useRef<(SVGCircleElement | null)[]>([]);

  const [layout, setLayout] = useState<HubLayout | null>(null);
  const [compact, setCompact] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [isStill, setIsStill] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);

  // Track reduced-motion & phone breakpoint.
  useEffect(() => {
    const reducedMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
    const phoneMQ = window.matchMedia("(max-width: 639px)");
    const update = () => setIsStill(reducedMQ.matches || phoneMQ.matches);
    update();
    reducedMQ.addEventListener("change", update);
    phoneMQ.addEventListener("change", update);
    return () => {
      reducedMQ.removeEventListener("change", update);
      phoneMQ.removeEventListener("change", update);
    };
  }, []);

  // Measure host + real node sizes so every ray meets each pill's rim cleanly at any viewport.
  useEffect(() => {
    const host = rootRef.current;
    if (!host) return;
    let raf = 0;

    const measure = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      const nextCompact = w < 480;
      setCompact((prev) => (prev === nextCompact ? prev : nextCompact));
      const coreEl = coreRef.current;
      const coreSize = coreEl
        ? { w: coreEl.offsetWidth || 104, h: coreEl.offsetHeight || 42 }
        : { w: 104, h: 42 };
      const spokeSizes = SPOKES.map((_, i) => {
        const el = spokeRefs.current[i];
        return el ? { w: el.offsetWidth || 96, h: el.offsetHeight || 32 } : { w: 96, h: 32 };
      });
      setLayout(computeLayout(w, h, coreSize, spokeSizes));
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    schedule();
    if (document.fonts && document.fonts.status !== "loaded") {
      void document.fonts.ready.then(schedule);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [compact]);

  // Continuous 3.2s staggered comet animation loop with offscreen & tab-visibility pausing.
  useEffect(() => {
    const host = rootRef.current;
    if (!host || !layout) return;
    const { edges, events, cycle, stillT } = layout;

    let visible = true;
    let raf = 0;
    let last = 0;
    let t = stillT;

    const renderFrame = (lt: number) => {
      const st = computeState(edges, events, lt);
      edges.forEach((edge, i) => {
        const g = edgeGRefs.current[i];
        const litEl = litRefs.current[i];
        const glowEl = glowRefs.current[i];
        const cometEl = cometRefs.current[i];
        const gradEl = gradRefs.current[i];
        const haloEl = haloRefs.current[i];
        const sparkEl = sparkRefs.current[i];
        if (!g || !litEl || !glowEl || !cometEl || !gradEl || !haloEl || !sparkEl) return;

        const f = st.run[i];
        if (f && !isStill) {
          const u = (lt - f.t0) / f.dur;
          const p = ease(u) * (edge.len + edge.tail);
          const big = edge.len + edge.tail * 2 + 40;
          const glowLen = edge.tail * 0.55;
          glowEl.setAttribute("stroke-dasharray", `${glowLen.toFixed(1)} ${big.toFixed(1)}`);
          glowEl.setAttribute("stroke-dashoffset", (glowLen - p).toFixed(1));
          cometEl.setAttribute("stroke-dasharray", `${edge.tail.toFixed(1)} ${big.toFixed(1)}`);
          cometEl.setAttribute("stroke-dashoffset", (edge.tail - p).toFixed(1));

          const hd = pointAlong(edge.a, edge.b, p, edge.len);
          const td = pointAlong(edge.a, edge.b, p - edge.tail, edge.len);
          if (Math.hypot(hd.x - td.x, hd.y - td.y) > 0.5) {
            gradEl.setAttribute("x1", td.x.toFixed(1));
            gradEl.setAttribute("y1", td.y.toFixed(1));
            gradEl.setAttribute("x2", hd.x.toFixed(1));
            gradEl.setAttribute("y2", hd.y.toFixed(1));
          }
          const sa = p <= edge.len ? clamp(p / 10, 0, 1) : 0;
          sparkEl.setAttribute("cx", hd.x.toFixed(1));
          sparkEl.setAttribute("cy", hd.y.toFixed(1));
          haloEl.setAttribute("cx", hd.x.toFixed(1));
          haloEl.setAttribute("cy", hd.y.toFixed(1));
          sparkEl.style.opacity = String(sa);
          haloEl.style.opacity = String(sa);

          const q = Math.min(p, edge.len);
          litEl.setAttribute("stroke-dasharray", `${q.toFixed(1)} ${(edge.len + 2).toFixed(1)}`);
          litEl.style.opacity = "1";
          g.classList.add("is-run");
        } else {
          g.classList.remove("is-run");
          const a = st.lit[i] ?? 0;
          if (a > 0) {
            litEl.setAttribute("stroke-dasharray", "none");
            litEl.style.opacity = String(Math.round(a * 100) / 100);
          } else {
            litEl.style.opacity = "0";
          }
        }
      });

      coreRef.current?.classList.toggle("is-hit", !isStill && st.coreHit);
      SPOKES.forEach((spoke, i) => {
        spokeRefs.current[i]?.classList.toggle("is-hit", st.hits.has(spoke.id));
      });
    };

    const canRun = () => !isStill && !userPaused && visible && !document.hidden;

    const tick = (now: number) => {
      raf = 0;
      if (!canRun()) return;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      t += dt;
      renderFrame(t % cycle);
      raf = requestAnimationFrame(tick);
    };

    const sync = () => {
      if (canRun()) {
        if (!raf) {
          last = 0;
          raf = requestAnimationFrame(tick);
        }
      } else {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        renderFrame(isStill ? stillT : t % cycle);
      }
    };

    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        visible = entry.isIntersecting;
        sync();
      },
      { threshold: 0.12 },
    );
    io.observe(host);

    const onVis = () => sync();
    document.addEventListener("visibilitychange", onVis);

    renderFrame(isStill ? stillT : t % cycle);
    sync();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [layout, isStill, userPaused]);

  const showPause = !isStill;

  return (
    <figure
      ref={rootRef}
      className={
        isStill
          ? focusId
            ? "lp-dg is-still is-focus"
            : "lp-dg is-still"
          : focusId
            ? "lp-dg is-focus"
            : "lp-dg"
      }
      data-ground={props.scheme}
      data-tier={compact ? "c" : "n"}
      role="img"
      aria-label={LANDING_COPY.hoodDiagram}
      data-testid="hub-diagram"
      onPointerLeave={() => setFocusId(null)}
    >
      {layout ? (
        <svg
          className="lp-dg-svg"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <radialGradient id={`${uid}-halo`}>
              <stop offset="0" className="lp-dg-halo-in" />
              <stop offset="1" className="lp-dg-halo-out" />
            </radialGradient>
            {layout.edges.map((edge, i) => (
              <linearGradient
                key={edge.id}
                ref={(el) => {
                  gradRefs.current[i] = el;
                }}
                id={`${uid}-g-${i}`}
                gradientUnits="userSpaceOnUse"
                x1={edge.a.x}
                y1={edge.a.y}
                x2={edge.b.x}
                y2={edge.b.y}
              >
                <stop offset="0" className="lp-dg-c0" />
                <stop offset="0.55" className="lp-dg-c1" />
                <stop offset="1" className="lp-dg-c2" />
              </linearGradient>
            ))}
          </defs>

          <g className="lp-dg-rings">
            {layout.rings.map((ring) => (
              <circle
                key={ring.r}
                cx={layout.center.x}
                cy={layout.center.y}
                r={ring.r}
                strokeOpacity={ring.opacity}
              />
            ))}
          </g>

          <circle
            className="lp-dg-halo"
            cx={layout.center.x}
            cy={layout.center.y}
            r={layout.haloRadius}
            fill={`url(#${uid}-halo)`}
          />

          <g className="lp-dg-edges">
            {layout.edges.map((edge, i) => {
              const edgeFocused = focusId === "waffle" || focusId === edge.to;
              return (
                <g
                  key={edge.id}
                  ref={(el) => {
                    edgeGRefs.current[i] = el;
                  }}
                  className={edgeFocused ? "lp-dg-e is-focus" : "lp-dg-e"}
                >
                  <line className="lp-dg-line" x1={edge.a.x} y1={edge.a.y} x2={edge.b.x} y2={edge.b.y} />
                  <line
                    ref={(el) => {
                      litRefs.current[i] = el;
                    }}
                    className="lp-dg-lit"
                    x1={edge.a.x}
                    y1={edge.a.y}
                    x2={edge.b.x}
                    y2={edge.b.y}
                  />
                  <line
                    ref={(el) => {
                      glowRefs.current[i] = el;
                    }}
                    className="lp-dg-glow"
                    x1={edge.a.x}
                    y1={edge.a.y}
                    x2={edge.b.x}
                    y2={edge.b.y}
                    stroke={`url(#${uid}-g-${i})`}
                  />
                  <line
                    ref={(el) => {
                      cometRefs.current[i] = el;
                    }}
                    className="lp-dg-comet"
                    x1={edge.a.x}
                    y1={edge.a.y}
                    x2={edge.b.x}
                    y2={edge.b.y}
                    stroke={`url(#${uid}-g-${i})`}
                  />
                  <circle
                    ref={(el) => {
                      haloRefs.current[i] = el;
                    }}
                    className="lp-dg-spark-halo"
                    r={compact ? 5 : 6}
                    cx={-50}
                    cy={-50}
                  />
                  <circle
                    ref={(el) => {
                      sparkRefs.current[i] = el;
                    }}
                    className="lp-dg-spark"
                    r={2.1}
                    cx={-50}
                    cy={-50}
                  />
                </g>
              );
            })}
          </g>

          <g className="lp-dg-ports">
            {layout.edges.map((edge) => (
              <g key={edge.id}>
                <circle className="lp-dg-port" cx={edge.a.x} cy={edge.a.y} r={2} />
                <circle className="lp-dg-port" cx={edge.b.x} cy={edge.b.y} r={2} />
              </g>
            ))}
          </g>
        </svg>
      ) : null}

      <div className="lp-dg-nodes" aria-hidden="true">
        {SPOKES.map((spoke, i) => {
          const box = layout?.spokes[i];
          const nodeFocused = focusId === "waffle" || focusId === spoke.id;
          return (
            <div
              key={spoke.id}
              ref={(el) => {
                spokeRefs.current[i] = el;
              }}
              className={nodeFocused ? "lp-dg-node lp-dg-node-pill is-focus" : "lp-dg-node lp-dg-node-pill"}
              style={
                box
                  ? {
                      left: `${Math.round(box.x - box.w / 2)}px`,
                      top: `${Math.round(box.y - box.h / 2)}px`,
                    }
                  : { opacity: 0 }
              }
              onPointerEnter={(ev) => {
                if (ev.pointerType !== "touch") setFocusId(spoke.id);
              }}
            >
              <span className="lp-dg-ic">
                {spoke.logo ? (
                  <img src={spoke.logo} alt="" width="18" height="18" />
                ) : (
                  <Icon name={spoke.icon ?? "box"} />
                )}
              </span>
              <span className="lp-dg-label">{spoke.label}</span>
            </div>
          );
        })}

        <div
          ref={coreRef}
          className={
            focusId ? "lp-dg-node lp-dg-node-core is-ink is-focus" : "lp-dg-node lp-dg-node-core is-ink"
          }
          style={
            layout
              ? {
                  left: `${Math.round(layout.center.x - layout.center.w / 2)}px`,
                  top: `${Math.round(layout.center.y - layout.center.h / 2)}px`,
                }
              : { opacity: 0 }
          }
          onPointerEnter={(ev) => {
            if (ev.pointerType !== "touch") setFocusId("waffle");
          }}
        >
          <span className="lp-dg-ic">
            <Icon name="cpu" />
          </span>
          <span className="lp-dg-label">Waffle</span>
        </div>
      </div>

      {showPause ? (
        <button
          type="button"
          className={userPaused ? "lp-fx-pause is-paused" : "lp-fx-pause"}
          aria-pressed={userPaused}
          aria-label={userPaused ? LANDING_COPY.hubPlay : LANDING_COPY.hubPause}
          title={userPaused ? LANDING_COPY.hubPlay : LANDING_COPY.hubPause}
          data-testid="hub-pause"
          onClick={() => setUserPaused((p) => !p)}
        >
          <svg viewBox="0 0 14 14" aria-hidden="true">
            {userPaused ? <path d="M4 2.5v9l7.5-4.5z" /> : <path d="M3.5 2.5h2.5v9H3.5zM8 2.5h2.5v9H8z" />}
          </svg>
        </button>
      ) : null}
    </figure>
  );
}
