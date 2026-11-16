// Model editing from the UI: every change goes through the backend, which owns the
// model and its undo history. Requests are queued so that they apply in order, and
// opening a model waits its turn in the same queue (see `afterEdits`).

import { ask, save } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { applyPatch } from "../geometryPatch";
import { getState, notify, setState, type State } from "../store";
import { sameRef, type EditOutcome, type EditRequest, type ObjKind, type ObjRef } from "../types";
import { seriesKey, type PlotView } from "../uiTypes";
import { indexOfId } from "./ids";
import { mapPlotSeries } from "./views";

let queue: Promise<unknown> = Promise.resolve();

/** Runs `f` after every request queued before it. */
function enqueue<T>(f: () => Promise<T>): Promise<T> {
  const next = queue.then(f, f);
  queue = next.catch(() => {});
  return next;
}

/**
 * Runs `f` once the edits asked for before it are done, and before those asked for after
 * it: opening a model goes through here, so that no edit meant for one model reaches the
 * next one. `f` must not wait for an edit itself.
 */
export const afterEdits = enqueue;

/** Thrown for an edit asked for in a model that has been replaced (opened again, or another one) since. */
const STALE = "another model was opened: the change was not applied";

/** Plotted series found again by name after the indices changed (dropped when gone). */
function remapPlotViews(views: PlotView[], ids: State["ids"]): PlotView[] {
  return mapPlotSeries(views, (p) => {
    if (p.kind === "system" || !p.id) return p;
    const index = indexOfId(ids[p.kind as ObjKind], p.id);
    return index < 0 ? null : { ...p, index, key: seriesKey(p.kind, index, p.var, p.b) };
  });
}

/**
 * Profiles after the node indices changed: their nodes are found again by name (the
 * names loaded before the edit, or those of the profile shown). A profile that lost a
 * node, or whose node names are not known, is emptied rather than drawn through other nodes.
 */
function remapProfiles(s: State, nodeIds: string[]): Pick<State, "profileViews" | "profileNodes" | "profileStart"> {
  const shownNames = new Map(s.profile?.nodes.map((n) => [n.index, n.id]));
  const nameOf = (i: number) => s.ids.node?.[i] ?? shownNames.get(i);
  const remap = (nodes: number[]): number[] => {
    const next = nodes.map((i) => {
      const name = nameOf(i);
      return name === undefined ? -1 : indexOfId(nodeIds, name);
    });
    return next.includes(-1) ? [] : next;
  };
  const profileViews = s.profileViews.map((v) => ({ ...v, nodes: remap(v.nodes) }));
  const shown = profileViews.find((v) => v.id === s.profileView);
  return { profileViews, profileNodes: shown ? shown.nodes : [], profileStart: null };
}

/**
 * Updates the UI after the backend changed the model. `seq`: the opening of the model the
 * edit was made in; when another model (or the same file again) was opened since, the
 * outcome no longer applies and is dropped.
 */
export async function applyOutcome(o: EditOutcome, seq = getState().modelSeq) {
  const s = getState();
  if (s.modelSeq !== seq) return;
  const info = { ...o.info };
  // Results and report only change when the network is rebuilt (objects matched again):
  // keeping them unchanged spares the panels that depend on them a reload.
  if (!o.rebuilt && s.model) {
    if (s.model.results && info.results?.path === s.model.results.path) info.results = s.model.results;
    if (s.model.report && info.report?.path === s.model.report.path) info.report = s.model.report;
  }
  const same = o.selection.length === s.selection.length && o.selection.every((r, i) => sameRef(r, s.selection[i]));
  const patch: Partial<State> = { model: info, selection: same ? s.selection : o.selection };
  if (o.geometry) patch.geometry = await api.geometry();
  else if (o.patch && s.geometry) patch.geometry = applyPatch(s.geometry, o.patch);
  if (o.rebuilt) {
    // Indices changed: reload the cached IDs (the node names too when profiles need them).
    const kinds = new Set(Object.keys(s.ids) as ObjKind[]);
    if (s.profileViews.length > 0) kinds.add("node");
    const lists = await Promise.all([...kinds].map((k) => api.ids(k)));
    const ids: State["ids"] = {};
    [...kinds].forEach((k, i) => (ids[k] = lists[i]));
    patch.ids = ids;
    // The views may have changed while the names were loaded: remap the current ones.
    const now = getState();
    patch.plotViews = remapPlotViews(now.plotViews, ids);
    Object.assign(patch, remapProfiles(now, ids.node ?? []));
  }
  if (getState().modelSeq !== seq) return;
  setState(patch);
  if (o.message) notify(o.message);
}

/** Applies an edit; errors are thrown (for inline display). */
export function tryEdit(req: EditRequest): Promise<EditOutcome> {
  // The request names objects by index in the model it was made in.
  const seq = getState().modelSeq;
  return enqueue(async () => {
    if (getState().modelSeq !== seq) throw new Error(STALE);
    const o = await api.edit(req, getState().selection);
    await applyOutcome(o, seq);
    return o;
  });
}

/** Applies an edit; errors go to the status bar. */
export async function edit(req: EditRequest): Promise<EditOutcome | null> {
  try {
    return await tryEdit(req);
  } catch (e) {
    // An edit of the previous model says nothing about the one now open: the status bar
    // keeps what the opening said.
    if (!(e instanceof Error && e.message === STALE)) notify(errorText(e), true);
    return null;
  }
}

/** Undoes or redoes one edit, and says which. */
function step(apply: (selection: ObjRef[]) => Promise<EditOutcome>) {
  const seq = getState().modelSeq;
  return enqueue(async () => {
    // Undo of the model the user was looking at, not of the one opened since.
    if (getState().modelSeq !== seq) return;
    try {
      const o = await apply(getState().selection);
      await applyOutcome(o, seq);
      notify(o.label);
    } catch (e) {
      notify(errorText(e), true);
    }
  });
}

export function undo() {
  if (getState().model?.undo) return step(api.undo);
}

export function redo() {
  if (getState().model?.redo) return step(api.redo);
}

/** Saves the model; `as` asks for a new file name. Returns false when nothing was saved. */
export async function saveModel(as = false): Promise<boolean> {
  const m = getState().model;
  if (!m) return false;
  let path: string | null = null;
  if (as) {
    const p = await save({ defaultPath: m.path, filters: [{ name: "SWMM model", extensions: ["inp"] }] });
    if (!p) return false;
    path = p;
  }
  return enqueue(async () => {
    try {
      const model = await api.saveModel(path);
      setState({ model });
      notify(`Saved ${model.path}`);
      return true;
    } catch (e) {
      notify(errorText(e), true);
      return false;
    }
  });
}

/** Asks whether unsaved changes may be lost; saves them if the user wants. */
export async function confirmDiscard(): Promise<boolean> {
  const m = getState().model;
  if (!m?.dirty) return true;
  const saveFirst = await ask(`${m.name} has unsaved changes. Save them first?`, {
    title: "SWMM Studio",
    kind: "warning",
    okLabel: "Save",
    cancelLabel: "Don't save",
  });
  return saveFirst ? saveModel() : true;
}
/** Asks for confirmation (with what else goes away), then deletes. */
export async function deleteObjects(objects: ObjRef[]) {
  if (objects.length === 0) return;
  const seq = getState().modelSeq;
  try {
    const plan = await api.deletePlan(objects);
    // The objects are those of the model shown when they were chosen.
    if (getState().modelSeq !== seq) return;
    const simple = plan.cascade_links.length === 0 && plan.cleared.length === 0 && plan.rules === 0;
    if (simple && objects.length === 1) {
      await edit({ op: "delete", objects });
    } else {
      setState({ pendingDelete: { objects, plan } });
    }
  } catch (e) {
    if (getState().modelSeq === seq) notify(errorText(e), true);
  }
}

export async function confirmDelete() {
  const p = getState().pendingDelete;
  setState({ pendingDelete: null });
  if (p) await edit({ op: "delete", objects: p.objects });
}
