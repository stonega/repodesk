import { useEffect } from "react";

/** Visible repository lists refresh serially, including after a visit to GitHub. */
export function useRepositoryRefresh(
  refresh: (signal: AbortSignal) => Promise<void>,
  enabled = true,
  interval = 5000,
) {
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let pending = false;
    const update = async () => {
      if (
        pending ||
        controller.signal.aborted ||
        document.visibilityState !== "visible"
      )
        return;
      pending = true;
      try {
        await refresh(controller.signal);
      } finally {
        pending = false;
      }
    };
    void update();
    const timer = window.setInterval(() => void update(), interval);
    const onVisible = () => void update();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, refresh, interval]);
}
