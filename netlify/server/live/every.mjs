// Runs `task` every `ms`, skipping a turn while the previous one is still
// running, and while `when()` is false. Returns a function that stops it.
export const every = (ms, task, when = () => true) => {
  let running = false;

  const timer = setInterval(async () => {
    if (running || !when()) {
      return;
    }
    running = true;
    try {
      await task();
    } catch (error) {
      console.error("background task failed:", error.message);
    } finally {
      running = false;
    }
  }, ms);

  return () => clearInterval(timer);
};
