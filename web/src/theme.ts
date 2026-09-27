/* ============================================================================
 * The palette switch.
 *
 * LINEN (米白) is the default and lives in CSS, so a first paint needs no
 * JavaScript at all. This module only records a non-default choice and puts the
 * attribute on <html>; `index.html` runs the same read inline, before the bundle
 * loads, so a dark-mode user never sees a flash of cream.
 *
 * The storage key and the attribute name are duplicated here and in
 * index.html — keep them in step.
 * ==========================================================================*/

export type Theme = "linen" | "dark"

export const THEME_KEY = "goto.theme"

/** Anything that is not exactly "dark" is the default. Never throw on a locked
 *  down localStorage: the app has to boot even with storage disabled. */
export function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "linen"
  } catch {
    return "linen"
  }
}

/** Paints the palette. The attribute is the single source of truth for CSS. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

export function writeTheme(theme: Theme): void {
  applyTheme(theme)
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* a disabled localStorage should not stop the switch from working */
  }
}
