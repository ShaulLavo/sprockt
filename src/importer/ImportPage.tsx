import { createSignal, Match, onCleanup, onMount, Switch } from "solid-js";
import { navigate } from "../app/router";
import type { Route } from "../app/routes";
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
  const id = await createWorkspaceWithFiles(
    fileRecord(result.files),
    {
      name: result.subdir ? `${result.repo}/${result.subdir}` : result.repo,
      created: new Date().toISOString(),
      source: {
        kind: "github",
        owner: result.owner,
        repo: result.repo,
        ref: result.ref,
        subdir: result.subdir,
        ...(result.commit ? { commit: result.commit } : {}),
      },
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
  onState({ stage: "opening" });
  openUnlessCancelled(id, signal);
}

/** `/github/<owner>/<repo>[/tree/<ref>[/<subdir>]]`: imports into a new workspace, then opens it. */
export function ImportPage(props: { route: GitHubRoute }) {
  const [state, setState] = createSignal<ImportState>({ stage: "resolving" });
  let controller: AbortController | undefined;

  function start(): void {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setState({ stage: "resolving" });
    runImport(props.route, current.signal, setState).catch((error: unknown) => {
      if (!current.signal.aborted) setState({ stage: "failed", message: importErrorMessage(error) });
    });
  }

  onMount(start);
  onCleanup(() => controller?.abort());

  const name = () => `${props.route.owner}/${props.route.repo}`;

  return (
    <main class="importer" data-testid="import-page" data-stage={state().stage}>
      <section class="importer-card" aria-live="polite">
        <h1 class="importer-title">{fill(COPY.importer.importing, { name: name() })}</h1>
        <Switch>
          <Match when={state().stage !== "failed"}>
            <p class="importer-stage" data-testid="import-stage">
              {stageText(state())}
            </p>
            <div class="importer-progress" role="progressbar" aria-label={stageText(state())} />
          </Match>
          <Match when={state().stage === "failed"}>
            <p class="importer-error" role="alert" data-testid="import-error">
              {stageText(state())}
            </p>
            <div class="importer-actions">
              <button type="button" class="importer-button primary" onClick={start}>
                {COPY.importer.tryAgain}
              </button>
              <button type="button" class="importer-button" onClick={() => navigate({ kind: "landing" })}>
                {COPY.importer.backHome}
              </button>
            </div>
          </Match>
        </Switch>
      </section>
    </main>
  );
}
