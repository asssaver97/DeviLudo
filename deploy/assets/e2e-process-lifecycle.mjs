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
