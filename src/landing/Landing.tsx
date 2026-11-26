// The landing page: open a repo or a starter, see the workbench, pick up a saved workspace.
// Loads zero editor, terminal, or runtime code on initial render.
import archivoLatinUrl from "@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2?url";
import plexMonoLatinUrl from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url";
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
import { CHAINRING, chainringPath, toothPath } from "../ui/sprocket";
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

/** The browsers Sprockt runs in, and what runs in each. The phone has no logo of its own. */
const BROWSERS = [
  { name: LANDING_COPY.browserChrome, body: LANDING_COPY.browserChromeBody, logo: LOGOS.chrome },
  { name: LANDING_COPY.browserFirefox, body: LANDING_COPY.browserFirefoxBody, logo: LOGOS.firefox },
  { name: LANDING_COPY.browserSafari, body: LANDING_COPY.browserSafariBody, logo: LOGOS.safari },
  { name: LANDING_COPY.browserIphone, body: LANDING_COPY.browserIphoneBody, logo: undefined },
] as const;

/** The parts Sprockt is built from, in the order the sentence beside them names their roles. */
const STACK = [
  { role: LANDING_COPY.whyOssRoleRuntime, repo: "bun-wasm" },
  { role: LANDING_COPY.whyOssRoleOs, repo: "waffle", name: "Waffle" },
  { role: LANDING_COPY.whyOssRoleEditor, repo: "singapore", name: "Singapore" },
  { role: LANDING_COPY.whyOssRoleTerminal, repo: "ghostty-webgpu" },
  { role: LANDING_COPY.whyOssRoleShell, repo: "bash-web" },
] as const;

function engineUrl(repo: string): string {
  return `https://github.com/ShaulLavo/${repo}`;
}

const CHAINRING_PATH = chainringPath(CHAINRING);
/** The one lit tooth of the large mark, as on the small one: the tooth at the top of the arc. */
const CHAINRING_LIT = toothPath(CHAINRING, 40, 0.3);

/** The starters, then the empty workspace as the last cell. */
const TEMPLATES = STARTER_TEMPLATE_SUMMARIES.concat(BLANK_TEMPLATE_SUMMARY);

/** A headline's last full stop is set in the lamp color: the page's one lit tooth. */
function splitFinalStop(text: string): readonly [body: string, stop: string] {
  return text.endsWith(".") ? [text.slice(0, -1), "."] : [text, ""];
}

/** A statement of two sentences, one per line, so neither ends on a lone word. */
function sentences(text: string): readonly string[] {
  return text.split(/(?<=\.)\s+/);
}

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

  /** Saved workspaces get a column of their own; with none, the starters take the full width. */
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

  const [titleBody, titleStop] = splitFinalStop(LANDING_COPY.heroTitle);

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
              class="lp-btn lp-btn-line lp-nav-cta lp-desktop-only"
              disabled={creatingTemplate() !== undefined}
              data-testid="header-new-workspace"
              onClick={() => void launchTemplate("vite-react")}
            >
              {LANDING_COPY.navCta}
            </button>
            {/* The phone bar holds the mark, the theme and the menu: the start button is right below. */}
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
        <section class="lp-hero hero" data-enter aria-labelledby="hero-title">
          <div class="lp-wrap wrap">
            <div class="lp-hero-text hero-text">
              <h1 id="hero-title">
                {titleBody}
                <span class="lp-stop">{titleStop}</span>
              </h1>
              <p class="lp-lede">{LANDING_COPY.heroLede}</p>
              <div class="lp-hero-controls">
                <div class="lp-hero-actions">
                  <button
                    type="button"
                    class="lp-btn lp-btn-primary lp-btn-lg"
                    disabled={creatingTemplate() !== undefined}
                    data-testid="hero-start-cta"
                    onClick={() => void launchTemplate("vite-react")}
                  >
                    {creatingTemplate() === "vite-react"
                      ? LANDING_COPY.templateCreating
                      : LANDING_COPY.heroCta}
                  </button>
                  <a class="lp-btn lp-btn-line lp-btn-lg" href="#templates">
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
            </div>

            {/* The product itself, in the browser tab the headline promises. */}
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
                <span class="lp-tab-note">{LANDING_COPY.heroPill}</span>
              </div>
              <WorkbenchPreview demo={demo} pane="terminal" label={LANDING_COPY.showcaseBenchFrame} />
            </div>
          </div>
        </section>

        <section class="lp-any" id="browsers" aria-labelledby="any-title">
          <div class="lp-wrap wrap">
            <div class="lp-any-text">
              <div class="lp-sec-head">
                <h2 id="any-title">{LANDING_COPY.showcaseTitle}</h2>
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
            {/* The same workspace again, as a phone holds it, open on the running app: one state,
                two renders. A phone visitor gets it too, and the four tabs under it switch panes. */}
            <div class="lp-phone">
              <WorkbenchPreview demo={demo} pane="preview" label={LANDING_COPY.showcaseHeroFrame} />
              <div class="lp-phone-bar" aria-hidden="true">
                <span>sprockt.dev</span>
                <Icon name="reload" />
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
                  <span>
                    <span class="lp-specimen-prompt">$</span> bun --version
                  </span>
                  <span class="lp-specimen-out">1.4.5</span>
                  <span>
                    <span class="lp-specimen-prompt">$</span> bun test
                  </span>
                  <span class="lp-specimen-out">
                    {" "}
                    <b>1 pass</b>
                  </span>
                  <span class="lp-specimen-out"> 0 fail</span>
                </div>
              </li>

              <li class="lp-spec">
                <h3>{LANDING_COPY.whyTabsTitle}</h3>
                <p>{LANDING_COPY.whyTabsBody}</p>
                <div class="lp-specimen lp-specimen-tabs" data-ui="tabs" aria-hidden="true">
                  <div class="lp-tab-strip">
                    <span class="lp-tab-tooth">{LANDING_COPY.whyTabsTab1}</span>
                    <span class="lp-tab-tooth is-active">
                      <span class="lp-lamp" />
                      {LANDING_COPY.whyTabsTab2}
                    </span>
                  </div>
                  {/* Two tabs on one workspace: the first hosts the files, the second attaches live. */}
                  <div class="lp-specimen-plate">
                    <div class="lp-handoff-ask">
                      <span>{LANDING_COPY.whyTabsPrompt}</span>
                      <span class="lp-handoff-store">
                        <Icon name="drive" />
                        {LANDING_COPY.whyTabsStorage}
                      </span>
                    </div>
                    <div class="lp-handoff-state">
                      <span>
                        <b>{LANDING_COPY.whyTabsTab1}</b>
                        {LANDING_COPY.whyTabsTab1State}
                      </span>
                      <Icon name="right" />
                      <span class="is-live">
                        <b>{LANDING_COPY.whyTabsTab2}</b>
                        {LANDING_COPY.whyTabsTab2State}
                      </span>
                    </div>
                  </div>
                </div>
              </li>

              <li class="lp-spec">
                <h3>{LANDING_COPY.whyOssTitle}</h3>
                <p>{LANDING_COPY.whyOssBody}</p>
                <div class="lp-specimen lp-specimen-stack" data-ui="stack" aria-hidden="true">
                  <dl class="lp-stack">
                    <For each={STACK}>
                      {(part) => (
                        <div>
                          <dt>{part.role}</dt>
                          <dd>{"name" in part ? part.name : part.repo}</dd>
                        </div>
                      )}
                    </For>
                  </dl>
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

        <section class="lp-close closing" aria-labelledby="close-title">
          <div class="lp-wrap wrap">
            <h2 class="lp-close-title" id="close-title">
              <For each={sentences(LANDING_COPY.closingTitle)}>{(sentence) => <span>{sentence}</span>}</For>
            </h2>
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
          {/* The mark, large: its upper arc rises out of the band's lower edge, one tooth lit. */}
          <svg class="lp-chainring" viewBox="0 0 240 240" aria-hidden="true">
            <path class="lp-chainring-body" fill-rule="evenodd" d={CHAINRING_PATH} />
            <path class="lp-chainring-lit" d={CHAINRING_LIT} />
          </svg>
        </section>
      </main>

      <footer class="lp-foot">
        <div class="lp-wrap wrap">
          <div class="lp-foot-about">
            <span class="lp-brand lp-foot-brand">
              <Icon name="logo" class="lp-brand-mark" />
              <span>Sprockt</span>
            </span>
            <p>{LANDING_COPY.footerLine}</p>
          </div>
          <nav class="lp-foot-group" aria-labelledby="foot-start">
            <h2 id="foot-start">{LANDING_COPY.footerGroupStart}</h2>
            <a href="#templates">{LANDING_COPY.navTemplates}</a>
            <button
              type="button"
              disabled={creatingTemplate() !== undefined}
              data-testid="new-workspace"
              onClick={() => void launchTemplate("blank")}
            >
              {creatingTemplate() === "blank" ? LANDING_COPY.templateCreating : LANDING_COPY.altBlank}
            </button>
            <a href="#why">{LANDING_COPY.navWhy}</a>
          </nav>
          <nav class="lp-foot-group" aria-labelledby="foot-project">
            <h2 id="foot-project">{LANDING_COPY.footerGroupProject}</h2>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              {LANDING_COPY.navGithub}
            </a>
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              {LANDING_COPY.navDocs}
            </a>
          </nav>
          <nav class="lp-foot-group lp-foot-engines" aria-labelledby="foot-engines">
            <h2 id="foot-engines">{LANDING_COPY.footerGroupEngines}</h2>
            <For each={STACK}>
              {(part) => (
                <a href={engineUrl(part.repo)} target="_blank" rel="noreferrer">
                  {"name" in part ? part.name : part.repo}
                </a>
              )}
            </For>
          </nav>
        </div>
      </footer>
    </div>
  );
}
