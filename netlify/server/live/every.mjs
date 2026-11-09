// Runs `task` every `ms`, skipping a turn while the previous one is still
// running, and while `when()` is false. Returns a function that stops it,
// and resolves once the turn in progress (if any) is done.
export const every = (ms, task, when = () => true) => {
  let running = null;

  const timer = setInterval(() => {
    if (running || !when()) {
      return;
    }
    running = (async () => {
      try {
        await task();
      } catch (error) {
        console.error("background task failed:", error.message);
      } finally {
        running = null;
      }
    })();
  }, ms);

  return () => {
    clearInterval(timer);

    return running ?? Promise.resolve();
  };
};
