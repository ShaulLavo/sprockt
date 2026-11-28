// The landing page, a faithful port of the #4 "Sheet and Biro" design (set-a/dir-1) with #2
// "Precision Sheet"'s 4-card painterly landscapes and Sprockt gear logo: dead-centered header nav,
// living WebGL grain-gradient hero backdrop with cropped stately IDE showcase, 2x2 feature cards,
// starters and GitHub import, dark browsers band with iPhone showcase, animated Waffle hub diagram,
// questions with LICENSE tab card, and giant wordmark footer. Loads zero editor, terminal or
// Waffle runtime code on initial render.
import jetbrainsMonoLatinUrl from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import schibstedLatinUrl from "@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2?url";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { navigate } from "../app/router";
import { routePath, type Route } from "../app/routes";
import { useValue } from "../lib/react";
import {
  BLANK_TEMPLATE_SUMMARY,
  STARTER_TEMPLATE_SUMMARIES,
  type TemplateId,
  type TemplateSummary,
} from "../templates/metadata";
import { SprocktLogo } from "../ui/SprocktLogo";
import { applyStoredTheme, colorScheme, setColorScheme } from "../workbench/theme";
import { LANDING_COPY } from "./copy";
import { mountGrainGradient, type GrainGradientController } from "./effects/grain-gradient";
import { FeatureCards } from "./FeatureCards";
import { parseGithubInput } from "./github-input";
import { HeroShowcase } from "./HeroShowcase";
import { HubDiagram } from "./HubDiagram";
import { Icon } from "./icons";
import { BrandLogoTile, LOGOS } from "./logos";
import { PhoneShowcase } from "./PhoneShowcase";
import {
  hasWorkspaceHints,
  listStoredWorkspaces,
  saveWorkspaceHint,
  type StoredWorkspaceSummary,
} from "./workspaces";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import "./landing.css";
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

/** The marquee runs two copies end to end; the second is hidden from assistive tech. */
const MARQUEE_LOOP: readonly string[] = (MARQUEE as readonly string[]).concat(MARQUEE);

const STACK = [
  { name: "Waffle", repo: "waffle", role: LANDING_COPY.hoodRoleWaffle },
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

function Muted(props: { readonly lead: string; readonly rest: string }) {
  return (
    <>
      {props.lead} <span className="lp-muted">{props.rest}</span>
    </>
  );
}

export function Landing() {
  const scheme = useValue(colorScheme);
  const [repoInput, setRepoInput] = useState("");
  const [repoError, setRepoError] = useState<string | undefined>();
  const [creatingTemplate, setCreatingTemplate] = useState<TemplateId | undefined>();
  const [createError, setCreateError] = useState<string | undefined>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [marqueePaused, setMarqueePaused] = useState(false);
  const [heroFxPaused, setHeroFxPaused] = useState(false);
  const [heroFxStill, setHeroFxStill] = useState(false);
  const [heroFxAnimated, setHeroFxAnimated] = useState(false);

  const heroBackdropRef = useRef<HTMLDivElement>(null);
  const heroFxRef = useRef<GrainGradientController | null>(null);

  const [workspaces, setWorkspaces] = useState<readonly StoredWorkspaceSummary[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  // Known before storage answers, so a returning visitor's page does not jump once it does.
  const [expectsWorkspaces] = useState(hasWorkspaceHints);
  const refreshSequence = useRef(0);
  // A synchronous guard: two clicks in one frame must not both start a template.
  const launching = useRef(false);

  async function refreshWorkspaces(): Promise<void> {
    const seq = ++refreshSequence.current;
    try {
      const next = await listStoredWorkspaces();
      if (seq !== refreshSequence.current) return;
      setWorkspaces(next);
    } finally {
      if (seq === refreshSequence.current) setLoadingWorkspaces(false);
    }
  }

  const hasRecent = workspaces.length > 0 || (loadingWorkspaces && expectsWorkspaces);
  const nextTheme = scheme === "dark" ? "light" : "dark";
  const nextThemeLabel = nextTheme === "light" ? LANDING_COPY.navThemeLight : LANDING_COPY.navThemeDark;

  useEffect(() => {
    applyStoredTheme();
  }, []);

  useEffect(() => {
    const reducedMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
    const phoneMQ = window.matchMedia("(max-width: 639px)");
    const update = () => setHeroFxStill(reducedMQ.matches || phoneMQ.matches);
    update();
    reducedMQ.addEventListener("change", update);
    phoneMQ.addEventListener("change", update);
    return () => {
      reducedMQ.removeEventListener("change", update);
      phoneMQ.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    const host = heroBackdropRef.current;
    if (!host) return;
    const ctrl = mountGrainGradient(host, {
      scheme: colorScheme(),
      seed: 11,
      onAnimatedChange: setHeroFxAnimated,
    });
    heroFxRef.current = ctrl;
    setHeroFxAnimated(ctrl.isAnimated());
    return () => {
      ctrl.destroy();
      heroFxRef.current = null;
      setHeroFxAnimated(false);
    };
  }, []);

  useEffect(() => {
    heroFxRef.current?.setScheme(scheme);
  }, [scheme]);

  useEffect(() => {
    const ctrl = heroFxRef.current;
    if (!ctrl) return;
    if (heroFxPaused) ctrl.pause();
    else ctrl.resume();
  }, [heroFxPaused]);

  useEffect(() => {
    function refreshOnVisible(): void {
      if (document.visibilityState === "visible") void refreshWorkspaces();
    }
    function closeMenuOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") setMenuOpen(false);
    }
    void refreshWorkspaces();
    document.addEventListener("visibilitychange", refreshOnVisible);
    window.addEventListener("focus", refreshOnVisible);
    window.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      document.removeEventListener("visibilitychange", refreshOnVisible);
      window.removeEventListener("focus", refreshOnVisible);
      window.removeEventListener("keydown", closeMenuOnEscape);
    };
    // Mount only: refreshWorkspaces reads nothing but refs and state setters.
  }, []);

  function handleGithubSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = parseGithubInput(repoInput);
    if (!parsed) {
      setRepoError(LANDING_COPY.openError);
      return;
    }
    setRepoError(undefined);
    navigate(parsed);
  }

  async function launchTemplate(templateId: TemplateId): Promise<void> {
    if (launching.current) return;
    launching.current = true;
    setCreatingTemplate(templateId);
    setCreateError(undefined);
    try {
      const { seedWorkspace } = await import("../templates/seed");
      const { id, meta } = await seedWorkspace(templateId);
      saveWorkspaceHint(id, meta);
      navigate({ kind: "workspace", id });
    } catch (error) {
      launching.current = false;
      setCreatingTemplate(undefined);
      setCreateError(error instanceof Error ? error.message : String(error));
      void refreshWorkspaces().catch(() => undefined);
    }
  }

  const creating = creatingTemplate !== undefined;
  const startLabel = (id: TemplateId) =>
    creatingTemplate === id ? LANDING_COPY.templateCreating : LANDING_COPY.heroCta;

  function renderTemplate(template: TemplateSummary) {
    return (
      <li key={template.id}>
        <button
          type="button"
          className="lp-starter"
          disabled={creating}
          aria-busy={creatingTemplate === template.id ? "true" : undefined}
          data-testid={`template-${template.id}`}
          onClick={() => void launchTemplate(template.id)}
        >
          <BrandLogoTile templateId={template.id} />
          <span className="lp-starter-name">{template.label}</span>
          <span className="lp-starter-line">
            {creatingTemplate === template.id ? LANDING_COPY.templateCreating : template.description}
          </span>
          <Icon name="chev-r" class="lp-starter-go" />
        </button>
      </li>
    );
  }

  const closeMenu = () => setMenuOpen(false);
  const navLinks = (
    <>
      <a className="lp-nav-link" href="#features" onClick={closeMenu}>
        {LANDING_COPY.navEditor}
      </a>
      <a className="lp-nav-link" href="#start" onClick={closeMenu}>
        {LANDING_COPY.navTemplates}
      </a>
      <a className="lp-nav-link" href="#browsers" onClick={closeMenu}>
        {LANDING_COPY.navBrowsers}
      </a>
      <a className="lp-nav-link" href="#hood" onClick={closeMenu}>
        {LANDING_COPY.navHood}
      </a>
      <a className="lp-nav-link" href="#faq" onClick={closeMenu}>
        {LANDING_COPY.navQuestions}
      </a>
    </>
  );

  return (
    <div className="landing-page" data-testid="landing-page">
      <a className="lp-skip" href="#main">
        {LANDING_COPY.skip}
      </a>
      <header className={menuOpen ? "nav lp-nav is-open" : "nav lp-nav"}>
        <div className="wrap lp-wrap lp-nav-bar">
          <a
            className="lp-brand"
            href={routePath({ kind: "landing" })}
            onClick={(event) => {
              event.preventDefault();
              navigate({ kind: "landing" });
            }}
          >
            <SprocktLogo class="lp-brand-mark" />
            <span>Sprockt</span>
          </a>
          <nav className="lp-nav-links" aria-label="Site" data-testid="desktop-nav">
            {navLinks}
          </nav>
          <div className="lp-nav-actions">
            <a
              className="lp-nav-icon lp-desktop-only"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              aria-label={LANDING_COPY.navGithub}
              title={LANDING_COPY.navGithub}
            >
              <Icon name="github" />
            </a>
            <div className="lp-theme-switch lp-desktop-only" role="group" aria-label="Theme">
              <button
                type="button"
                title={LANDING_COPY.navThemeLight}
                aria-label={LANDING_COPY.navThemeLight}
                aria-pressed={scheme === "light"}
                data-testid="theme-light"
                onClick={() => setColorScheme("light")}
              >
                <Icon name="sun" />
              </button>
              <button
                type="button"
                title={LANDING_COPY.navThemeDark}
                aria-label={LANDING_COPY.navThemeDark}
                aria-pressed={scheme === "dark"}
                data-testid="theme-dark"
                onClick={() => setColorScheme("dark")}
              >
                <Icon name="moon" />
              </button>
            </div>
            <button
              type="button"
              className="lp-btn lp-btn-primary lp-desktop-only"
              disabled={creating}
              data-testid="header-new-workspace"
              onClick={() => void launchTemplate("vite-react")}
            >
              {LANDING_COPY.navCta}
            </button>
            <button
              type="button"
              className="lp-nav-icon lp-phone-only"
              aria-label={nextThemeLabel}
              title={nextThemeLabel}
              data-testid="phone-theme-toggle"
              onClick={() => setColorScheme(nextTheme)}
            >
              <Icon name={nextTheme === "light" ? "sun" : "moon"} />
            </button>
            <button
              type="button"
              className="lp-nav-icon lp-nav-menu"
              aria-label={LANDING_COPY.navMenu}
              aria-expanded={menuOpen}
              aria-controls="lp-menu"
              data-testid="phone-menu-toggle"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Icon name={menuOpen ? "x" : "menu"} />
            </button>
          </div>
        </div>
        {menuOpen ? (
          <nav className="lp-menu" id="lp-menu" aria-label="Site" data-testid="phone-menu">
            {navLinks}
            <a className="lp-nav-link" href={REPO_URL} target="_blank" rel="noreferrer">
              {LANDING_COPY.navGithub}
            </a>
          </nav>
        ) : null}
      </header>

      <main id="main">
        <section className="lp-hero" aria-labelledby="hero-title">
          <div className="wrap lp-wrap lp-hero-inner">
            <div className="lp-hero-c">
              <a className="lp-pill" href="#hood">
                <span>{LANDING_COPY.heroPill}</span>
                <span className="lp-muted">{LANDING_COPY.heroPillLink}</span>
              </a>
              <h1 id="hero-title">{LANDING_COPY.heroTitle}</h1>
              <p className="lp-hero-lead">{LANDING_COPY.heroLede}</p>
              <div className="lp-btn-row">
                <button
                  type="button"
                  className="lp-btn lp-btn-primary"
                  disabled={creating}
                  data-testid="hero-start-cta"
                  onClick={() => void launchTemplate("vite-react")}
                >
                  {startLabel("vite-react")}
                </button>
                <a className="lp-btn lp-btn-secondary" href="#start">
                  {LANDING_COPY.heroSecondary}
                </a>
              </div>
            </div>
            <div className="lp-hero-frame" data-enter-media>
              <div className="lp-hero-stage">
                <div ref={heroBackdropRef} className="lp-hero-backdrop lp-ground" aria-hidden="true" />
                <div className="lp-hero-window">
                  <HeroShowcase />
                </div>
              </div>
              {!heroFxStill && heroFxAnimated ? (
                <button
                  type="button"
                  className={heroFxPaused ? "lp-fx-pause is-paused" : "lp-fx-pause"}
                  aria-pressed={heroFxPaused}
                  aria-label={heroFxPaused ? LANDING_COPY.heroFxPlay : LANDING_COPY.heroFxPause}
                  title={heroFxPaused ? LANDING_COPY.heroFxPlay : LANDING_COPY.heroFxPause}
                  data-testid="hero-fx-pause"
                  onClick={() => setHeroFxPaused((p) => !p)}
                >
                  <svg viewBox="0 0 14 14" aria-hidden="true">
                    {heroFxPaused ? (
                      <path d="M4 2.5v9l7.5-4.5z" />
                    ) : (
                      <path d="M3.5 2.5h2.5v9H3.5zM8 2.5h2.5v9H8z" />
                    )}
                  </svg>
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <section className="lp-section" id="features" aria-labelledby="features-title">
          <div className="wrap lp-wrap">
            <div className="lp-section-head">
              <h2 id="features-title">
                <Muted lead={LANDING_COPY.featuresTitle} rest={LANDING_COPY.featuresTitleMuted} />
              </h2>
            </div>
            <FeatureCards />
          </div>
        </section>

        <section className="lp-section" id="start" aria-labelledby="start-title">
          <div className="wrap lp-wrap">
            <div className="lp-section-head">
              <h2 id="start-title">
                <Muted lead={LANDING_COPY.templatesTitle} rest={LANDING_COPY.templatesTitleMuted} />
              </h2>
            </div>
            <div className={hasRecent ? "lp-start has-recent" : "lp-start"}>
              <div className="lp-start-form">
                <form className="lp-open" onSubmit={handleGithubSubmit} noValidate>
                  <label className="lp-field-label" htmlFor="repo-input">
                    {LANDING_COPY.openLabel}
                  </label>
                  <div className="lp-open-row">
                    <input
                      id="repo-input"
                      type="text"
                      placeholder={LANDING_COPY.openPlaceholder}
                      autoComplete="off"
                      spellCheck={false}
                      autoCapitalize="off"
                      value={repoInput}
                      aria-invalid={repoError ? "true" : undefined}
                      aria-describedby={repoError ? "repo-error" : undefined}
                      data-testid="repo-input"
                      onChange={(event) => {
                        setRepoInput(event.currentTarget.value);
                        if (repoError) setRepoError(undefined);
                      }}
                    />
                    <button className="lp-btn lp-btn-primary" type="submit" data-testid="repo-submit">
                      {LANDING_COPY.openButton}
                    </button>
                  </div>
                  {repoError ? (
                    <p id="repo-error" className="lp-field-error" role="alert" data-testid="repo-error">
                      {repoError}
                    </p>
                  ) : null}
                </form>
                <p className="lp-start-note">
                  {LANDING_COPY.templatesNote} {LANDING_COPY.openTry}{" "}
                  <a
                    className="lp-link"
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
                <div className="lp-start-log">
                  <WorkspaceSwitcher
                    workspaces={workspaces}
                    loading={loadingWorkspaces}
                    onOpen={(id) => navigate({ kind: "workspace", id })}
                    onRefresh={() => void refreshWorkspaces()}
                  />
                </div>
              </div>
              <div className="lp-start-list">
                {createError ? (
                  <p className="lp-create-error" role="alert" data-testid="template-error">
                    {LANDING_COPY.templatesError.replace("{message}", createError)}
                  </p>
                ) : null}
                <ul className="lp-starters" data-testid="template-grid">
                  {TEMPLATES.map(renderTemplate)}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-section lp-band" id="browsers" aria-labelledby="browsers-title">
          <div className="wrap lp-wrap">
            <div className="lp-split">
              <div className="lp-split-text">
                <div className="lp-section-head">
                  <h2 id="browsers-title">
                    <Muted lead={LANDING_COPY.showcaseTitle} rest={LANDING_COPY.showcaseTitleMuted} />
                  </h2>
                  <p>{LANDING_COPY.showcaseLede}</p>
                </div>
                <ul className="lp-browsers" aria-label={LANDING_COPY.showcaseBrowsers}>
                  {BROWSERS.map((item) => (
                    <li key={item.name}>
                      <img src={item.logo} alt="" width="32" height="32" />
                      {item.name}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="lp-phone-frame">
                <PhoneShowcase />
              </div>
            </div>
            <div className={marqueePaused ? "lp-marquee is-paused" : "lp-marquee"}>
              <div className="lp-marquee-clip">
                <ul className="lp-marquee-track">
                  {MARQUEE_LOOP.map((item, index) => (
                    <li key={index} aria-hidden={index >= MARQUEE.length ? "true" : undefined}>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <button
                type="button"
                className="lp-loop-pause"
                aria-pressed={marqueePaused}
                aria-label={marqueePaused ? LANDING_COPY.marqueePlay : LANDING_COPY.marqueePause}
                title={marqueePaused ? LANDING_COPY.marqueePlay : LANDING_COPY.marqueePause}
                onClick={() => setMarqueePaused(!marqueePaused)}
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  {marqueePaused ? <path d="M4 2.8v6.4L9.2 6z" /> : <path d="M4 3v6M8 3v6" />}
                </svg>
              </button>
            </div>
          </div>
        </section>

        <section className="lp-section" id="hood" aria-labelledby="hood-title">
          <div className="wrap lp-wrap">
            <div className="lp-split">
              <div className="lp-split-text">
                <div className="lp-section-head">
                  <h2 id="hood-title">
                    <Muted lead={LANDING_COPY.hoodTitle} rest={LANDING_COPY.hoodTitleMuted} />
                  </h2>
                </div>
                <p className="lp-hood-lede">{LANDING_COPY.hoodLede}</p>
                <ul className="lp-hood">
                  {STACK.map((part) => (
                    <li key={part.repo}>
                      <a href={engineUrl(part.repo)} target="_blank" rel="noreferrer">
                        <b>{part.name}</b>
                        <span>{part.role}</span>
                      </a>
                    </li>
                  ))}
                </ul>
                <p className="lp-hood-limits">{LANDING_COPY.hoodLimits}</p>
              </div>
              <div className="lp-hood-frame lp-plate">
                <HubDiagram scheme={scheme} />
              </div>
            </div>
          </div>
        </section>

        <section className="lp-section" id="faq" aria-labelledby="faq-title">
          <div className="wrap lp-wrap">
            <div className="lp-split">
              <div className="lp-faq-side">
                <h2 id="faq-title">{LANDING_COPY.faqTitle}</h2>
                <p className="lp-muted lp-faq-intro">{LANDING_COPY.faqIntro}</p>
                <a className="lp-link lp-link-arrow" href={REPO_URL} target="_blank" rel="noreferrer">
                  {LANDING_COPY.faqContact}
                </a>
                <a
                  className="lp-license"
                  href={LICENSE_URL}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={LANDING_COPY.faqLicense}
                >
                  <span className="lp-mini-tabs" aria-hidden="true">
                    <span className="is-on" data-tab-tone="md">
                      <i className="lp-mini-badge lp-mini-badge-md">MD</i>
                      LICENSE
                    </span>
                  </span>
                  <ol className="lp-mini-pre lp-mini-text" aria-hidden="true">
                    {LICENSE_LINES.map((line, index) => (
                      <li key={index} data-n={index + 1}>
                        {line}
                      </li>
                    ))}
                  </ol>
                </a>
              </div>
              <div className="lp-faq">
                {FAQ.map((item) => (
                  <div key={item[0]} className="lp-faq-item">
                    <h3>{item[0]}</h3>
                    <p>{item[1]}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="closing lp-closing" aria-labelledby="close-title">
        <div className="wrap lp-wrap">
          <div className="lp-close-head">
            <div>
              <h2 id="close-title">{LANDING_COPY.closingTitle}</h2>
              <p className="lp-close-lede">{LANDING_COPY.closingLede}</p>
            </div>
            <button
              type="button"
              className="lp-btn lp-btn-primary"
              disabled={creating}
              data-testid="closing-start-cta"
              onClick={() => void launchTemplate("vite-react")}
            >
              {startLabel("vite-react")}
            </button>
          </div>
          <p className="lp-close-word" aria-hidden="true">
            Sprockt
          </p>
          <div className="lp-foot">
            <div className="lp-foot-brand">
              <span className="lp-brand">
                <SprocktLogo class="lp-brand-mark" />
                <span>Sprockt</span>
              </span>
              <p>{LANDING_COPY.footerLede}</p>
            </div>
            <nav className="lp-foot-col" aria-labelledby="foot-editor">
              <h3 id="foot-editor">{LANDING_COPY.footerGroupEditor}</h3>
              <a href="#features">{LANDING_COPY.footerTypeChecking}</a>
              <a href="#features">{LANDING_COPY.footerTerminal}</a>
            </nav>
            <nav className="lp-foot-col" aria-labelledby="foot-start">
              <h3 id="foot-start">{LANDING_COPY.footerGroupStart}</h3>
              <a href="#start">{LANDING_COPY.footerImport}</a>
              <button
                type="button"
                disabled={creating}
                data-testid="new-workspace"
                onClick={() => void launchTemplate("blank")}
              >
                {creatingTemplate === "blank" ? LANDING_COPY.templateCreating : LANDING_COPY.altBlank}
              </button>
            </nav>
            <nav className="lp-foot-col" aria-labelledby="foot-browsers">
              <h3 id="foot-browsers">{LANDING_COPY.footerGroupBrowsers}</h3>
              <a href="#browsers">{LANDING_COPY.footerDesktop}</a>
              <a href="#browsers">{LANDING_COPY.footerIphone}</a>
            </nav>
            <nav className="lp-foot-col" aria-labelledby="foot-project">
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
          <div className="lp-legal">
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
