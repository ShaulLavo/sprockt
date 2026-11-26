// The landing page, a port of the #4 "Sheet and Biro" design (set-a/dir-1): a centred hero whose
// live workbench rises out of a painterly textured frame, 2x2 feature cards, the starters and
// GitHub import, the dark browsers band with the iPhone, the Waffle hub, the questions and the
// giant wordmark close. Loads zero editor, terminal or Waffle runtime code on initial render.
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
import { applyStoredTheme, colorScheme, setColorScheme } from "../workbench/theme";
import { LANDING_COPY } from "./copy";
import { createDemo } from "./demo";
import { FeatureCards } from "./FeatureCards";
import { parseGithubInput } from "./github-input";
import { HubDiagram } from "./HubDiagram";
import { Icon } from "./icons";
import { BrandLogoTile, LOGOS } from "./logos";
import { WorkbenchPreview } from "./WorkbenchPreview";
import {
  hasWorkspaceHints,
  listStoredWorkspaces,
  saveWorkspaceHint,
  type StoredWorkspaceSummary,
} from "./workspaces";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import "./landing.css";
import "./workbench-preview.css";
import "./workspace-switcher.css";

const SAMPLE_GITHUB_ROUTE: Extract<Route, { kind: "github" }> = {
  kind: "github",
  owner: "ShaulLavo",
  repo: "bash-web",
};
const SAMPLE_GITHUB_PATH = routePath(SAMPLE_GITHUB_ROUTE);
const REPO_URL = "https://github.com/ShaulLavo/sprockt";
const DOCS_URL = "https://github.com/ShaulLavo/sprockt#readme";
const LICENSE_URL = "https://github.com/ShaulLavo/sprockt/blob/main/LICENSE";

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
  { name: LANDING_COPY.browserChrome, logo: LOGOS.chrome },
  { name: LANDING_COPY.browserFirefox, logo: LOGOS.firefox },
  { name: LANDING_COPY.browserSafari, logo: LOGOS.safari },
  { name: LANDING_COPY.browserIphone, logo: LOGOS.safari },
] as const;

const MARQUEE = [
  "Chrome on Windows",
  "Chrome on macOS",
  "Chrome on Linux",
  "Firefox on Windows",
  "Firefox on macOS",
  "Firefox on Linux",
  "Safari on macOS",
  "Safari on iPhone",
] as const;

const STACK = [
  { name: "Singapore", repo: "singapore", role: LANDING_COPY.hoodRoleSingapore },
  { name: "Ghostty WebGPU", repo: "ghostty-webgpu", role: LANDING_COPY.hoodRoleGhostty },
  { name: "Bun 1.4.5", repo: "bun-wasm", role: LANDING_COPY.hoodRoleBun },
  { name: "tsrs", repo: "tsrs", role: LANDING_COPY.hoodRoleTsrs },
  { name: "bash-web", repo: "bash-web", role: LANDING_COPY.hoodRoleBash },
] as const;

const FAQ = [
  [LANDING_COPY.faqCostQ, LANDING_COPY.faqCostA],
  [LANDING_COPY.faqRunQ, LANDING_COPY.faqRunA],
  [LANDING_COPY.faqReposQ, LANDING_COPY.faqReposA],
  [LANDING_COPY.faqFilesQ, LANDING_COPY.faqFilesA],
  [LANDING_COPY.faqBrowsersQ, LANDING_COPY.faqBrowsersA],
  [LANDING_COPY.faqIphoneQ, LANDING_COPY.faqIphoneA],
] as const;

const LICENSE_LINES = [
  "MIT License",
  " ",
  "Permission is hereby granted, free of charge,",
  "to any person obtaining a copy of this software",
  "and associated documentation files, to deal in",
  "the Software without restriction.",
] as const;

function engineUrl(repo: string): string {
  return `https://github.com/ShaulLavo/${repo}`;
}

/** The seven real starters, plus Blank as the last option. */
const TEMPLATES = STARTER_TEMPLATE_SUMMARIES.concat(BLANK_TEMPLATE_SUMMARY);

function nextTheme(): "light" | "dark" {
  return colorScheme() === "dark" ? "light" : "dark";
}

function nextThemeLabel(): string {
  return nextTheme() === "light" ? LANDING_COPY.navThemeLight : LANDING_COPY.navThemeDark;
}

function Muted(props: { readonly lead: string; readonly rest: string }) {
  return (
    <>
      {props.lead} <span class="lp-muted">{props.rest}</span>
    </>
  );
}

export function Landing() {
  applyStoredTheme();
  const demo = createDemo();
  const [repoInput, setRepoInput] = createSignal("");
  const [repoError, setRepoError] = createSignal<string | undefined>();
  const [creatingTemplate, setCreatingTemplate] = createSignal<TemplateId | undefined>();
  const [createError, setCreateError] = createSignal<string | undefined>();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [marqueePaused, setMarqueePaused] = createSignal(false);

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

  const startLabel = (id: TemplateId) =>
    creatingTemplate() === id ? LANDING_COPY.templateCreating : LANDING_COPY.heroCta;

  function renderTemplate(template: TemplateSummary) {
    return (
      <li>
        <button
          type="button"
          class="lp-starter"
          disabled={creatingTemplate() !== undefined}
          aria-busy={creatingTemplate() === template.id ? "true" : undefined}
          data-testid={`template-${template.id}`}
          onClick={() => void launchTemplate(template.id)}
        >
          <BrandLogoTile templateId={template.id} />
          <span class="lp-starter-name">{template.label}</span>
          <span class="lp-starter-line">
            {creatingTemplate() === template.id ? LANDING_COPY.templateCreating : template.description}
          </span>
          <Icon name="chev-r" class="lp-starter-go" />
        </button>
      </li>
    );
  }

  const navLinks = () => (
    <>
      <a class="lp-nav-link" href="#features" onClick={() => setMenuOpen(false)}>
        {LANDING_COPY.navEditor}
      </a>
      <a class="lp-nav-link" href="#start" onClick={() => setMenuOpen(false)}>
        {LANDING_COPY.navTemplates}
      </a>
      <a class="lp-nav-link" href="#browsers" onClick={() => setMenuOpen(false)}>
        {LANDING_COPY.navBrowsers}
      </a>
      <a class="lp-nav-link" href="#hood" onClick={() => setMenuOpen(false)}>
        {LANDING_COPY.navHood}
      </a>
      <a class="lp-nav-link" href="#faq" onClick={() => setMenuOpen(false)}>
        {LANDING_COPY.navQuestions}
      </a>
    </>
  );

  return (
    <div class="landing-page" data-testid="landing-page">
      <a class="lp-skip" href="#main">
        {LANDING_COPY.skip}
      </a>
      <header class="lp-nav" classList={{ "is-open": menuOpen() }}>
        <div class="lp-wrap lp-nav-bar">
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
          <div class="lp-nav-actions">
            <a
              class="lp-nav-icon lp-desktop-only"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              aria-label={LANDING_COPY.navGithub}
              title={LANDING_COPY.navGithub}
            >
              <Icon name="github" />
            </a>
            <div class="lp-theme-switch lp-desktop-only" role="group" aria-label="Theme">
              <button
                type="button"
                title={LANDING_COPY.navThemeLight}
                aria-label={LANDING_COPY.navThemeLight}
                aria-pressed={colorScheme() === "light"}
                data-testid="theme-light"
                onClick={() => setColorScheme("light")}
              >
                <Icon name="sun" />
              </button>
              <button
                type="button"
                title={LANDING_COPY.navThemeDark}
                aria-label={LANDING_COPY.navThemeDark}
                aria-pressed={colorScheme() === "dark"}
                data-testid="theme-dark"
                onClick={() => setColorScheme("dark")}
              >
                <Icon name="moon" />
              </button>
            </div>
            <button
              type="button"
              class="lp-btn lp-btn-primary lp-desktop-only"
              disabled={creatingTemplate() !== undefined}
              data-testid="header-new-workspace"
              onClick={() => void launchTemplate("vite-react")}
            >
              {LANDING_COPY.navCta}
            </button>
            <button
              type="button"
              class="lp-nav-icon lp-phone-only"
              aria-label={nextThemeLabel()}
              title={nextThemeLabel()}
              data-testid="phone-theme-toggle"
              onClick={() => setColorScheme(nextTheme())}
            >
              <Icon name={nextTheme() === "light" ? "sun" : "moon"} />
            </button>
            <button
              type="button"
              class="lp-nav-icon lp-nav-menu"
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
            <a class="lp-nav-link" href={REPO_URL} target="_blank" rel="noreferrer">
              {LANDING_COPY.navGithub}
            </a>
          </nav>
        </Show>
      </header>

      <main id="main">
        <section class="lp-hero" aria-labelledby="hero-title">
          <div class="lp-wrap lp-hero-inner">
            <div class="lp-hero-c">
              <a class="lp-pill" href="#hood">
                <span>{LANDING_COPY.heroPill}</span>
                <span class="lp-muted">{LANDING_COPY.heroPillLink}</span>
              </a>
              <h1 id="hero-title">{LANDING_COPY.heroTitle}</h1>
              <p class="lp-hero-lead">{LANDING_COPY.heroLede}</p>
              <div class="lp-btn-row">
                <button
                  type="button"
                  class="lp-btn lp-btn-primary"
                  disabled={creatingTemplate() !== undefined}
                  data-testid="hero-start-cta"
                  onClick={() => void launchTemplate("vite-react")}
                >
                  {startLabel("vite-react")}
                </button>
                <a class="lp-btn lp-btn-secondary" href="#start">
                  {LANDING_COPY.heroSecondary}
                </a>
              </div>
            </div>
            <div class="lp-hero-frame lp-ground lp-grain" data-enter-media>
              <div class="lp-hero-window lp-hero-tab">
                <WorkbenchPreview demo={demo} pane="terminal" label={LANDING_COPY.showcaseBenchFrame} />
              </div>
            </div>
          </div>
        </section>

        <section class="lp-section" id="features" aria-labelledby="features-title">
          <div class="lp-wrap">
            <div class="lp-section-head">
              <h2 id="features-title">
                <Muted lead={LANDING_COPY.featuresTitle} rest={LANDING_COPY.featuresTitleMuted} />
              </h2>
            </div>
            <FeatureCards />
          </div>
        </section>

        <section class="lp-section" id="start" aria-labelledby="start-title">
          <div class="lp-wrap">
            <div class="lp-section-head">
              <h2 id="start-title">
                <Muted lead={LANDING_COPY.templatesTitle} rest={LANDING_COPY.templatesTitleMuted} />
              </h2>
            </div>
            <div class="lp-start" classList={{ "has-recent": hasRecent() }}>
              <div class="lp-start-form">
                <form class="lp-open" onSubmit={handleGithubSubmit} noValidate>
                  <label class="lp-field-label" for="repo-input">
                    {LANDING_COPY.openLabel}
                  </label>
                  <div class="lp-open-row">
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
                    <button class="lp-btn lp-btn-primary" type="submit" data-testid="repo-submit">
                      {LANDING_COPY.openButton}
                    </button>
                  </div>
                  <Show when={repoError()}>
                    {(message) => (
                      <p id="repo-error" class="lp-field-error" role="alert" data-testid="repo-error">
                        {message()}
                      </p>
                    )}
                  </Show>
                </form>
                <p class="lp-start-note">
                  {LANDING_COPY.templatesNote} {LANDING_COPY.openTry}{" "}
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
                <div class="lp-start-log lp-ground">
                  <WorkspaceSwitcher
                    workspaces={workspaces}
                    loading={loadingWorkspaces()}
                    onOpen={(id) => navigate({ kind: "workspace", id })}
                    onRefresh={() => void refreshWorkspaces()}
                  />
                </div>
              </div>
              <div class="lp-start-list">
                <Show when={createError()}>
                  {(message) => (
                    <p class="lp-create-error" role="alert" data-testid="template-error">
                      {LANDING_COPY.templatesError.replace("{message}", message())}
                    </p>
                  )}
                </Show>
                <ul class="lp-starters" data-testid="template-grid">
                  <For each={TEMPLATES}>{(template) => renderTemplate(template)}</For>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section class="lp-section lp-band" id="browsers" aria-labelledby="browsers-title">
          <div class="lp-wrap">
            <div class="lp-split">
              <div class="lp-split-text">
                <div class="lp-section-head">
                  <h2 id="browsers-title">
                    <Muted lead={LANDING_COPY.showcaseTitle} rest={LANDING_COPY.showcaseTitleMuted} />
                  </h2>
                  <p>{LANDING_COPY.showcaseLede}</p>
                </div>
                <ul class="lp-browsers" aria-label={LANDING_COPY.showcaseBrowsers}>
                  <For each={BROWSERS}>
                    {(item) => (
                      <li>
                        <img src={item.logo} alt="" width="32" height="32" loading="lazy" />
                        {item.name}
                      </li>
                    )}
                  </For>
                </ul>
              </div>
              <div class="lp-phone-frame lp-ground">
                <div class="lp-device">
                  <WorkbenchPreview demo={demo} pane="code" label={LANDING_COPY.showcaseHeroFrame} />
                </div>
              </div>
            </div>
            <div class="lp-marquee" classList={{ "is-paused": marqueePaused() }}>
              <div class="lp-marquee-clip">
                <ul class="lp-marquee-track">
                  <For each={MARQUEE.concat(MARQUEE)}>
                    {(item, index) => (
                      <li aria-hidden={index() >= MARQUEE.length ? "true" : undefined}>{item}</li>
                    )}
                  </For>
                </ul>
              </div>
              <button
                type="button"
                class="lp-loop-pause"
                aria-label={marqueePaused() ? LANDING_COPY.marqueePlay : LANDING_COPY.marqueePause}
                title={marqueePaused() ? LANDING_COPY.marqueePlay : LANDING_COPY.marqueePause}
                onClick={() => setMarqueePaused(!marqueePaused())}
              >
                <Icon name={marqueePaused() ? "play" : "stop"} />
              </button>
            </div>
          </div>
        </section>

        <section class="lp-section" id="hood" aria-labelledby="hood-title">
          <div class="lp-wrap">
            <div class="lp-split">
              <div class="lp-split-text">
                <div class="lp-section-head">
                  <h2 id="hood-title">
                    <Muted lead={LANDING_COPY.hoodTitle} rest={LANDING_COPY.hoodTitleMuted} />
                  </h2>
                </div>
                <p class="lp-hood-lede">{LANDING_COPY.hoodLede}</p>
                <ul class="lp-hood">
                  <For each={STACK}>
                    {(part) => (
                      <li>
                        <a href={engineUrl(part.repo)} target="_blank" rel="noreferrer">
                          <b>{part.name}</b>
                          <span>{part.role}</span>
                        </a>
                      </li>
                    )}
                  </For>
                </ul>
                <p class="lp-hood-limits">{LANDING_COPY.hoodLimits}</p>
              </div>
              <div class="lp-hood-frame lp-ground">
                <HubDiagram />
              </div>
            </div>
          </div>
        </section>

        <section class="lp-section" id="faq" aria-labelledby="faq-title">
          <div class="lp-wrap">
            <div class="lp-split">
              <div class="lp-faq-side">
                <h2 id="faq-title">{LANDING_COPY.faqTitle}</h2>
                <p class="lp-muted lp-faq-intro">{LANDING_COPY.faqIntro}</p>
                <a class="lp-link lp-link-arrow" href={REPO_URL} target="_blank" rel="noreferrer">
                  {LANDING_COPY.faqContact}
                </a>
                <a
                  class="lp-license"
                  href={LICENSE_URL}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={LANDING_COPY.faqLicense}
                >
                  <span class="lp-mini-tabs" aria-hidden="true">
                    <span class="is-on" data-tab-tone="md">
                      LICENSE
                    </span>
                  </span>
                  <ol class="lp-mini-pre lp-mini-text" aria-hidden="true">
                    <For each={LICENSE_LINES}>{(line, index) => <li data-n={index() + 1}>{line}</li>}</For>
                  </ol>
                </a>
              </div>
              <div class="lp-faq">
                <For each={FAQ}>
                  {(item) => (
                    <div class="lp-faq-item">
                      <h3>{item[0]}</h3>
                      <p>{item[1]}</p>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer class="lp-closing" aria-labelledby="close-title">
        <div class="lp-wrap">
          <div class="lp-close-head">
            <div>
              <h2 id="close-title">{LANDING_COPY.closingTitle}</h2>
              <p class="lp-close-lede">{LANDING_COPY.closingLede}</p>
            </div>
            <button
              type="button"
              class="lp-btn lp-btn-primary"
              disabled={creatingTemplate() !== undefined}
              data-testid="closing-start-cta"
              onClick={() => void launchTemplate("vite-react")}
            >
              {startLabel("vite-react")}
            </button>
          </div>
          <p class="lp-close-word" aria-hidden="true">
            Sprockt
          </p>
          <div class="lp-foot">
            <div class="lp-foot-brand">
              <span class="lp-brand">
                <SprocktLogo class="lp-brand-mark" />
                <span>Sprockt</span>
              </span>
              <p>{LANDING_COPY.footerLede}</p>
            </div>
            <nav class="lp-foot-col" aria-labelledby="foot-editor">
              <h3 id="foot-editor">{LANDING_COPY.footerGroupEditor}</h3>
              <a href="#features">{LANDING_COPY.footerTypeChecking}</a>
              <a href="#features">{LANDING_COPY.footerTerminal}</a>
            </nav>
            <nav class="lp-foot-col" aria-labelledby="foot-start">
              <h3 id="foot-start">{LANDING_COPY.footerGroupStart}</h3>
              <a href="#start">{LANDING_COPY.footerImport}</a>
              <button
                type="button"
                disabled={creatingTemplate() !== undefined}
                data-testid="new-workspace"
                onClick={() => void launchTemplate("blank")}
              >
                {creatingTemplate() === "blank" ? LANDING_COPY.templateCreating : LANDING_COPY.altBlank}
              </button>
            </nav>
            <nav class="lp-foot-col" aria-labelledby="foot-browsers">
              <h3 id="foot-browsers">{LANDING_COPY.footerGroupBrowsers}</h3>
              <a href="#browsers">{LANDING_COPY.footerDesktop}</a>
              <a href="#browsers">{LANDING_COPY.footerIphone}</a>
            </nav>
            <nav class="lp-foot-col" aria-labelledby="foot-project">
              <h3 id="foot-project">{LANDING_COPY.footerGroupProject}</h3>
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                {LANDING_COPY.navGithub}
              </a>
              <a href={DOCS_URL} target="_blank" rel="noreferrer">
                {LANDING_COPY.navDocs}
              </a>
              <a href="#hood">{LANDING_COPY.navHood}</a>
            </nav>
          </div>
          <div class="lp-legal">
            <span>
              &copy; 2026 Sprockt ·{" "}
              <a href={LICENSE_URL} target="_blank" rel="noreferrer">
                {LANDING_COPY.footerLicense}
              </a>
            </span>
            <span>{LANDING_COPY.footerTrademarks}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
