// The landing page: Sheet and Biro daylight structure + Precision Sheet live demo, gear logo,
// multicolor tabs and surface textures, with one high-contrast dark band ("Under the hood").
// Loads zero editor, terminal, or Waffle runtime code on initial render.
import jetbrainsMonoLatinUrl from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import schibstedLatinUrl from "@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2?url";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { navigate } from "../app/router";
import { routePath, type Route } from "../app/routes";
import {
  BLANK_TEMPLATE_SUMMARY,
  STARTER_TEMPLATE_SUMMARIES,
  type TemplateId,
  type TemplateSummary,
} from "../templates/metadata";
import { SprocktLogo } from "../ui/SprocktLogo";
import { LANDING_COPY } from "./copy";
import { createDemo } from "./demo";
import { parseGithubInput } from "./github-input";
import { Icon } from "./icons";
import { BrandLogoTile, LOGOS } from "./logos";
import { createThemeController } from "./theme";
import { WorkbenchPreview } from "./WorkbenchPreview";
import {
  hasWorkspaceHints,
  listStoredWorkspaces,
  saveWorkspaceHint,
  type StoredWorkspaceSummary,
} from "./workspaces";
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

/** Preload the two variable font faces so the first screen paints with zero layout shift. */
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

preloadFont(schibstedLatinUrl);
preloadFont(jetbrainsMonoLatinUrl);

const BROWSERS = [
  { name: LANDING_COPY.browserChrome, body: LANDING_COPY.browserChromeBody, logo: LOGOS.chrome },
  { name: LANDING_COPY.browserFirefox, body: LANDING_COPY.browserFirefoxBody, logo: LOGOS.firefox },
  { name: LANDING_COPY.browserSafari, body: LANDING_COPY.browserSafariBody, logo: LOGOS.safari },
  { name: LANDING_COPY.browserIphone, body: LANDING_COPY.browserIphoneBody, logo: undefined },
] as const;

const STACK = [
  { name: "Waffle", repo: "waffle", desc: LANDING_COPY.hoodStackWaffle },
  { name: "Singapore", repo: "singapore", desc: LANDING_COPY.hoodStackSingapore },
  { name: "ghostty-webgpu", repo: "ghostty-webgpu", desc: LANDING_COPY.hoodStackGhostty },
  { name: "bun-wasm", repo: "bun-wasm", desc: LANDING_COPY.hoodStackBun },
  { name: "tsrs", repo: "tsrs", desc: LANDING_COPY.hoodStackTsrs },
  { name: "bash-web", repo: "bash-web", desc: LANDING_COPY.hoodStackBash },
] as const;

function engineUrl(repo: string): string {
  return `https://github.com/ShaulLavo/${repo}`;
}

/** The seven real starters, plus Blank as the last option. */
const TEMPLATES = STARTER_TEMPLATE_SUMMARIES.concat(BLANK_TEMPLATE_SUMMARY);

export function Landing() {
  const theme = createThemeController();
  const demo = createDemo();
  const [repoInput, setRepoInput] = createSignal("");
  const [repoError, setRepoError] = createSignal<string | undefined>();
  const [creatingTemplate, setCreatingTemplate] = createSignal<TemplateId | undefined>();
  const [createError, setCreateError] = createSignal<string | undefined>();
  const [menuOpen, setMenuOpen] = createSignal(false);

  const [workspaces, setWorkspaces] = createStore<StoredWorkspaceSummary[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = createSignal(true);
  // Known before storage answers, so a returning visitor's page does not jump once it does.
  const expectsWorkspaces = hasWorkspaceHints();
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

  const hasRecent = () => workspaces.length > 0 || (loadingWorkspaces() && expectsWorkspaces);
  const nextTheme = () => (theme.resolved() === "dark" ? "light" : "dark");
  const nextThemeLabel = () =>
    nextTheme() === "light" ? LANDING_COPY.navThemeLight : LANDING_COPY.navThemeDark;

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

  function renderTemplate(template: TemplateSummary) {
    const isCreating = () => creatingTemplate() === template.id;
    const isFeatured = Boolean(template.featured);

    return (
      <li classList={{ "is-featured": isFeatured }}>
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
      <a href="#browsers" onClick={() => setMenuOpen(false)}>
        {LANDING_COPY.navBrowsers}
      </a>
      <a href="#templates" onClick={() => setMenuOpen(false)}>
        {LANDING_COPY.navTemplates}
      </a>
      <a href="#hood" onClick={() => setMenuOpen(false)}>
        {LANDING_COPY.navHood}
      </a>
      <a href={DOCS_URL} target="_blank" rel="noreferrer">
        {LANDING_COPY.navDocs}
      </a>
    </>
  );

  return (
    <div class="landing-page" data-testid="landing-page">
      <a class="lp-skip" href="#main">
        {LANDING_COPY.skip}
      </a>
      <header class="lp-nav nav" classList={{ "is-open": menuOpen() }}>
        <div class="lp-wrap wrap">
          <a
            class="lp-brand"
            href={routePath({ kind: "landing" })}
            onClick={(event) => {
              event.preventDefault();
              navigate({ kind: "landing" });
            }}
          >
            <SprocktLogo class="lp-brand-mark" />
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
            <div class="lp-theme-switch lp-desktop-only" role="group" aria-label="Theme">
              <button
                type="button"
                title={LANDING_COPY.navThemeLight}
                aria-label={LANDING_COPY.navThemeLight}
                aria-pressed={theme.resolved() === "light"}
                data-testid="theme-light"
                onClick={() => theme.setTheme("light")}
              >
                <Icon name="sun" />
              </button>
              <button
                type="button"
                title={LANDING_COPY.navThemeDark}
                aria-label={LANDING_COPY.navThemeDark}
                aria-pressed={theme.resolved() === "dark"}
                data-testid="theme-dark"
                onClick={() => theme.setTheme("dark")}
              >
                <Icon name="moon" />
              </button>
            </div>
            <button
              type="button"
              class="lp-btn lp-btn-primary lp-nav-cta lp-desktop-only"
              disabled={creatingTemplate() !== undefined}
              data-testid="header-new-workspace"
              onClick={() => void launchTemplate("vite-react")}
            >
              {LANDING_COPY.navCta}
            </button>
            <button
              type="button"
              class="lp-btn lp-btn-quiet lp-nav-icon lp-phone-only"
              aria-label={nextThemeLabel()}
              title={nextThemeLabel()}
              data-testid="phone-theme-toggle"
              onClick={() => theme.setTheme(nextTheme())}
            >
              <Icon name={nextTheme() === "light" ? "sun" : "moon"} />
            </button>
            <button
              type="button"
              class="lp-btn lp-btn-quiet lp-nav-icon lp-nav-menu"
              aria-label={LANDING_COPY.navMenu}
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
        {/* Daylight Sheet & Biro hero: crisp type (no inline headline logo), no Bun/WebAssembly,
            followed by the live interactive workbench on a subtle sky-paper textured stage. */}
        <section class="lp-hero hero" data-enter aria-labelledby="hero-title">
          <div class="lp-wrap wrap">
            <div class="lp-hero-head hero-text">
              <a class="lp-pill" href="#hood">
                <span class="lp-pill-dot" aria-hidden="true" />
                <span>{LANDING_COPY.heroPill}</span>
                <span class="lp-pill-muted">{LANDING_COPY.heroPillLink}</span>
              </a>
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
                <a class="lp-btn lp-btn-secondary lp-btn-lg" href="#templates">
                  {LANDING_COPY.heroSecondary}
                </a>
              </div>

              <div class="lp-open-wrap">
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
                </form>
                <p class="lp-open-help">
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
                </p>
              </div>
            </div>

            <div class="lp-hero-stage" data-enter-media>
              <div class="lp-tab lp-hero-tab">
                <WorkbenchPreview demo={demo} pane="terminal" label={LANDING_COPY.showcaseBenchFrame} />
              </div>
            </div>
          </div>
        </section>

        {/* Four browsers + live synchronized phone workbench on cool paper surface */}
        <section class="lp-any" id="browsers" aria-labelledby="any-title">
          <div class="lp-wrap wrap">
            <div class="lp-any-text">
              <div class="lp-sec-head">
                <h2 id="any-title">
                  {LANDING_COPY.showcaseTitle} <span class="lp-muted">{LANDING_COPY.showcaseTitleMuted}</span>
                </h2>
                <p>{LANDING_COPY.showcaseLede}</p>
              </div>
              <ul class="lp-browsers" aria-label={LANDING_COPY.showcaseBrowsers}>
                <For each={BROWSERS}>
                  {(item) => (
                    <li>
                      <Show when={item.logo} fallback={<Icon name="phone" class="lp-browser-glyph" />}>
                        {(logo) => <img src={logo()} alt="" width="28" height="28" loading="lazy" />}
                      </Show>
                      <span class="lp-browser-name">{item.name}</span>
                      <span class="lp-browser-body">{item.body}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
            <div class="lp-phone-stage">
              <div class="lp-phone">
                <WorkbenchPreview demo={demo} pane="preview" label={LANDING_COPY.showcaseHeroFrame} />
                <div class="lp-phone-bar" aria-hidden="true">
                  <span>sprockt.dev</span>
                  <Icon name="reload" />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Real 7 starters + Blank + IndexedDB recent workspaces on white daylight ground */}
        <section class="lp-start" id="templates" aria-labelledby="tpl-title">
          <div class="lp-wrap wrap">
            <div class="lp-sec-head">
              <h2 id="tpl-title">
                {LANDING_COPY.templatesTitle} <span class="lp-muted">{LANDING_COPY.templatesTitleMuted}</span>
              </h2>
              <p>{LANDING_COPY.templatesNote}</p>
            </div>
            <div class="lp-start-grid" classList={{ "has-recent": hasRecent() }}>
              <div>
                <Show when={createError()}>
                  {(message) => (
                    <p class="lp-create-error" role="alert" data-testid="template-error">
                      {LANDING_COPY.templatesError.replace("{message}", message())}
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

        {/* THE ONE HIGH-CONTRAST DARK BAND on the light landing page: Under the hood */}
        <section class="lp-hood ground-inverse" id="hood" aria-labelledby="hood-title">
          <div class="lp-wrap wrap">
            <div class="lp-hood-top">
              <div class="lp-sec-head">
                <h2 id="hood-title">
                  {LANDING_COPY.hoodTitle} <span class="lp-muted">{LANDING_COPY.hoodTitleMuted}</span>
                </h2>
                <p>{LANDING_COPY.hoodLede}</p>
              </div>
              <ul class="lp-hood-list">
                <For each={STACK}>
                  {(part) => (
                    <li>
                      <a class="lp-hood-row" href={engineUrl(part.repo)} target="_blank" rel="noreferrer">
                        <span class="lp-hood-name">{part.name}</span>
                        <span class="lp-hood-desc">{part.desc}</span>
                        <Icon name="external" class="lp-hood-ext" />
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </div>

            <ul class="lp-specs">
              <li class="lp-spec">
                <h3>{LANDING_COPY.hoodBunTitle}</h3>
                <p>
                  Runs <code>bun install</code>, <code>bun run</code>, <code>bun test</code>,{" "}
                  <code>bun build</code> and <code>bun:sqlite</code> straight in the tab.
                </p>
                <div class="lp-specimen lp-specimen-term" data-ui="terminal" aria-hidden="true">
                  <span>
                    <span class="lp-specimen-prompt">$</span> bun --version
                  </span>
                  <span class="lp-specimen-out">1.4.5</span>
                  <span>
                    <span class="lp-specimen-prompt">$</span> bun test
                  </span>
                  <span class="lp-specimen-out">
                    {" "}
                    <b>1 pass</b> · 0 fail
                  </span>
                </div>
              </li>

              <li class="lp-spec">
                <h3>{LANDING_COPY.hoodTabsTitle}</h3>
                <p>{LANDING_COPY.hoodTabsBody}</p>
                <div class="lp-specimen lp-specimen-tabs" data-ui="tabs" aria-hidden="true">
                  <div class="lp-specimen-tabbar">
                    <span class="lp-specimen-tab">{LANDING_COPY.hoodTabsTab1}</span>
                    <span class="lp-specimen-tab is-active">
                      <span class="lp-lamp" />
                      {LANDING_COPY.hoodTabsTab2}
                    </span>
                  </div>
                  <div class="lp-specimen-plate">
                    <div class="lp-handoff-ask">
                      <span>{LANDING_COPY.hoodTabsPrompt}</span>
                      <span class="lp-handoff-store">
                        <Icon name="drive" />
                        {LANDING_COPY.hoodTabsStorage}
                      </span>
                    </div>
                    <div class="lp-handoff-state">
                      <span>
                        <b>{LANDING_COPY.hoodTabsTab1}</b>
                        {LANDING_COPY.hoodTabsTab1State}
                      </span>
                      <Icon name="right" />
                      <span class="is-live">
                        <b>{LANDING_COPY.hoodTabsTab2}</b>
                        {LANDING_COPY.hoodTabsTab2State}
                      </span>
                    </div>
                  </div>
                </div>
              </li>

              <li class="lp-spec">
                <h3>{LANDING_COPY.hoodPreviewTitle}</h3>
                <p>
                  Public builds serve each dev server on its own origin (
                  <code>&lt;id&gt;-&lt;port&gt;-pv.sprockt.dev</code>) with live HMR.
                </p>
                <div class="lp-specimen lp-specimen-origin" aria-hidden="true">
                  <div class="lp-origin-bar">
                    <span class="lp-lamp" />
                    <code>&lt;id&gt;-5173-pv.sprockt.dev/</code>
                  </div>
                  <div class="lp-origin-note">
                    <span>Own origin per workspace</span>
                    <span>Root paths resolve at /</span>
                  </div>
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

        {/* Sheet & Biro editorial closing on daylight ground */}
        <section class="lp-close closing" aria-labelledby="close-title">
          <div class="lp-wrap wrap">
            <div class="lp-close-top">
              <div>
                <h2 class="lp-close-title" id="close-title">
                  {LANDING_COPY.closingTitle}
                </h2>
                <p class="lp-close-lede">{LANDING_COPY.closingLede}</p>
              </div>
              <button
                type="button"
                class="lp-btn lp-btn-primary lp-btn-lg"
                disabled={creatingTemplate() !== undefined}
                data-testid="closing-start-cta"
                onClick={() => void launchTemplate("vite-react")}
              >
                {creatingTemplate() === "vite-react" ? LANDING_COPY.templateCreating : LANDING_COPY.heroCta}
              </button>
            </div>
            <p class="lp-close-word" aria-hidden="true">
              Sprockt
            </p>
          </div>
        </section>
      </main>

      <footer class="lp-foot">
        <div class="lp-wrap wrap">
          <div class="lp-foot-about">
            <span class="lp-brand lp-foot-brand">
              <SprocktLogo class="lp-brand-mark" />
              <span>Sprockt</span>
            </span>
            <p>{LANDING_COPY.footerLine}</p>
          </div>
          <nav class="lp-foot-group" aria-labelledby="foot-start">
            <h3 id="foot-start">{LANDING_COPY.footerGroupStart}</h3>
            <a href="#templates">{LANDING_COPY.navTemplates}</a>
            <button
              type="button"
              disabled={creatingTemplate() !== undefined}
              data-testid="new-workspace"
              onClick={() => void launchTemplate("blank")}
            >
              {creatingTemplate() === "blank" ? LANDING_COPY.templateCreating : LANDING_COPY.altBlank}
            </button>
            <a href="#browsers">{LANDING_COPY.navBrowsers}</a>
          </nav>
          <nav class="lp-foot-group" aria-labelledby="foot-project">
            <h3 id="foot-project">{LANDING_COPY.footerGroupProject}</h3>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              {LANDING_COPY.navGithub}
            </a>
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              {LANDING_COPY.navDocs}
            </a>
          </nav>
          <nav class="lp-foot-group lp-foot-engines" aria-labelledby="foot-engines">
            <h3 id="foot-engines">{LANDING_COPY.footerGroupEngines}</h3>
            <For each={STACK}>
              {(part) => (
                <a href={engineUrl(part.repo)} target="_blank" rel="noreferrer">
                  {part.name}
                </a>
              )}
            </For>
          </nav>
        </div>
      </footer>
    </div>
  );
}
