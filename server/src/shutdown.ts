type HotRestartShutdownPreparation = {
  skipDrain: boolean;
};

export async function coordinateHeartbeatSchedulerShutdown<
  TPreparation extends HotRestartShutdownPreparation,
>(input: {
  signal: "SIGINT" | "SIGTERM";
  prepareHotRestartShutdown: ((signal: "SIGINT" | "SIGTERM") => Promise<TPreparation>) | null;
  waitForHeartbeatSchedulerIdle: () => Promise<void>;
}): Promise<{
  hotRestart: TPreparation | null;
  preparationError: unknown;
  waitedForSchedulerIdle: boolean;
}> {
  let hotRestart: TPreparation | null = null;
  let preparationError: unknown = null;

  if (input.prepareHotRestartShutdown) {
    try {
      hotRestart = await input.prepareHotRestartShutdown(input.signal);
    } catch (err) {
      preparationError = err;
    }
  }

  if (hotRestart?.skipDrain) {
    return {
      hotRestart,
      preparationError,
      waitedForSchedulerIdle: false,
    };
  }

  await input.waitForHeartbeatSchedulerIdle();
  return {
    hotRestart,
    preparationError,
    waitedForSchedulerIdle: true,
  };
}

// The graceful run drain interrupts adapter processes, but each interrupted
// run's execution promise still finishes its finalization asynchronously —
// late run-row writes and buffered skill-usage events land there. Await those
// finalizers before the caller exits the process, bounded so a wedged
// finalizer (or a run that finished normally mid-shutdown and chain-dispatched
// fresh work) cannot hold up process exit.
export async function drainRunExecutionFinalizersForShutdown(input: {
  drainActiveRunExecutions: (() => Promise<void>) | null;
  timeoutMs: number;
}): Promise<{ attempted: boolean; timedOut: boolean; error: unknown }> {
  if (!input.drainActiveRunExecutions) {
    return { attempted: false, timedOut: false, error: null };
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const outcome = await Promise.race([
      input.drainActiveRunExecutions().then(() => "drained" as const),
      new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), input.timeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);
    return { attempted: true, timedOut: outcome === "timeout", error: null };
  } catch (err) {
    return { attempted: true, timedOut: false, error: err };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
