// The Worker behind every preview host, `<id>-<port>-pv.sprockt.dev` (wrangler.preview.jsonc).
// A separate Worker from the IDE's (worker/index.ts): it runs first on every path of a preview
// host, so such a host can never answer with a file of the IDE, and the IDE's own Worker keeps
// serving its assets without running code.
//
// It serves the four fixed files of bun-wasm's preview origins and nothing else: the origin's
// service worker, the relay page the IDE tab frames, a cold-load page and the refusal for a
// tab opened on the host directly. Once a preview's service worker is installed, no request
// of the previewed app reaches this Worker again: they travel through the IDE tab to the
// server inside it. It sets no cookies.
import {
  handlePreviewOriginRequest,
  type PreviewOriginAsset,
  type PreviewOriginHostConfig,
} from "bun-wasm/preview-origins";
import type { AssetsBinding } from "./index.ts";

export interface PreviewHostsEnv {
  /** The four files, as bun-wasm built them (`bun-wasm/preview-origins/assets/`). */
  readonly ASSETS: AssetsBinding;
  /** The domain every preview host ends with: the IDE build's VITE_SPROCKT_PREVIEW_DOMAIN. */
  readonly PREVIEW_DOMAIN: string;
  /** The IDE origins that may frame a preview and connect to its service worker, comma-separated. */
  readonly IDE_ORIGINS: string;
}

const NOT_A_PREVIEW_HOST = {
  status: 404,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
};

/** `a, b` as a list, without empty entries. */
export function listed(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function hostConfig(request: Request, env: PreviewHostsEnv): PreviewOriginHostConfig {
  return {
    domain: env.PREVIEW_DOMAIN,
    ideOrigins: listed(env.IDE_ORIGINS),
    async asset(name: PreviewOriginAsset) {
      const file = await env.ASSETS.fetch(new Request(new URL(`/${name}`, request.url)));
      if (!file.ok) throw new Error(`The preview hosts' file ${name} is missing from the deployed assets`);
      return file.text();
    },
  };
}

export async function handlePreviewHostRequest(request: Request, env: PreviewHostsEnv): Promise<Response> {
  const answer = handlePreviewOriginRequest(request, hostConfig(request, env));
  // Any name without the exact preview shape: never a file, of this Worker's or of the IDE's.
  return answer ?? new Response("Not a preview host.\n", NOT_A_PREVIEW_HOST);
}

export default { fetch: handlePreviewHostRequest };
