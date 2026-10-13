export type ThemeMode = 'system' | 'light' | 'dark';
export type ThemeAccent = 'forest' | 'ocean' | 'plum' | 'graphite' | 'ember' | 'sand';
export type ThemePreference = { mode: ThemeMode; accent: ThemeAccent };

export const THEME_PALETTES: { value: ThemeAccent; label: string; description: string }[] = [
  { value: 'forest', label: 'Forest', description: 'Soft greens, calm and familiar' },
  { value: 'ocean', label: 'Ocean', description: 'Cool blues, midnight after dark' },
  { value: 'plum', label: 'Plum', description: 'Gentle violet, a little creative' },
  { value: 'graphite', label: 'Graphite', description: 'Quiet neutrals, clear and focused' },
  { value: 'ember', label: 'Ember', description: 'Warm copper, charcoal evenings' },
  { value: 'sand', label: 'Sand', description: 'Warm paper, soft mocha nights' },
];

export const THEME_STORAGE_KEY = 'await.appearance';
export const DEFAULT_THEME: ThemePreference = { mode: 'system', accent: 'forest' };

export function parseTheme(value: string | null): ThemePreference {
  try {
    const parsed = JSON.parse(value ?? 'null');
    return {
      mode: ['system', 'light', 'dark'].includes(parsed?.mode) ? parsed.mode : DEFAULT_THEME.mode,
      accent: THEME_PALETTES.some(({ value }) => value === parsed?.accent) ? parsed.accent : DEFAULT_THEME.accent,
    };
  } catch { return { ...DEFAULT_THEME }; }
}

export function readTheme(): ThemePreference {
  try { return parseTheme(localStorage.getItem(THEME_STORAGE_KEY)); }
  catch { return { ...DEFAULT_THEME }; }
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean): 'light' | 'dark' {
  return mode === 'system' ? systemDark ? 'dark' : 'light' : mode;
}

export function applyTheme(preference: ThemePreference, systemDark: boolean) {
  document.documentElement.dataset.theme = resolveTheme(preference.mode, systemDark);
  document.documentElement.dataset.accent = preference.accent;
  syncThemeColor();
}

// Public pages (landing, sign-in, workspace creation, loading) stay light regardless of the app theme.
export const LIGHT_PAGE_SELECTOR = '.landing-page, .sign-page, .create-page, .loading-page';

export function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const page = document.querySelector(LIGHT_PAGE_SELECTOR);
  const color = page ? getComputedStyle(page).backgroundColor : getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
  if (color) meta.setAttribute('content', color);
}
