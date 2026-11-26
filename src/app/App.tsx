import { lazy, Suspense } from "react";
import { Landing } from "../landing/Landing";
import { useValue } from "../lib/react";
import { currentRoute, navigate } from "./router";
import { routePath, type Route } from "./routes";

// The workbench pulls in the editor, the terminal and the runtime; the landing page needs none.
const Workbench = lazy(async () => ({ default: (await import("../workbench/Workbench")).Workbench }));
// The importer and share pages write a new workspace, so they load the runtime too.
const ImportPage = lazy(async () => ({ default: (await import("../importer/ImportPage")).ImportPage }));
const SharePage = lazy(async () => ({ default: (await import("../share/SharePage")).SharePage }));

function NotFound() {
  return (
    <main className="landing">
      <h1>Page not found</h1>
      <button type="button" className="primary" onClick={() => navigate({ kind: "landing" })}>
        Back to Sprockt
      </button>
    </main>
  );
}

/**
 * The page for a route. A workspace is keyed by its id and an import by its path, so moving to
 * another one unmounts the page (closing its workspace) and mounts a fresh one.
 */
function page(route: Route) {
  switch (route.kind) {
    case "landing":
      return <Landing />;
    case "workspace":
      return <Workbench key={route.id} id={route.id} />;
    case "github":
      return <ImportPage key={routePath(route)} route={route} />;
    case "share":
      return <SharePage />;
    default:
      return <NotFound />;
  }
}

export function App() {
  const route = useValue(currentRoute);
  // Only the lazily loaded pages wait for their code.
  if (route.kind === "landing" || route.kind === "not-found") return page(route);
  return <Suspense>{page(route)}</Suspense>;
}
