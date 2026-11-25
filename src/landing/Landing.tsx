// Circuit landing page: GitHub repo bar, starter templates, local workspace switcher, and proof band.
// Loads zero editor, terminal, or runtime code on initial render.
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { navigate } from "../app/router";
import { routePath, type Route } from "../app/routes";
import { STARTER_TEMPLATE_SUMMARIES, type TemplateId, type TemplateSummary } from "../templates/metadata";
import { newWorkspaceId } from "../workspace/paths";
import { LANDING_COPY } from "./copy";
import { parseGithubInput } from "./github-input";
import { Icon } from "./icons";
import { BrandLogoTile, LOGOS } from "./logos";
import { createThemeController } from "./theme";
import { WorkbenchPreview } from "./WorkbenchPreview";
import { listStoredWorkspaces, saveWorkspaceHint } from "./workspaces";
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

export function Landing() {
  const theme = createThemeController();
  const [repoInput, setRepoInput] = createSignal("");
  const [repoError, setRepoError] = createSignal<string | undefined>();
  const [creatingTemplate, setCreatingTemplate] = createSignal<TemplateId | undefined>();
  const [createError, setCreateError] = createSignal<string | undefined>();

  const [workspaces, { refetch }] = createResource(listStoredWorkspaces, { initialValue: [] });

  function refreshOnVisible(): void {
    if (document.visibilityState === "visible") void refetch();
  }

  onMount(() => {
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
    const id = newWorkspaceId();
    try {
      const { seedWorkspace } = await import("../templates/seed");
      const meta = await seedWorkspace(id, templateId);
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
          <span class="lp-btn lp-btn-accent">
            {isCreating() ? LANDING_COPY.templateCreating : LANDING_COPY.templateAction}
          </span>
        </Show>
      </button>
    );
  }

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
              class="lp-btn lp-btn-line"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              aria-label={LANDING_COPY.navGithub}
            >
              <Icon name="github" />
              <span>{LANDING_COPY.navGithub}</span>
            </a>
            <div class="lp-theme-switch" role="group" aria-label="Theme">
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
              class="lp-btn lp-btn-accent lp-nav-cta"
              disabled={creatingTemplate() !== undefined}
              data-testid="header-new-workspace"
              onClick={() => void launchTemplate("vite-react")}
            >
              {LANDING_COPY.navCta}
            </button>
          </div>
        </div>
      </header>

      <div class="lp-hero-band">
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
                <button class="lp-btn lp-btn-accent" type="submit" data-testid="repo-submit">
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
                  <span class="r">→</span> <span class="d">template</span> Vite + React
                </span>
                <span>
                  <span class="r">$</span> bun install <span class="d">v1.4.4</span>
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
                <span class="lp-sep" />
                <button
                  type="button"
                  class="lp-foot-action"
                  disabled={creatingTemplate() !== undefined}
                  data-testid="new-workspace"
                  onClick={() => void launchTemplate("blank")}
                >
                  <Icon name="file-plus" />
                  <span>
                    {creatingTemplate() === "blank" ? LANDING_COPY.templateCreating : LANDING_COPY.altBlank}
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
            workspaces={workspaces()}
            loading={workspaces.loading}
            onOpen={(id) => navigate({ kind: "workspace", id })}
            onRefresh={() => void refetch()}
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
                <img src={LOGOS.chrome} alt="" width="18" height="18" loading="lazy" />
                <img src={LOGOS.firefox} alt="" width="18" height="18" loading="lazy" />
                <img src={LOGOS.safari} alt="" width="18" height="18" loading="lazy" />
                <span>iPhone</span>
              </div>
              <h3>{LANDING_COPY.whyBrowsersTitle}</h3>
              <p>{LANDING_COPY.whyBrowsersBody}</p>
            </div>

            <div class="lp-spec">
              <div class="lp-spec-tag is-mono" aria-hidden="true">
                <span class="lp-spec-accent">$</span> bun --version <b>1.4.4</b>
              </div>
              <h3>{LANDING_COPY.whyBunTitle}</h3>
              <p>
                Runs <code>bun install</code>, <code>bun run</code>, <code>bun test</code>,{" "}
                <code>bun build</code> and <code>bun:sqlite</code> straight in the tab.
              </p>
            </div>

            <div class="lp-spec">
              <div class="lp-spec-tag is-live" aria-hidden="true">
                <span class="lp-live-pill" />
                <span>Shared IndexedDB + dev server</span>
              </div>
              <h3>{LANDING_COPY.whyTabsTitle}</h3>
              <p>{LANDING_COPY.whyTabsBody}</p>
            </div>

            <div class="lp-spec">
              <div class="lp-spec-tag is-mono" aria-hidden="true">
                <span class="lp-spec-accent">MIT</span> Open source on GitHub
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
