// The front-end's own state in the project file (`project.ui`): view, map styles, saved
// plot views and profiles.

import { api, errorText } from "../api";
import { getState, notify, setState } from "../store";

/** Deep equality of JSON values, whatever the order of the keys (the backend sorts them). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const [ka, kb] = [Object.keys(a), Object.keys(b)];
  const [ra, rb] = [a as Record<string, unknown>, b as Record<string, unknown>];
  return ka.length === kb.length && ka.every((k) => k in rb && sameJson(ra[k], rb[k]));
}

/**
 * Merges `patch` into the UI state of the project and saves it. Nothing is written when
 * nothing changes (opening a model must not rewrite its project file), nor when the open
 * model is no longer `forPath` (a debounced save that fires after another model was opened).
 */
export function updateProjectUi(patch: Record<string, unknown>, forPath?: string) {
  const m = getState().model;
  if (!m || (forPath !== undefined && m.path !== forPath)) return;
  const ui = { ...m.project.ui, ...patch };
  if (sameJson(ui, m.project.ui)) return;
  setState({ model: { ...m, project: { ...m.project, ui } } });
  api.updateProject(undefined, ui).catch((e) => notify(errorText(e), true));
}
