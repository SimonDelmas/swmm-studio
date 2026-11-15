// Opening models and results, and the coordinate system.

import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { confirmDiscard } from "./edit";
import { getState, notify, resetForModel, setState } from "../store";
import { defaultStyle, styleUsable, type StyledKind } from "../uiTypes";
import { mapPlotSeries } from "./views";
import type { ModelInfo } from "../types";

export async function openModel(path: string) {
  setState({ busy: "Opening model…", playing: false });
  try {
    const model = await api.openModel(path);
    const geometry = await api.geometry();
    resetForModel(model, geometry);
    const notes = [...model.notes];
    if (model.project_error) notes.push(`Project file ignored: ${model.project_error}`);
    // One message: the status bar shows the last one only.
    if (notes.length > 0) notify(notes.join(" — "), true);
    if (!model.crs && model.bounds) setState({ crsDialog: !model.project.crs && model.crs_hint !== null });
  } catch (e) {
    notify(errorText(e), true);
  } finally {
    setState({ busy: null });
  }
}

/** Creates an empty model in a new file and opens it. */
export async function newModel(path: string, flowUnits: string) {
  setState({ busy: "Creating model…" });
  try {
    const model = await api.newModel(path, flowUnits);
    const geometry = await api.geometry();
    resetForModel(model, geometry);
    setState({ dialog: null, crsDialog: true });
  } catch (e) {
    notify(errorText(e), true);
  } finally {
    setState({ busy: null });
  }
}

/** Asks for a model file and opens it (unsaved changes are offered to be saved first). */
export async function chooseModel() {
  if (!(await confirmDiscard())) return;
  const path = await open({ filters: [{ name: "SWMM model", extensions: ["inp"] }] });
  if (typeof path === "string") await openModel(path);
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

/** Asks for a results file (`.out`) and loads it into the open model. */
export async function chooseResults() {
  const path = await open({ filters: [{ name: "SWMM results", extensions: ["out"] }] });
  if (typeof path !== "string") return;
  setState({ busy: "Opening results…", playing: false });
  try {
    setResultsInfo(await api.openResults(path), true);
  } catch (e) {
    notify(errorText(e), true);
  } finally {
    setState({ busy: null });
  }
}

/** Sets the coordinate system of the model (null: local coordinates); errors are thrown. */
export async function applyCrs(id: string | null) {
  setState({ busy: "Reprojecting…" });
  try {
    const model = await api.setCrs(id);
    const geometry = await api.geometry();
    // The saved view belongs to the previous coordinate space.
    setState({ model, geometry, crsDialog: false, fitExtent: getState().fitExtent + 1 });
  } finally {
    setState({ busy: null });
  }
}
