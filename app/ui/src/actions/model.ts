// Opening models and results, and the coordinate system.

import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { afterEdits, confirmDiscard, readGeometry } from "./edit";
import { getState, notify, resetForModel, setState, startBusy } from "../store";
import { defaultStyle, styleUsable, type StyledKind } from "../uiTypes";
import { mapPlotSeries } from "./views";
import type { FileChange, ModelInfo } from "../types";

/** Offers a coordinate system for a model opened without one, when one can be suggested. */
function askCrs(model: ModelInfo) {
  if (!model.crs && model.bounds) setState({ crsDialog: !model.project.crs && model.crs_hint !== null });
}

/** Opens a model file (after the edits already asked for: they belong to the current model). */
export function openModel(path: string): Promise<void> {
  const done = startBusy("Opening model…");
  setState({ playing: false });
  return afterEdits(async () => {
    try {
      const model = await api.openModel(path);
      const { geometry, error } = await readGeometry();
      resetForModel(model, geometry);
      const notes = [...model.notes];
      if (model.project_error) notes.push(`Project file ignored: ${model.project_error}`);
      if (error) notes.push(error);
      // One message: the status bar shows the last one only.
      if (notes.length > 0) notify(notes.join(" — "), true);
      // Changes autosaved by a session that ended without saving: restore or discard them
      // (the coordinate system is asked for after).
      if (model.recovery) setState({ dialog: "recovery" });
      else askCrs(model);
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      done();
    }
  });
}

/** Creates an empty model in a new file and opens it. */
export function newModel(path: string, flowUnits: string): Promise<void> {
  const done = startBusy("Creating model…");
  return afterEdits(async () => {
    try {
      const model = await api.newModel(path, flowUnits);
      const { geometry, error } = await readGeometry();
      resetForModel(model, geometry);
      setState({ dialog: null, crsDialog: true });
      if (error) notify(error, true);
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      done();
    }
  });
}

/** Asks for a model file and opens it (unsaved changes are offered to be saved first). */
export async function chooseModel() {
  if (!(await confirmDiscard())) return;
  const path = await open({ filters: [{ name: "SWMM model", extensions: ["inp"] }] });
  if (typeof path === "string") await openModel(path);
}

/** Opens a recent model (unsaved changes are offered to be saved first). */
export async function openRecent(path: string) {
  if (await confirmDiscard()) await openModel(path);
}

/** Replaces the open model by the changes a session that ended without saving left. */
export function restoreRecovery(): Promise<void> {
  const done = startBusy("Restoring unsaved changes…");
  return afterEdits(async () => {
    try {
      const model = await api.restoreRecovery();
      const { geometry, error } = await readGeometry();
      resetForModel(model, geometry);
      setState({ dialog: null });
      askCrs(model);
      notify(error ?? `Restored the unsaved changes of ${model.name}: save to keep them`, !!error);
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      done();
    }
  });
}

/** Gives up the changes a session that ended without saving left for the open model. */
export function discardRecovery(): Promise<void> {
  return afterEdits(async () => {
    try {
      const model = await api.discardRecovery(null);
      if (model) {
        setState({ model });
        askCrs(model);
      }
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setState({ dialog: null });
    }
  });
}

/** Opens the "new model" dialog (unsaved changes are offered to be saved first). */
export async function askNewModel() {
  if (await confirmDiscard()) setState({ dialog: "new" });
}

/**
 * Applies new model info after results were loaded or unloaded: styles and plotted
 * series that no longer apply are reset or dropped.
 */
export function setResultsInfo(model: ModelInfo, resetTime: boolean) {
  const s = getState();
  const styles = { ...s.styles };
  for (const k of Object.keys(styles) as StyledKind[]) if (!styleUsable(styles[k], k, model)) styles[k] = defaultStyle(k);
  const plotViews = mapPlotSeries(s.plotViews, (p) => (!p.b || model.compare ? p : null));
  setState({ model, styles, plotViews, ...(resetTime ? { period: 0, playing: false } : {}) });
}

/** Asks for a results file (`.out`), starting in the folder of the model, and loads it into the open model. */
export async function chooseResults() {
  const folder = getState().model?.path.replace(/[\\/][^\\/]*$/, "");
  const path = await open({ defaultPath: folder || undefined, filters: [{ name: "SWMM results", extensions: ["out"] }] });
  if (typeof path !== "string") return;
  const done = startBusy("Opening results…");
  setState({ playing: false });
  try {
    setResultsInfo(await api.openResults(path), true);
  } catch (e) {
    notify(errorText(e), true);
  } finally {
    done();
  }
}

/**
 * Sets the coordinate system of the model (null: local coordinates); errors are thrown. Once
 * the back-end has changed it, the new one is shown, with or without a map.
 */
export async function applyCrs(id: string | null) {
  const done = startBusy("Reprojecting…");
  try {
    const model = await api.setCrs(id);
    const { geometry, error } = await readGeometry();
    // The saved view belongs to the previous coordinate space.
    setState({ model, geometry, crsDialog: false, fitExtent: getState().fitExtent + 1 });
    if (error) notify(error, true);
  } finally {
    done();
  }
}

/** A file of the model changed by another program: offered to be reloaded (the newest change of each kind). */
export function fileChanged(c: FileChange) {
  const m = getState().model;
  const current = c.kind === "model" ? m?.path : m?.results?.path;
  if (current !== c.path) return;
  setState((s) => ({ fileChanges: [...s.fileChanges.filter((f) => f.kind !== c.kind), c] }));
}

function dropFileChange(kind: FileChange["kind"]) {
  setState((s) => ({ fileChanges: s.fileChanges.filter((f) => f.kind !== kind) }));
}

/** Keeps the model or the results as they are in the app: that change is not offered again. */
export async function keepFile(kind: FileChange["kind"]) {
  dropFileChange(kind);
  try {
    await api.ignoreFileChange(kind);
  } catch (e) {
    notify(errorText(e), true);
  }
}

/** Reads the model again from its file (its unsaved changes are lost: the dialog said so). */
export async function reloadModel() {
  const m = getState().model;
  if (!m) return;
  // The results changed with it are read with the model.
  setState({ fileChanges: [] });
  await openModel(m.path);
}

/** Reads the loaded results again from their file (and the report beside them). */
export async function reloadResults() {
  const path = getState().model?.results?.path;
  dropFileChange("results");
  if (!path) return;
  const done = startBusy("Reloading results…");
  setState({ playing: false });
  try {
    const model = await api.openResults(path);
    setResultsInfo(model, false);
    // The time shown stays, when the results still reach it.
    const n = model.results?.n_periods ?? 0;
    if (getState().period >= n) setState({ period: Math.max(0, n - 1) });
    notify(`Reloaded the results ${model.results?.path ?? path}`);
  } catch (e) {
    notify(errorText(e), true);
  } finally {
    done();
  }
}
