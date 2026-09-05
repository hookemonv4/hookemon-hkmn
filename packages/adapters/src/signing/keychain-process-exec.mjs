import { execFile } from 'node:child_process';

/**
 * Creates the production executor used by keychain-backed signer clients. A timeout or abort first
 * requests a clean exit, then escalates if the helper has not exited, and settles only after reaping
 * the child process.
 */
export function createProcessExec() {
  return ({ command, args, input, timeoutMs, signal }) => new Promise((resolveExec, rejectExec) => {
    let settled = false;
    let timedOut = false;
    let deadlineTimer;
    let forceKillTimer;
    let abortListener;
    const settle = callback => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener?.('abort', abortListener);
      callback();
    };
    let child;
    const terminateAndReap = () => {
      if (settled || timedOut) return;
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // The helper may exit while the timeout or abort is being delivered.
      }
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // A cooperative helper can exit during the termination grace period.
        }
      }, 100);
    };
    try {
      child = execFile(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : (error ? 1 : 0);
        settle(() => resolveExec({ code, stdout, stderr, timedOut }));
      });
    } catch (error) {
      settle(() => rejectExec(error));
      return;
    }
    child.once('error', error => settle(() => rejectExec(error)));
    if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) deadlineTimer = setTimeout(terminateAndReap, timeoutMs);
    abortListener = terminateAndReap;
    if (signal?.aborted) terminateAndReap();
    else signal?.addEventListener?.('abort', abortListener, { once: true });
    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}
