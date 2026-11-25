import { lazy, Match, Suspense, Switch } from "solid-js";
import { Landing } from "../landing/Landing";
import { currentRoute, navigate } from "./router";
import type { Route } from "./routes";

// The workbench pulls in the editor, the terminal and the runtime; the landing page needs none.
const Workbench = lazy(async () => ({ default: (await import("../workbench/Workbench")).Workbench }));
// The importer and share pages write a new workspace, so they load the runtime too.
const ImportPage = lazy(async () => ({ default: (await import("../importer/ImportPage")).ImportPage }));
const SharePage = lazy(async () => ({ default: (await import("../share/SharePage")).SharePage }));

type WorkspaceRoute = Extract<Route, { kind: "workspace" }>;
type GitHubRoute = Extract<Route, { kind: "github" }>;

function workspaceRoute(): WorkspaceRoute | undefined {
  const route = currentRoute();
  return route.kind === "workspace" ? route : undefined;
}

function githubRoute(): GitHubRoute | undefined {
  const route = currentRoute();
  return route.kind === "github" ? route : undefined;
}

export function App() {
  return (
    <Switch
      fallback={
        <main class="landing">
          <h1>Page not found</h1>
          <button type="button" class="primary" onClick={() => navigate({ kind: "landing" })}>
            Back to Sprockt
          </button>
        </main>
      }
    >
      <Match when={currentRoute().kind === "landing"}>
        <Landing />
      </Match>
      <Match when={workspaceRoute()} keyed>
        {(route) => (
          <Suspense>
            <Workbench id={route.id} />
          </Suspense>
        )}
      </Match>
      <Match when={githubRoute()} keyed>
        {(route) => (
          <Suspense>
            <ImportPage route={route} />
          </Suspense>
        )}
      </Match>
      <Match when={currentRoute().kind === "share"}>
        <Suspense>
          <SharePage />
        </Suspense>
      </Match>
    </Switch>
  );
}
