import { useCallback, useEffect, useRef, useState } from "react";

/** A one-shot cooldown in whole seconds: `start()` begins it, `remaining` counts down to 0 (used for the 10 s quote refresh limit, spec 13.1). */
export function useCooldown(seconds: number): { remaining: number; start: () => void } {
  const [remaining, setRemaining] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    stop();
    setRemaining(seconds);
    timer.current = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          stop();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
  }, [seconds, stop]);

  useEffect(() => stop, [stop]);
  return { remaining, start };
}
