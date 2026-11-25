// Circuit landing page: GitHub repo bar, starter templates, local workspace switcher, and proof band.
// Loads zero editor, terminal, or runtime code on initial render.
import geistLatinUrl from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url";
import geistMonoLatinUrl from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { navigate } from "../app/router";
import { routePath, type Route } from "../app/routes";
import { STARTER_TEMPLATE_SUMMARIES, type TemplateId, type TemplateSummary } from "../templates/metadata";
import { LANDING_COPY } from "./copy";
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

preloadFont(geistLatinUrl);
preloadFont(geistMonoLatinUrl);

export function Landing() {
  const theme = createThemeController();
  const [repoInput, setRepoInput] = createSignal("");
  const [repoError, setRepoError] = createSignal<string | undefined>();
  const [creatingTemplate, setCreatingTemplate] = createSignal<TemplateId | undefined>();
  const [createError, setCreateError] = createSignal<string | undefined>();
  const [phoneMenuOpen, setPhoneMenuOpen] = createSignal(false);

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

  onMount(() => {
    void refreshWorkspaces();
    document.addEventListener("visibilitychange", refreshOnVisible);
    window.addEventListener("focus", refreshOnVisible);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", refreshOnVisible);
      window.removeEventListener("focus", refreshOnVisible);
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

  function renderTemplateCard(template: TemplateSummary) {
    const isCreating = () => creatingTemplate() === template.id;
    const isFeatured = Boolean(template.featured);

    return (
      <button
        type="button"
        class={isFeatured ? "lp-tpl is-featured" : "lp-tpl"}
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
          <span class="lp-btn lp-btn-ghost">
            {isCreating() ? LANDING_COPY.templateCreating : LANDING_COPY.templateAction}
          </span>
        </Show>
      </button>
    );
  }

  const hasRepoInput = () => repoInput().trim().length > 0;
  const nextTheme = () => (theme.resolved() === "dark" ? "light" : "dark");

  return (
    <div class="landing-page" data-testid="landing-page">
      <header class="lp-nav">
        <div class="lp-wrap">
          <a
            class="lp-brand"
            href={routePath({ kind: "landing" })}
            onClick={(event) => {
              event.preventDefault();
              navigate({ kind: "landing" });
            }}
          >
            <span class="lp-brand-tile">
              <Icon name="logo" />
            </span>
            Sprockt
          </a>
          <nav class="lp-nav-links" aria-label="Site">
            <a href="#templates">{LANDING_COPY.navTemplates}</a>
            <a href="#why">{LANDING_COPY.navWhy}</a>
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              {LANDING_COPY.navDocs}
            </a>
          </nav>
          <div class="lp-nav-right">
            <a
              class="lp-btn lp-btn-line lp-desktop-only"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              aria-label={LANDING_COPY.navGithub}
            >
              <Icon name="github" />
              <span>{LANDING_COPY.navGithub}</span>
            </a>
            <div class="lp-theme-switch lp-desktop-only" role="group" aria-label="Theme">
              <button
                type="button"
                title="Light theme"
                aria-label="Light theme"
                aria-pressed={theme.resolved() === "light"}
                class={theme.resolved() === "light" ? "is-active" : undefined}
                data-testid="theme-light"
                onClick={() => theme.setTheme("light")}
              >
                <Icon name="sun" />
              </button>
              <button
                type="button"
                title="Dark theme"
                aria-label="Dark theme"
                aria-pressed={theme.resolved() === "dark"}
                class={theme.resolved() === "dark" ? "is-active" : undefined}
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

            {/* Compact phone header: 36px theme button + 36px menu button */}
            <div class="lp-phone-nav-controls">
              <button
                type="button"
                class="lp-phone-icon-btn"
                title={`Switch to ${nextTheme()} theme`}
                aria-label={`Switch to ${nextTheme()} theme`}
                data-testid="phone-theme-toggle"
                onClick={() => theme.setTheme(nextTheme())}
              >
                <Icon name={theme.resolved() === "dark" ? "sun" : "moon"} />
              </button>
              <div class="lp-phone-menu-wrap">
                <button
                  type="button"
                  class={phoneMenuOpen() ? "lp-phone-icon-btn is-open" : "lp-phone-icon-btn"}
                  aria-label="Menu"
                  aria-expanded={phoneMenuOpen()}
                  data-testid="phone-menu-toggle"
                  onClick={() => setPhoneMenuOpen((open) => !open)}
                >
                  <Icon name={phoneMenuOpen() ? "x" : "menu"} />
                </button>
                <Show when={phoneMenuOpen()}>
                  <nav class="lp-phone-menu-panel" aria-label="Mobile navigation" data-testid="phone-menu">
                    <a href="#templates" onClick={() => setPhoneMenuOpen(false)}>
                      {LANDING_COPY.navTemplates}
                    </a>
                    <a href="#why" onClick={() => setPhoneMenuOpen(false)}>
                      {LANDING_COPY.navWhy}
                    </a>
                    <a
                      href={DOCS_URL}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setPhoneMenuOpen(false)}
                    >
                      {LANDING_COPY.navDocs}
                    </a>
                    <a
                      href={REPO_URL}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setPhoneMenuOpen(false)}
                    >
                      <Icon name="github" />
                      {LANDING_COPY.navGithub}
                    </a>
                  </nav>
                </Show>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div class="lp-hero-band">
        {/* Architectural sprocket tooth motif owned by the Sprockt brand */}
        <svg class="lp-hero-motif" viewBox="0 0 640 640" aria-hidden="true">
          <circle
            cx="320"
            cy="320"
            r="250"
            fill="none"
            stroke="currentColor"
            stroke-width="28"
            stroke-dasharray="22 22"
          />
          <circle cx="320" cy="320" r="196" fill="none" stroke="currentColor" stroke-width="1.5" />
          <circle cx="320" cy="320" r="96" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>

        <div class="lp-wrap">
          <section class="lp-hero">
            <div class="lp-hero-copy" data-enter>
              <h1>{LANDING_COPY.heroTitle}</h1>
              <p class="lp-lede">{LANDING_COPY.heroLede}</p>
              <div class="lp-hero-actions">
                <button
                  type="button"
                  class="lp-btn lp-btn-accent lp-btn-lg"
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
            </div>

            <form class="lp-console" role="search" onSubmit={handleGithubSubmit} noValidate>
              <div class="lp-console-head">
                <b>{LANDING_COPY.consoleTitle}</b>
                <span class="lp-console-pill">
                  <img src={LOGOS.bun} alt="" width="14" height="12" />
                  <span>{LANDING_COPY.heroPill}</span>
                </span>
                <span class="lp-console-bar" aria-hidden="true" />
              </div>
              <div class="lp-open-row">
                <Icon name="github" class="lp-open-ico" />
                <div class="lp-open-field">
                  <span class="lp-prefix" aria-hidden="true">
                    github.com/
                  </span>
                  <label class="lp-sr-only" for="repo-input">
                    {LANDING_COPY.openLabel}
                  </label>
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
                </div>
                <button
                  class={hasRepoInput() ? "lp-btn lp-btn-accent" : "lp-btn lp-btn-repo"}
                  type="submit"
                  data-testid="repo-submit"
                >
                  <span>{LANDING_COPY.openButton}</span> <kbd>↵</kbd>
                </button>
              </div>
              <Show when={repoError()}>
                {(message) => (
                  <p id="repo-error" class="lp-open-error" role="alert" data-testid="repo-error">
                    {message()}
                  </p>
                )}
              </Show>
              <pre class="lp-boot" aria-hidden="true">
                <span>
                  <span class="r">→</span> <span class="d">clone</span> ShaulLavo/bash-web
                </span>
                <span>
                  <span class="r">$</span> bun install
                </span>
                <span>
                  {"  "}
                  <span class="g">ready</span> packages saved in IndexedDB
                </span>
                <span>
                  <span class="g">✓</span> dev server on <span class="c">http://localhost:5173/</span>
                </span>
              </pre>
              <div class="lp-open-foot">
                <span class="lp-foot-try">
                  <span class="lp-try-label">{LANDING_COPY.openTry}</span>
                  <a
                    class="lp-repo-link"
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
                  class="lp-foot-action"
                  disabled={creatingTemplate() !== undefined}
                  data-testid="new-workspace"
                  onClick={() => void launchTemplate("blank")}
                >
                  <Icon name="file-plus" />
                  <span class="lp-blank-desktop">
                    {creatingTemplate() === "blank" ? LANDING_COPY.templateCreating : LANDING_COPY.altBlank}
                  </span>
                  <span class="lp-blank-phone">
                    {creatingTemplate() === "blank"
                      ? LANDING_COPY.templateCreating
                      : LANDING_COPY.altBlankShort}
                  </span>
                </button>
              </div>
            </form>
          </section>

          <WorkbenchPreview />
        </div>
      </div>

      <main class="lp-wrap">
        <div class="lp-main-grid">
          <section id="templates" aria-labelledby="tpl-title">
            <div class="lp-sec-head">
              <h2 id="tpl-title">{LANDING_COPY.templatesTitle}</h2>
              <p>{LANDING_COPY.templatesNote}</p>
            </div>
            <Show when={createError()}>
              {(message) => (
                <p class="lp-create-error" role="alert" data-testid="template-error">
                  Could not create workspace: {message()}
                </p>
              )}
            </Show>
            <div class="lp-tpls" data-testid="template-grid">
              <For each={STARTER_TEMPLATE_SUMMARIES}>{(template) => renderTemplateCard(template)}</For>
            </div>
          </section>

          <WorkspaceSwitcher
            workspaces={workspaces}
            loading={loadingWorkspaces()}
            onOpen={(id) => navigate({ kind: "workspace", id })}
            onRefresh={() => void refreshWorkspaces()}
          />
        </div>

        <section class="lp-why-sec" id="why" aria-labelledby="why-title">
          <div class="lp-sec-head">
            <h2 id="why-title">{LANDING_COPY.whyTitle}</h2>
            <p>{LANDING_COPY.whyNote}</p>
          </div>
          <div class="lp-specs">
            <div class="lp-spec">
              <div class="lp-spec-tag" aria-hidden="true">
                <img src={LOGOS.chrome} alt="" width="16" height="16" loading="lazy" />
                <img src={LOGOS.firefox} alt="" width="16" height="16" loading="lazy" />
                <img src={LOGOS.safari} alt="" width="16" height="16" loading="lazy" />
                <span>iPhone</span>
              </div>
              <h3>{LANDING_COPY.whyBrowsersTitle}</h3>
              <p>{LANDING_COPY.whyBrowsersBody}</p>
            </div>

            <div class="lp-spec">
              <div class="lp-spec-tag" aria-hidden="true">
                <span class="lp-spec-accent">$</span> bun run · test · sqlite
              </div>
              <h3>{LANDING_COPY.whyBunTitle}</h3>
              <p>
                Runs <code>bun install</code>, <code>bun run</code>, <code>bun test</code>,{" "}
                <code>bun build</code> and <code>bun:sqlite</code> straight in the tab.
              </p>
            </div>

            <div class="lp-spec">
              <div class="lp-spec-tag" aria-hidden="true">
                <span class="lp-spec-ok">●</span> Multi-tab IndexedDB
              </div>
              <h3>{LANDING_COPY.whyTabsTitle}</h3>
              <p>{LANDING_COPY.whyTabsBody}</p>
            </div>

            <div class="lp-spec">
              <div class="lp-spec-tag" aria-hidden="true">
                <span class="lp-spec-accent">MIT</span> Open source
              </div>
              <h3>{LANDING_COPY.whyOssTitle}</h3>
              <p>{LANDING_COPY.whyOssBody}</p>
            </div>
          </div>
          <p class="lp-limits-note">
            <Icon name="alert" />
            <span>
              Honest limits: native <code>.node</code> addons and Docker do not run in WebAssembly.
            </span>
          </p>
        </section>
      </main>

      <footer class="lp-foot">
        <div class="lp-wrap">
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
      </footer>
    </div>
  );
}
