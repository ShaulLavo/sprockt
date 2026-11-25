import { lazy, Match, Suspense, Switch } from "solid-js";
import { Landing } from "../landing/Landing";
import { currentRoute, navigate } from "./router";
import type { Route } from "./routes";

// The workbench pulls in the editor, the terminal and the runtime; the landing page needs none.
const Workbench = lazy(async () => ({ default: (await import("../workbench/Workbench")).Workbench }));

type WorkspaceRoute = Extract<Route, { kind: "workspace" }>;

function workspaceRoute(): WorkspaceRoute | undefined {
  const route = currentRoute();
  return route.kind === "workspace" ? route : undefined;
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
    </Switch>
  );
}
