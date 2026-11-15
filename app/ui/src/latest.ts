// Asking the backend from an effect, when only the answer to the last question counts.

/**
 * Runs `load` (after `delay` ms, when given) and passes its answer to `onValue`, or its
 * failure to `onError`. Returns the cleanup of the effect: once it ran — the question
 * changed or the component is gone — a load not started yet is not, and a late answer
 * is dropped instead of replacing the one to the current question.
 */
export function latest<T>(load: () => Promise<T>, onValue: (value: T) => void, onError: (error: unknown) => void, delay = 0): () => void {
  let current = true;
  const run = () => {
    load().then(
      (value) => current && onValue(value),
      (error) => current && onError(error),
    );
  };
  const timer = delay > 0 ? setTimeout(run, delay) : (run(), undefined);
  return () => {
    current = false;
    clearTimeout(timer);
  };
}
