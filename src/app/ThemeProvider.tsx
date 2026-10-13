import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { applyTheme, readTheme, parseTheme, resolveTheme, syncThemeColor, THEME_STORAGE_KEY, type ThemePreference } from './theme';

type ThemeContextValue = { preference: ThemePreference; resolvedMode: 'light' | 'dark'; updateTheme: (updates: Partial<ThemePreference>) => void };
const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState(readTheme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    const storage = (event: StorageEvent) => { if (event.key === THEME_STORAGE_KEY || event.key === null) setPreference(parseTheme(event.key === null ? null : event.newValue)); };
    change();
    media.addEventListener('change', change);
    window.addEventListener('storage', storage);
    return () => { media.removeEventListener('change', change); window.removeEventListener('storage', storage); };
  }, []);
  useEffect(() => { applyTheme(preference, systemDark); }, [preference, systemDark]);
  useEffect(() => {
    // The browser chrome colour follows whichever page root is mounted, so re-sync when the root swaps pages.
    const root = document.getElementById('root');
    if (!root) return;
    const observer = new MutationObserver(syncThemeColor);
    observer.observe(root, { childList: true });
    return () => observer.disconnect();
  }, []);
  function updateTheme(updates: Partial<ThemePreference>) {
    const next = { ...preference, ...updates };
    applyTheme(next, systemDark);
    try { localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(next)); } catch { /* Keep the choice for this session when browser storage is unavailable. */ }
    setPreference(next);
  }
  return <ThemeContext.Provider value={{ preference, resolvedMode: resolveTheme(preference.mode, systemDark), updateTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('ThemeProvider is required.');
  return theme;
}
