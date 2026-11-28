export type BrowserEngine = "chromium" | "webkit" | "firefox";
export type ColorScheme = "light" | "dark";
export type CliVerb = "look" | "scenario" | "list";

export interface ViewportSpec {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
}

export interface ParsedArgs {
  readonly verb: CliVerb;
  readonly scenarioName?: string;
  readonly url?: string;
  readonly viewport: ViewportSpec;
  readonly scheme: ColorScheme;
  readonly engine: BrowserEngine;
  readonly doctor: boolean;
  readonly live: boolean;
  readonly headed: boolean;
  readonly starter: string;
  readonly selector?: string;
  readonly timeoutMs: number;
  readonly evidenceRoot?: string;
}

export const VIEWPORT_PRESETS: Readonly<Record<"desktop" | "phone", ViewportSpec>> = {
  desktop: { label: "desktop", width: 1440, height: 900, isMobile: false, hasTouch: false },
  phone: { label: "phone", width: 390, height: 844, isMobile: true, hasTouch: true },
};

const VALID_ENGINES = new Set<string>(["chromium", "webkit", "firefox"]);
const VALID_SCHEMES = new Set<string>(["light", "dark"]);

/** True when `url` targets the public `sprockt.dev` production domain (including trailing dot or subdomains). */
export function isProductionUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    return host === "sprockt.dev" || host.endsWith(".sprockt.dev");
  } catch {
    return false;
  }
}

export function parseViewport(raw: string): ViewportSpec {
  if (raw === "desktop") return VIEWPORT_PRESETS.desktop;
  if (raw === "phone") return VIEWPORT_PRESETS.phone;
  const match = /^(\d+)x(\d+)$/i.exec(raw.trim());
  if (!match) {
    throw new Error(`Invalid --viewport "${raw}". Expected desktop, phone, or WxH (e.g. 1280x800).`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 240 || height < 240 || width > 4096 || height > 4096) {
    throw new Error(`Viewport ${width}x${height} is outside supported bounds (240..4096).`);
  }
  const isMobile = width <= 768;
  return { label: `${width}x${height}`, width, height, isMobile, hasTouch: isMobile };
}

function readNextValue(argv: readonly string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return next;
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${flag} value "${raw}". Expected a positive integer.`);
  }
  return value;
}

interface MutableArgs {
  url?: string;
  viewport: ViewportSpec;
  scheme: ColorScheme;
  engine: BrowserEngine;
  doctor: boolean;
  live: boolean;
  headed: boolean;
  starter: string;
  selector?: string;
  timeoutMs: number;
  evidenceRoot?: string;
}

function applyFlag(state: MutableArgs, argv: readonly string[], index: number): number {
  const token = argv[index];
  if (token === "--doctor") {
    state.doctor = true;
    return index + 1;
  }
  if (token === "--live") {
    state.live = true;
    return index + 1;
  }
  if (token === "--headed") {
    state.headed = true;
    return index + 1;
  }
  if (token === "--url") {
    state.url = readNextValue(argv, index, token);
    return index + 2;
  }
  if (token === "--viewport") {
    state.viewport = parseViewport(readNextValue(argv, index, token));
    return index + 2;
  }
  if (token === "--scheme") {
    const val = readNextValue(argv, index, token);
    if (!VALID_SCHEMES.has(val)) throw new Error(`Invalid --scheme "${val}". Expected light or dark.`);
    state.scheme = val as ColorScheme;
    return index + 2;
  }
  if (token === "--engine") {
    const val = readNextValue(argv, index, token);
    if (!VALID_ENGINES.has(val)) {
      throw new Error(`Invalid --engine "${val}". Expected chromium, webkit, or firefox.`);
    }
    state.engine = val as BrowserEngine;
    return index + 2;
  }
  if (token === "--starter") {
    state.starter = readNextValue(argv, index, token);
    return index + 2;
  }
  if (token === "--selector") {
    state.selector = readNextValue(argv, index, token);
    return index + 2;
  }
  if (token === "--timeout-ms") {
    state.timeoutMs = parsePositiveInt(readNextValue(argv, index, token), token);
    return index + 2;
  }
  if (token === "--evidence-root") {
    state.evidenceRoot = readNextValue(argv, index, token);
    return index + 2;
  }
  throw new Error(`Unknown option: ${token}`);
}

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const verbRaw = argv[0];
  if (!verbRaw || verbRaw === "--help" || verbRaw === "-h") {
    throw new Error("USAGE");
  }
  if (verbRaw !== "look" && verbRaw !== "scenario" && verbRaw !== "list") {
    throw new Error(`Unknown verb "${verbRaw}". Expected: look, scenario, or list.`);
  }
  let cursor = 1;
  let scenarioName: string | undefined;
  if (verbRaw === "scenario") {
    const candidate = argv[1];
    if (!candidate || candidate.startsWith("--")) {
      throw new Error("Missing scenario name. Run `bun run agent:browser list` to see scenarios.");
    }
    scenarioName = candidate;
    cursor = 2;
  }
  const state: MutableArgs = {
    viewport: VIEWPORT_PRESETS.desktop,
    scheme: "light",
    engine: "chromium",
    doctor: false,
    live: false,
    headed: false,
    starter: "vite-react",
    timeoutMs: 180_000,
  };
  while (cursor < argv.length) {
    cursor = applyFlag(state, argv, cursor);
  }
  if (state.live && (verbRaw !== "scenario" || state.url !== "https://sprockt.dev/")) {
    throw new Error("--live requires a scenario and --url https://sprockt.dev/.");
  }
  return {
    verb: verbRaw,
    scenarioName,
    url: state.url,
    viewport: state.viewport,
    scheme: state.scheme,
    engine: state.engine,
    doctor: state.doctor,
    live: state.live,
    headed: state.headed,
    starter: state.starter,
    selector: state.selector,
    timeoutMs: state.timeoutMs,
    evidenceRoot: state.evidenceRoot,
  };
}

export const CLI_USAGE = `Usage:
  bun run agent:browser look [--doctor] [--url URL] [--viewport desktop|phone|WxH] [--scheme light|dark] [--engine chromium|webkit|firefox] [--selector CSS] [--headed]
  bun run agent:browser scenario <name> [--url URL] [--live] [--viewport desktop|phone|WxH] [--scheme light|dark] [--engine chromium|webkit|firefox] [--starter ID] [--headed]
  bun run agent:browser list`;
