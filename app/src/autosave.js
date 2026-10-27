// Debounced autosave. Saves run one at a time, in order, always with the
// latest value. A failed save keeps its value so the next flush retries it.

export function createAutosaver(save, { delay = 400, onStatus = () => {}, onError = () => {} } = {}) {
  let pending = null;
  let hasPending = false;
  let timer = null;
  let chain = Promise.resolve();

  function schedule(value) {
    pending = value;
    hasPending = true;
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
    onStatus('pending');
  }

  // Saves the pending value now. Resolves once every queued save has finished.
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!hasPending) return chain;
    const value = pending;
    pending = null;
    hasPending = false;
    onStatus('saving');
    chain = chain.then(
      () => save(value).then(
        () => onStatus(hasPending ? 'pending' : 'saved'),
        (err) => {
          if (!hasPending) {
            pending = value;
            hasPending = true;
          }
          onStatus('error');
          onError(err);
        },
      ),
    );
    return chain;
  }

  return {
    schedule,
    flush,
    get hasPending() {
      return hasPending;
    },
  };
}
