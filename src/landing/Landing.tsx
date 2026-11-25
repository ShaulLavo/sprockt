// The landing page: open a repo or a starter, see the workbench, pick up a saved workspace.
// Loads zero editor, terminal, or runtime code on initial render.
import archivoLatinUrl from "@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2?url";
import plexMonoLatinUrl from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url";
import { createSignal, For, onCleanup, onMount, Show, type Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { navigate } from "../app/router";
import { routePath, type Route } from "../app/routes";
import {
  BLANK_TEMPLATE_SUMMARY,
  STARTER_TEMPLATE_SUMMARIES,
  type TemplateId,
  type TemplateSummary,
} from "../templates/metadata";
import { CHAINRING, chainringPath } from "../ui/sprocket";
import { LANDING_COPY, PENDING_COPY } from "./copy";
import { createDemo } from "./demo";
import { parseGithubInput } from "./github-input";
import { Icon } from "./icons";
import { BrandLogoTile, LOGOS } from "./logos";
import { createThemeController } from "./theme";
import { WorkbenchPreview } from "./WorkbenchPreview";
import { listStoredWorkspaces, saveWorkspaceHint, type StoredWorkspaceSummary } from "./workspaces";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import "./landing.css";

const SAMPLE_GITHUB_ROUTE: Extract<Route, { kind: "github" }> = {
  kind: "github",
  owner: "ShaulLavo",
  repo: "bash-web",
};
const SAMPLE_GITHUB_PATH = routePath(SAMPLE_GITHUB_ROUTE);
const REPO_URL = "https://github.com/ShaulLavo/sprockt";
const DOCS_URL = "https://github.com/ShaulLavo/sprockt#readme";

/** Matches the one-column layout in landing.css, where the hero drops its workbench. */
const COMPACT_QUERY = "(max-width: 900px)";

/** The two faces the first screen is set in, fetched before the stylesheet asks for them. */
function preloadFont(href: string): void {
  if (typeof document === "undefined") return;
  if (document.head.querySelector(`link[rel="preload"][href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "font";
  link.type = "font/woff2";
  link.crossOrigin = "anonymous";
  link.href = href;
  document.head.appendChild(link);
}

preloadFont(archivoLatinUrl);
preloadFont(plexMonoLatinUrl);

/** The browsers Sprockt runs in: the teeth of the showcase's tab strip. */
const BROWSERS = [
  { id: "chrome", label: "Chrome", logo: LOGOS.chrome },
  { id: "firefox", label: "Firefox", logo: LOGOS.firefox },
  { id: "safari", label: "Safari", logo: LOGOS.safari },
  { id: "iphone", label: "iPhone Safari", logo: undefined },
] as const;

type BrowserId = (typeof BROWSERS)[number]["id"];

/** The parts Sprockt is built from, in the order a keystroke travels through them. */
const STACK = ["Singapore", "ghostty-webgpu", "bash-web", "bun-wasm", "Waffle"] as const;

const BUN_COMMANDS = ["bun install", "bun run dev", "bun test", "bun build"] as const;

const CHAINRING_PATH = chainringPath(CHAINRING);

/** The starters, then the empty workspace as the last row. */
const TEMPLATES = STARTER_TEMPLATE_SUMMARIES.concat(BLANK_TEMPLATE_SUMMARY);

function createMediaQuery(query: string): Accessor<boolean> {
  const list = matchMedia(query);
  const [matches, setMatches] = createSignal(list.matches);
  const update = (event: MediaQueryListEvent) => setMatches(event.matches);
  list.addEventListener("change", update);
  onCleanup(() => list.removeEventListener("change", update));
  return matches;
}

function ThemeSwitch(props: { theme: ReturnType<typeof createThemeController> }) {
  const option = (scheme: "light" | "dark", label: string) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={props.theme.resolved() === scheme}
      data-testid={`theme-${scheme}`}
      onClick={() => props.theme.setTheme(scheme)}
    >
      <Icon name={scheme === "light" ? "sun" : "moon"} />
    </button>
  );
  return (
    <div class="lp-theme-switch lp-desktop-only" role="group" aria-label="Theme">
      {option("light", "Light theme")}
      {option("dark", "Dark theme")}
    </div>
  );
}

export function Landing() {
  const theme = createThemeController();
  const demo = createDemo();
  const compact = createMediaQuery(COMPACT_QUERY);
  const [repoInput, setRepoInput] = createSignal("");
  const [repoError, setRepoError] = createSignal<string | undefined>();
  const [creatingTemplate, setCreatingTemplate] = createSignal<TemplateId | undefined>();
  const [createError, setCreateError] = createSignal<string | undefined>();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [browser, setBrowser] = createSignal<BrowserId>("chrome");

  const [workspaces, setWorkspaces] = createStore<StoredWorkspaceSummary[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = createSignal(true);
  let refreshSequence = 0;

  async function refreshWorkspaces(): Promise<void> {
    const seq = ++refreshSequence;
    try {
      const next = await listStoredWorkspaces();
      if (seq !== refreshSequence) return;
      setWorkspaces(reconcile(next, { key: "id" }));
    } finally {
      if (seq === refreshSequence) setLoadingWorkspaces(false);
    }
  }

  function refreshOnVisible(): void {
    if (document.visibilityState === "visible") void refreshWorkspaces();
  }

  const nextTheme = () => (theme.resolved() === "dark" ? "light" : "dark");

  function closeMenuOnEscape(event: KeyboardEvent): void {
    if (event.key === "Escape") setMenuOpen(false);
  }

  onMount(() => {
    void refreshWorkspaces();
    document.addEventListener("visibilitychange", refreshOnVisible);
    window.addEventListener("focus", refreshOnVisible);
    window.addEventListener("keydown", closeMenuOnEscape);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", refreshOnVisible);
      window.removeEventListener("focus", refreshOnVisible);
      window.removeEventListener("keydown", closeMenuOnEscape);
    });
  });

  function handleGithubSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const parsed = parseGithubInput(repoInput());
    if (!parsed) {
      setRepoError(LANDING_COPY.openError);
      return;
    }
    setRepoError(undefined);
    navigate(parsed);
  }

  async function launchTemplate(templateId: TemplateId): Promise<void> {
    if (creatingTemplate()) return;
    setCreatingTemplate(templateId);
    setCreateError(undefined);
    try {
      const { seedWorkspace } = await import("../templates/seed");
      const { id, meta } = await seedWorkspace(templateId);
      saveWorkspaceHint(id, meta);
      navigate({ kind: "workspace", id });
    } catch (error) {
      setCreatingTemplate(undefined);
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  }

  /** How many teeth the showcase's sprocket has turned: one per boot step, one per browser. */
  const turns = () => demo.step() + BROWSERS.findIndex((item) => item.id === browser());

  function renderTemplate(template: TemplateSummary) {
    const isCreating = () => creatingTemplate() === template.id;
    const isFeatured = Boolean(template.featured);

    return (
      <li classList={{ "is-featured": isFeatured, "is-wide": isFeatured || template.id === "blank" }}>
        <button
          type="button"
          class="lp-tpl"
          disabled={creatingTemplate() !== undefined}
          data-testid={`template-${template.id}`}
          onClick={() => void launchTemplate(template.id)}
        >
          <BrandLogoTile templateId={template.id} />
          <span class="lp-tpl-text">
            <span class="lp-tpl-name">{template.label}</span>
            <span class="lp-tpl-desc">
              {isFeatured ? (template.longDescription ?? template.description) : template.description}
            </span>
          </span>
          <Show when={isFeatured} fallback={<Icon name="chev-r" class="lp-tpl-go" />}>
            <span class="lp-tpl-action">
              {isCreating() ? LANDING_COPY.templateCreating : LANDING_COPY.templateAction}
            </span>
          </Show>
        </button>
      </li>
    );
  }

  const navLinks = () => (
    <>
      <a href="#templates" onClick={() => setMenuOpen(false)}>
        {LANDING_COPY.navTemplates}
      </a>
      <a href="#why" onClick={() => setMenuOpen(false)}>
        {LANDING_COPY.navWhy}
      </a>
      <a href={DOCS_URL} target="_blank" rel="noreferrer">
        {LANDING_COPY.navDocs}
      </a>
    </>
  );

  return (
    <div class="landing-page" data-testid="landing-page">
      <a class="lp-skip" href="#main">
        {PENDING_COPY.skip}
      </a>
      <header class="lp-nav nav" classList={{ "is-open": menuOpen() }}>
        <div class="lp-wrap wrap">
          <a
            class="lp-brand"
            href={routePath({ kind: "landing" })}
            style={{ "--turns": demo.step() }}
            onClick={(event) => {
              event.preventDefault();
              navigate({ kind: "landing" });
            }}
          >
            <Icon name="logo" class="lp-brand-mark" />
            <span>Sprockt</span>
          </a>
          <nav class="lp-nav-links" aria-label="Site">
            {navLinks()}
          </nav>
          <div class="lp-nav-right">
            <a class="lp-btn lp-btn-quiet lp-nav-github" href={REPO_URL} target="_blank" rel="noreferrer">
              <Icon name="github" />
              <span>{LANDING_COPY.navGithub}</span>
            </a>
            <ThemeSwitch theme={theme} />
            <button
              type="button"
              class="lp-btn lp-btn-line lp-nav-cta lp-desktop-only"
              disabled={creatingTemplate() !== undefined}
              data-testid="header-new-workspace"
              onClick={() => void launchTemplate("vite-react")}
            >
              {LANDING_COPY.navCta}
            </button>
            {/* On a phone the bar holds two controls: one theme button and the menu. */}
            <button
              type="button"
              class="lp-btn lp-btn-quiet lp-nav-icon lp-phone-only"
              title={`Switch to ${nextTheme()} theme`}
              aria-label={`Switch to ${nextTheme()} theme`}
              data-testid="phone-theme-toggle"
              onClick={() => theme.setTheme(nextTheme())}
            >
              <Icon name={theme.resolved() === "dark" ? "sun" : "moon"} />
            </button>
            <button
              type="button"
              class="lp-btn lp-btn-quiet lp-nav-icon lp-nav-menu"
              aria-label={PENDING_COPY.menu}
              aria-expanded={menuOpen()}
              aria-controls="lp-menu"
              data-testid="phone-menu-toggle"
              onClick={() => setMenuOpen(!menuOpen())}
            >
              <Icon name={menuOpen() ? "x" : "menu"} />
            </button>
          </div>
        </div>
        <Show when={menuOpen()}>
          <nav class="lp-menu" id="lp-menu" aria-label="Site" data-testid="phone-menu">
            {navLinks()}
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              {LANDING_COPY.navGithub}
            </a>
          </nav>
        </Show>
      </header>

      <main id="main">
        <section class="lp-hero hero" data-enter aria-labelledby="hero-title">
          <div class="lp-wrap wrap">
            <div class="lp-hero-text hero-text">
              <h1 id="hero-title">{LANDING_COPY.heroTitle}</h1>
              <p class="lp-lede">{LANDING_COPY.heroLede}</p>
              <div class="lp-hero-actions">
                <button
                  type="button"
                  class="lp-btn lp-btn-primary lp-btn-lg"
                  disabled={creatingTemplate() !== undefined}
                  data-testid="hero-start-cta"
                  onClick={() => void launchTemplate("vite-react")}
                >
                  {creatingTemplate() === "vite-react" ? LANDING_COPY.templateCreating : LANDING_COPY.heroCta}
                </button>
                <a class="lp-btn lp-btn-line lp-btn-lg" href="#templates">
                  {LANDING_COPY.heroSecondary}
                </a>
              </div>

              <form class="lp-open" role="search" onSubmit={handleGithubSubmit} noValidate>
                <div class="lp-open-row">
                  <label class="lp-open-field" for="repo-input">
                    <Icon name="github" />
                    <span class="lp-open-prefix" aria-hidden="true">
                      github.com/
                    </span>
                    <span class="lp-sr-only">{LANDING_COPY.openLabel}</span>
                    <input
                      id="repo-input"
                      type="text"
                      placeholder={LANDING_COPY.openPlaceholder}
                      autocomplete="off"
                      spellcheck={false}
                      autocapitalize="off"
                      value={repoInput()}
                      aria-invalid={repoError() ? "true" : undefined}
                      aria-describedby={repoError() ? "repo-error" : undefined}
                      data-testid="repo-input"
                      onInput={(event) => {
                        setRepoInput(event.currentTarget.value);
                        if (repoError()) setRepoError(undefined);
                      }}
                    />
                  </label>
                  <button class="lp-btn lp-open-submit" type="submit" data-testid="repo-submit">
                    {LANDING_COPY.openButton}
                  </button>
                </div>
                <Show when={repoError()}>
                  {(message) => (
                    <p id="repo-error" class="lp-open-error" role="alert" data-testid="repo-error">
                      {message()}
                    </p>
                  )}
                </Show>
                <div class="lp-open-foot">
                  <span>
                    {LANDING_COPY.openTry}{" "}
                    <a
                      class="lp-link"
                      href={SAMPLE_GITHUB_PATH}
                      data-testid="sample-repo-link"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(SAMPLE_GITHUB_ROUTE);
                      }}
                    >
                      ShaulLavo/bash-web
                    </a>
                  </span>
                  <button
                    type="button"
                    class="lp-link"
                    disabled={creatingTemplate() !== undefined}
                    data-testid="new-workspace"
                    onClick={() => void launchTemplate("blank")}
                  >
                    {creatingTemplate() === "blank" ? LANDING_COPY.templateCreating : LANDING_COPY.altBlank}
                  </button>
                </div>
              </form>
            </div>

            <Show when={!compact()}>
              <div class="lp-tab lp-hero-tab" data-enter-media>
                <div class="lp-tab-strip" aria-hidden="true">
                  <span class="lp-tab-tooth is-active">
                    <Icon name="logo" />
                    Sprockt
                    <Icon name="x" class="lp-tab-x" />
                  </span>
                  <span class="lp-tab-add">
                    <Icon name="plus" />
                  </span>
                </div>
                <WorkbenchPreview demo={demo} pane="terminal" label={PENDING_COPY.heroFrame} />
              </div>
            </Show>
          </div>
        </section>

        <section class="lp-bench" id="workbench" aria-labelledby="bench-title">
          <div class="lp-wrap wrap">
            <div class="lp-sec-head">
              <h2 id="bench-title">{LANDING_COPY.whyBrowsersTitle}</h2>
              <p>{LANDING_COPY.whyBrowsersBody}</p>
            </div>
            <div class="lp-tab lp-bench-tab" data-browser={browser()} style={{ "--turns": turns() }}>
              <div class="lp-tab-strip">
                <div class="lp-tab-teeth" role="tablist" aria-label={PENDING_COPY.browsers}>
                  <For each={BROWSERS}>
                    {(item) => (
                      <button
                        type="button"
                        role="tab"
                        class="lp-tab-tooth"
                        classList={{ "is-active": browser() === item.id }}
                        aria-selected={browser() === item.id}
                        aria-label={item.label}
                        onClick={() => setBrowser(item.id)}
                      >
                        <Show when={item.logo} fallback={<Icon name="phone" />}>
                          {(logo) => <img src={logo()} alt="" width="16" height="16" />}
                        </Show>
                        <span>{item.label}</span>
                      </button>
                    )}
                  </For>
                </div>
                <span class="lp-tab-drive" aria-hidden="true">
                  <span class="lp-tab-drive-text">{LANDING_COPY.heroPill}</span>
                  <Icon name="logo" class="lp-tab-sprocket" />
                </span>
              </div>
              <div class="lp-bench-stage">
                <WorkbenchPreview demo={demo} pane="preview" label={PENDING_COPY.benchFrame} />
              </div>
            </div>
          </div>
        </section>

        <section class="lp-start" id="templates" aria-labelledby="tpl-title">
          <div class="lp-wrap wrap">
            <div class="lp-sec-head">
              <h2 id="tpl-title">{LANDING_COPY.templatesTitle}</h2>
              <p>{LANDING_COPY.templatesNote}</p>
            </div>
            <div class="lp-start-grid">
              <div>
                <Show when={createError()}>
                  {(message) => (
                    <p class="lp-create-error" role="alert" data-testid="template-error">
                      Could not create workspace: {message()}
                    </p>
                  )}
                </Show>
                <ul class="lp-tpls" data-testid="template-grid">
                  <For each={TEMPLATES}>{(template) => renderTemplate(template)}</For>
                </ul>
              </div>
              <WorkspaceSwitcher
                workspaces={workspaces}
                loading={loadingWorkspaces()}
                onOpen={(id) => navigate({ kind: "workspace", id })}
                onRefresh={() => void refreshWorkspaces()}
              />
            </div>
          </div>
        </section>

        <section class="lp-why" id="why" aria-labelledby="why-title">
          <div class="lp-wrap wrap">
            <div class="lp-sec-head">
              <h2 id="why-title">{LANDING_COPY.whyTitle}</h2>
            </div>
            <ul class="lp-specs">
              <li class="lp-spec">
                <h3>{LANDING_COPY.whyBunTitle}</h3>
                <p>
                  Runs <code>bun install</code>, <code>bun run</code>, <code>bun test</code>,{" "}
                  <code>bun build</code> and <code>bun:sqlite</code> straight in the tab.
                </p>
                <div class="lp-specimen lp-specimen-term" data-ui="terminal" aria-hidden="true">
                  <For each={BUN_COMMANDS}>
                    {(command) => (
                      <span>
                        <span class="lp-specimen-prompt">$</span> {command}
                      </span>
                    )}
                  </For>
                </div>
              </li>

              <li class="lp-spec">
                <h3>{LANDING_COPY.whyTabsTitle}</h3>
                <p>{LANDING_COPY.whyTabsBody}</p>
                <div class="lp-specimen lp-specimen-tabs" data-ui="tabs" aria-hidden="true">
                  <div class="lp-tab-strip">
                    <span class="lp-tab-tooth is-active">
                      <span class="lp-lamp" />
                      vite-react
                    </span>
                    <span class="lp-tab-tooth is-active">
                      <span class="lp-lamp" />
                      vite-react
                    </span>
                  </div>
                  <div class="lp-specimen-plate">
                    <span>
                      <Icon name="drive" />
                      IndexedDB
                    </span>
                    <span>
                      <span class="lp-lamp" />
                      dev :5173
                    </span>
                  </div>
                </div>
              </li>

              <li class="lp-spec">
                <h3>{LANDING_COPY.whyOssTitle}</h3>
                <p>{LANDING_COPY.whyOssBody}</p>
                <div class="lp-specimen lp-specimen-chain" data-ui="stack" aria-hidden="true">
                  <ol class="lp-chain">
                    <For each={STACK}>{(part) => <li>{part}</li>}</For>
                  </ol>
                </div>
              </li>
            </ul>
            <p class="lp-limits">
              <Icon name="alert" />
              <span>
                Honest limits: native <code>.node</code> addons and Docker do not run in WebAssembly.
              </span>
            </p>
          </div>
        </section>
      </main>

      <footer class="lp-close closing">
        <div class="lp-wrap wrap">
          <div class="lp-close-main">
            <p class="lp-close-title">{LANDING_COPY.whyNote}</p>
            <button
              type="button"
              class="lp-btn lp-btn-primary lp-btn-lg"
              disabled={creatingTemplate() !== undefined}
              data-testid="closing-start-cta"
              onClick={() => void launchTemplate("vite-react")}
            >
              {creatingTemplate() === "vite-react" ? LANDING_COPY.templateCreating : LANDING_COPY.heroCta}
            </button>
            <svg class="lp-chainring" viewBox="0 0 240 240" aria-hidden="true">
              <path fill-rule="evenodd" d={CHAINRING_PATH} />
            </svg>
          </div>
          <div class="lp-foot">
            <span>{LANDING_COPY.footerLine}</span>
            <span class="lp-foot-links">
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                {LANDING_COPY.navGithub}
              </a>
              <a href={DOCS_URL} target="_blank" rel="noreferrer">
                {LANDING_COPY.navDocs}
              </a>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
