/**
 * Per-tab mutation queues.
 *
 * A click is not one command: it resolves a ref, may scroll, dispatches several
 * events, waits for the app, then verifies the result. Two agents interleaving
 * those sequences on one tab can each act on geometry captured before the
 * other's page change. Serialise the whole sequence while leaving different
 * tabs fully parallel.
 */

const queues = new Map();

export function serializeTabMutation(tabId, fn) {
  const previous = queues.get(tabId) || Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(() => {}, () => {});
  queues.set(tabId, tail);
  return run.finally(() => {
    if (queues.get(tabId) === tail) queues.delete(tabId);
  });
}

export function clearTabMutation(tabId) {
  queues.delete(tabId);
}
