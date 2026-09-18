export const UI_SCALE_STORAGE_KEY = "codex-router-ui-scale";

export const UI_SCALE_OPTIONS = [90, 100, 110, 120, 130] as const;
export type UiScale = (typeof UI_SCALE_OPTIONS)[number];

export const DEFAULT_UI_SCALE: UiScale = 100;

export function isUiScale(value: unknown): value is UiScale {
  return typeof value === "number" && UI_SCALE_OPTIONS.includes(value as UiScale);
}

export function detectUiScale(): UiScale {
  try {
    const stored = Number(localStorage.getItem(UI_SCALE_STORAGE_KEY));
    if (isUiScale(stored)) return stored;
  } catch { /* storage can be unavailable; use the product default */ }
  return DEFAULT_UI_SCALE;
}

export function storeUiScale(scale: UiScale): void {
  try {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, String(scale));
  } catch { /* a rejected write only costs the preference on next launch */ }
}

export function applyUiScale(scale: UiScale): void {
  const root = document.documentElement;
  root.style.setProperty("zoom", String(scale / 100));
  root.dataset.uiScale = String(scale);
}
