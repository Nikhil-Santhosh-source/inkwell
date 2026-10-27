// Colour themes and light/dark appearance. The colours themselves live in
// styles.css (keyed by data-theme / data-appearance on <html>); this module
// remembers the choice and applies it. index.html applies the saved choice
// before the page draws, so there's no flash of the wrong theme.

export const THEMES = [
  { id: 'inkwell', label: 'Inkwell', swatch: ['#3b3fd8', '#e8a33d'] },
  { id: 'sakura', label: 'Sakura', swatch: ['#d6457a', '#f3b6c9'] },
  { id: 'forest', label: 'Forest', swatch: ['#2f7d5b', '#d8b45c'] },
  { id: 'ocean', label: 'Ocean', swatch: ['#1f78b4', '#5fd0c5'] },
  { id: 'graphite', label: 'Graphite', swatch: ['#3d3d46', '#ff7a45'] },
];

export const APPEARANCES = [
  { id: 'auto', label: 'Auto' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

const KEY = 'inkwell.theme';
const listeners = new Set();

export function loadTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    return {
      theme: THEMES.some((t) => t.id === saved?.theme) ? saved.theme : 'inkwell',
      appearance: APPEARANCES.some((a) => a.id === saved?.appearance) ? saved.appearance : 'auto',
    };
  } catch {
    return { theme: 'inkwell', appearance: 'auto' };
  }
}

export function applyTheme({ theme, appearance }) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.appearance = appearance;
  // The browser/status bar colour follows the page background.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = bg || '#f5f1e8';
}

export function setTheme(change) {
  const next = { ...loadTheme(), ...change };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* not critical */ }
  applyTheme(next);
  for (const fn of listeners) fn(next);
}

// Called after the theme changes (the canvas redraws its desk colour).
export function onThemeChange(fn) {
  listeners.add(fn);
}

// Dark appearance in effect right now (explicit, or Auto following the iPad).
export function isDark() {
  const { appearance } = loadTheme();
  return appearance === 'dark' || (appearance === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
}

// Fills `container` with the appearance switch and theme swatches.
export function renderThemePicker(container) {
  const current = loadTheme();
  const segmented = document.createElement('div');
  segmented.className = 'segmented';
  segmented.setAttribute('role', 'radiogroup');
  segmented.setAttribute('aria-label', 'Appearance');
  for (const a of APPEARANCES) {
    const button = document.createElement('button');
    button.textContent = a.label;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(a.id === current.appearance));
    button.addEventListener('click', () => {
      setTheme({ appearance: a.id });
      renderThemePicker(container);
    });
    segmented.append(button);
  }
  const swatches = document.createElement('div');
  swatches.className = 'theme-swatches';
  for (const t of THEMES) {
    const button = document.createElement('button');
    button.className = 'theme-swatch';
    button.setAttribute('aria-pressed', String(t.id === current.theme));
    button.setAttribute('aria-label', `${t.label} theme`);
    button.innerHTML = `<span class="theme-dot" style="background: linear-gradient(135deg, ${t.swatch[0]} 0 55%, ${t.swatch[1]} 55% 100%)"></span><span>${t.label}</span>`;
    button.addEventListener('click', () => {
      setTheme({ theme: t.id });
      renderThemePicker(container);
    });
    swatches.append(button);
  }
  container.replaceChildren(segmented, swatches);
}
