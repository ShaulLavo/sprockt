import { useEffect, useRef, useState } from "react";
import { navigate } from "../app/router";
import type { Route } from "../app/routes";
import { deriveGitHubWorkspaceName } from "../templates/workspace-meta";
import { saveWorkspaceHint } from "../workspace/hint";
import { browserWorkspaceDeps, openUnlessCancelled, retryTarget } from "./browser-deps";
import { COPY, fill } from "./copy";
import { importGitHubRepo, type ImportProgress } from "./github/import";
import { formatSize, importErrorMessage } from "./messages";
import { createWorkspaceWithFiles } from "./new-workspace";
import { detectFromEntries, fileRecord, planFrom, sourceFromRoute } from "./plan";
import "./importer.css";

type GitHubRoute = Extract<Route, { kind: "github" }>;

type ImportState =
  | ImportProgress
  | { readonly stage: "writing"; readonly files: number }
  | { readonly stage: "opening" }
  | { readonly stage: "failed"; readonly message: string };

function stageText(state: ImportState): string {
  if (state.stage === "resolving") return COPY.importer.resolving;
  if (state.stage === "downloading") {
    return fill(COPY.importer.downloading, { size: formatSize(state.bytes) });
  }
  if (state.stage === "writing") {
    return state.files === 1 ? COPY.importer.writingOne : fill(COPY.importer.writing, { count: state.files });
  }
  if (state.stage === "opening") return COPY.importer.opening;
  return state.message;
}

async function runImport(
  route: GitHubRoute,
  signal: AbortSignal,
  onState: (state: ImportState) => void,
): Promise<void> {
  const result = await importGitHubRepo(sourceFromRoute(route), { signal, onProgress: onState });
  signal.throwIfAborted();
  onState({ stage: "writing", files: result.files.length });
  const detection = detectFromEntries(result.files);
  const plan = planFrom(detection);
  const name = deriveGitHubWorkspaceName(result.repo, result.subdir);
  const created = new Date().toISOString();
  const source = {
    kind: "github" as const,
    owner: result.owner,
    repo: result.repo,
    ref: result.ref,
    subdir: result.subdir,
    ...(result.commit ? { commit: result.commit } : {}),
  };
  const id = await createWorkspaceWithFiles(
    fileRecord(result.files),
    {
      name,
      template: "github",
      created,
      lastOpened: created,
      source,
      detected: {
        framework: detection.framework,
        packageManager: detection.packageManager,
        devScript: detection.devScript,
        port: detection.port,
      },
      ...(plan.install || plan.dev ? { pendingImport: plan } : {}),
    },
    browserWorkspaceDeps,
    { signal, into: retryTarget(location.search) },
  );
  saveWorkspaceHint(id, { name, template: "github", created, lastOpened: created, source });
  onState({ stage: "opening" });
  openUnlessCancelled(id, signal);
}

/** `/github/<owner>/<repo>[/tree/<ref>[/<subdir>]]`: imports into a new workspace, then opens it. */
export function ImportPage(props: { route: GitHubRoute }) {
  const [state, setState] = useState<ImportState>({ stage: "resolving" });
  /** The attempt under way: Try again aborts it, and so does leaving the page. */
  const controller = useRef<AbortController>(undefined);

  function start(): void {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ stage: "resolving" });
    runImport(props.route, current.signal, setState).catch((error: unknown) => {
      if (!current.signal.aborted) setState({ stage: "failed", message: importErrorMessage(error) });
    });
  }

  // One import per mount, for the route it mounted with: an attempt that is still under way is
  // never started a second time.
  useEffect(() => {
    if (!controller.current || controller.current.signal.aborted) start();
    return () => controller.current?.abort();
  }, []);

  const name = `${props.route.owner}/${props.route.repo}`;
  const text = stageText(state);

  return (
    <main className="importer" data-testid="import-page" data-stage={state.stage}>
      <section className="importer-card" aria-live="polite">
        <h1 className="importer-title">{fill(COPY.importer.importing, { name })}</h1>
        {state.stage === "failed" ? (
          <>
            <p className="importer-error" role="alert" data-testid="import-error">
              {text}
            </p>
            <div className="importer-actions">
              <button type="button" className="importer-button primary" onClick={start}>
                {COPY.importer.tryAgain}
              </button>
              <button type="button" className="importer-button" onClick={() => navigate({ kind: "landing" })}>
                {COPY.importer.backHome}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="importer-stage" data-testid="import-stage">
              {text}
            </p>
            <div className="importer-progress" role="progressbar" aria-label={text} />
          </>
        )}
      </section>
    </main>
  );
}
