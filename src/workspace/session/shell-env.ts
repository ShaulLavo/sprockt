import type { ShellSettings } from "../../runtime/boot";

/**
 * The settings every shell of a workspace starts with, with what its preview transport needs a
 * server to know (`PreviewTransport.serverEnv`). The dev server task's shell and the terminals
 * both start from these: a server started by hand has to accept the preview's host names too.
 */
export function withServerEnv(
  shell: ShellSettings,
  serverEnv: Readonly<Record<string, string>>,
): ShellSettings {
  return { ...shell, env: { ...shell.env, ...serverEnv } };
}
