export function readCliArgument(arguments_, name) {
  const index = arguments_.indexOf(name);
  if (index < 0 || index + 1 >= arguments_.length) return "";
  const value = arguments_[index + 1];
  return typeof value === "string" && !value.startsWith("--") ? value : "";
}

export function closeLineInput(reader, input) {
  reader?.close();
  input?.pause?.();
  input?.unref?.();
}

export function terminateChildProcess(child, signal = "SIGTERM", killProcessGroup = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  try {
    if (killProcessGroup && process.platform !== "win32" && Number.isSafeInteger(child.pid)) {
      process.kill(-child.pid, signal);
      return true;
    }
    return child.kill(signal);
  } catch {
    try { return child.kill(signal); } catch { return false; }
  }
}

export function forwardTerminationSignals(child, killProcessGroup = false) {
  const handlers = new Map();
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const handler = () => terminateChildProcess(child, signal, killProcessGroup);
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

export function closeChildPipesAfterExit(child, graceMs = 500) {
  if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 5_000) {
    throw new Error("Child pipe drain grace is invalid");
  }
  let timer = null;
  const closePipes = () => {
    timer = setTimeout(() => {
      child.stdin?.destroy?.();
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
    }, graceMs);
    timer.unref?.();
  };
  child.once("exit", closePipes);
  return () => {
    child.off("exit", closePipes);
    if (timer) clearTimeout(timer);
  };
}

export async function settleChildAfterProtocolResult(child, childClosed, options = {}) {
  const graceMs = Number(options.graceMs ?? 500);
  const killProcessGroup = options.killProcessGroup === true;
  if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 5_000) {
    throw new Error("Child protocol-result grace is invalid");
  }
  const waitForClose = async () => Promise.race([
    childClosed.then(result => ({ closed: true, result })),
    new Promise(resolvePromise => {
      const timer = setTimeout(() => resolvePromise({ closed: false, result: null }), graceMs);
      timer.unref?.();
    }),
  ]);
  child.stdin?.end?.();
  const natural = await waitForClose();
  if (natural.closed) return Object.freeze({ result: natural.result, transportTerminated: false });
  terminateChildProcess(child, "SIGTERM", killProcessGroup);
  const terminated = await waitForClose();
  if (terminated.closed) return Object.freeze({ result: terminated.result, transportTerminated: true });
  terminateChildProcess(child, "SIGKILL", killProcessGroup);
  return Object.freeze({ result: await childClosed, transportTerminated: true });
}

export function startChildProtocolWatchdog(child, options) {
  const idleMs = Number(options?.idleMs);
  const checkMs = Number(options?.checkMs ?? Math.min(1_000, idleMs));
  const terminateGraceMs = Number(options?.terminateGraceMs ?? 2_000);
  const killProcessGroup = options?.killProcessGroup === true;
  if (!Number.isSafeInteger(idleMs) || idleMs < 25 || idleMs > 300_000
    || !Number.isSafeInteger(checkMs) || checkMs < 10 || checkMs > idleMs
    || !Number.isSafeInteger(terminateGraceMs) || terminateGraceMs < 1 || terminateGraceMs > 10_000) {
    throw new Error("Child protocol watchdog configuration is invalid");
  }
  let lastActivityAt = Date.now();
  let expired = false;
  let forceTimer = null;
  const interval = setInterval(() => {
    if (expired || Date.now() - lastActivityAt < idleMs) return;
    expired = true;
    terminateChildProcess(child, "SIGTERM", killProcessGroup);
    forceTimer = setTimeout(() => terminateChildProcess(child, "SIGKILL", killProcessGroup), terminateGraceMs);
    forceTimer.unref?.();
  }, checkMs);
  interval.unref?.();
  return Object.freeze({
    touch() { if (!expired) lastActivityAt = Date.now(); },
    expired() { return expired; },
    stop() {
      clearInterval(interval);
      if (forceTimer) clearTimeout(forceTimer);
    },
  });
}

export async function readProtocolLineWithTimeout(iterator, childClosed, timeoutMs) {
  if (!iterator || typeof iterator.next !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 180_000) {
    throw new Error("Protocol response wait configuration is invalid");
  }
  let timer = null;
  try {
    return await Promise.race([
      iterator.next(),
      childClosed.then(() => { throw new Error("Protocol transport closed before responding"); }),
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error("Protocol response timed out")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function waitForChildWithHardTimeout(child, options) {
  const timeoutMs = Number(options?.timeoutMs);
  const terminateGraceMs = Number(options?.terminateGraceMs ?? 2_000);
  const killProcessGroup = options?.killProcessGroup === true;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(terminateGraceMs) || terminateGraceMs < 1) {
    throw new Error("Child hard timeout configuration is invalid");
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    let forceTimer = null;
    let finalTimer = null;
    let deadlineTimer = null;
    const cleanup = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (finalTimer) clearTimeout(finalTimer);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(Object.freeze({ code, signal, timedOut }));
    };
    const onError = error => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const onClose = (code, signal) => finish(code, signal);
    child.once("error", onError);
    child.once("close", onClose);
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      terminateChildProcess(child, "SIGTERM", killProcessGroup);
      forceTimer = setTimeout(() => {
        terminateChildProcess(child, "SIGKILL", killProcessGroup);
        finalTimer = setTimeout(() => finish(null, "SIGKILL"), terminateGraceMs);
      }, terminateGraceMs);
    }, timeoutMs);
  });
}
