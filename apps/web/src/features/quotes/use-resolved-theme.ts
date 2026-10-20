import { useEffect, useState } from "react";
import type { ThemeName } from "./chart-theme";

const read = (): ThemeName =>
  document.documentElement.classList.contains("dark") ? "dark" : "light";

/** Observes the `dark` class on <html> (set by the app's ThemeProvider) so the chart can re-apply colours. */
export function useResolvedTheme(): ThemeName {
  const [theme, setTheme] = useState<ThemeName>(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    setTheme(read());
    return () => observer.disconnect();
  }, []);
  return theme;
}
