/**
 * Runs `work` on demand, one run at a time. A call that comes while a run is under way makes one
 * more run follow it, however many such calls there were: the last run always saw the latest
 * state. A run that fails is reported and does not stop later ones.
 */
export function latestOnly(
  work: () => Promise<unknown>,
  onError: (error: unknown) => void = () => {},
): { run(): void } {
  let running = false;
  let again = false;

  async function loop(): Promise<void> {
    running = true;
    again = false;
    await work().catch(onError);
    running = false;
    if (again) void loop();
  }

  return {
    run() {
      if (running) again = true;
      else void loop();
    },
  };
}
