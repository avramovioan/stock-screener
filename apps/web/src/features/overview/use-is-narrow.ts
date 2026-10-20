import { useEffect, useState } from "react";

const QUERY = "(max-width: 639px)";

/** True below 640 px (Tailwind `sm`). One rendering path at a time, so no duplicated accessible content. */
export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia(QUERY).matches : false,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia(QUERY);
    const onChange = () => setNarrow(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return narrow;
}
