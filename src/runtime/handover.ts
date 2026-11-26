/**
 * Runs a boot. While it runs, closing (`signal`) disposes what it is building, which also cancels
 * a storage request still queued behind another tab, and the boot fails. Once the boot returns,
 * closing no longer disposes anything: the owner the result is handed to (the session) disposes
 * it, after what depends on its storage (a pending preview identity claim) has settled.
 */
export async function bootUntilHandedOver<T>(
  signal: AbortSignal | undefined,
  dispose: () => Promise<void>,
  boot: () => Promise<T>,
): Promise<T> {
  const onAbort = () => void dispose().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const result = await boot();
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
