// The sprockt.dev Worker. Static assets answer every path except `/api/*` without running this
// code (`run_worker_first` in wrangler.jsonc); this entry serves the GitHub import routes and
// hands anything else back to the assets. It sets no cookies.
import { createGitHubProxy, GITHUB_PROXY_PREFIX, type GitHubProxyEnv } from "./github-proxy.ts";

/** The static assets binding (`assets.binding` in wrangler.jsonc). */
export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv extends GitHubProxyEnv {
  readonly ASSETS: AssetsBinding;
}

const github = createGitHubProxy();

export async function handleRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith(`${GITHUB_PROXY_PREFIX}/`)) return github(request, env);
  return env.ASSETS.fetch(request);
}

export default { fetch: handleRequest };
