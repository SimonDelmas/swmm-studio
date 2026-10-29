// Model editing from the UI: every change goes through the backend, which owns the
// model and its undo history. Requests are queued so that they apply in order.

import { ask, save } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "./api";
import { seriesKey } from "./components/PlotPanel";
import { getState, mapPlotSeries, notify, resetForModel, setState, type State } from "./store";
import type { EditOutcome, EditRequest, Geometry, GeometryPatch, ObjKind, ObjRef } from "./types";

let queue: Promise<unknown> = Promise.resolve();

/** Runs `f` after every request queued before it. */
function enqueue<T>(f: () => Promise<T>): Promise<T> {
  const next = queue.then(f, f);
  queue = next.catch(() => {});
  return next;
}

const num = (v: number | null) => (v === null ? NaN : v);

/** Replaces the paths of some objects in flat (starts, points) arrays. */
function splice(starts: Uint32Array, pts: Float64Array, changed: Map<number, (number | null)[][]>) {
  const n = starts.length - 1;
  let sameSize = true;
  let total = pts.length / 2;
  for (const [i, p] of changed) {
    const old = starts[i + 1] - starts[i];
    if (p.length !== old) sameSize = false;
    total += p.length - old;
  }
  if (sameSize) {
    const out = pts.slice();
    for (const [i, p] of changed) p.forEach((xy, k) => ((out[2 * (starts[i] + k)] = num(xy[0])), (out[2 * (starts[i] + k) + 1] = num(xy[1]))));
    return { starts, pts: out };
  }
  const s2 = new Uint32Array(n + 1);
  const p2 = new Float64Array(2 * total);
  let k = 0;
  for (let i = 0; i < n; i++) {
    s2[i] = k;
    const c = changed.get(i);
    if (c) {
      for (const xy of c) ((p2[2 * k] = num(xy[0])), (p2[2 * k + 1] = num(xy[1])), k++);
    } else {
      p2.set(pts.subarray(2 * starts[i], 2 * starts[i + 1]), 2 * k);
      k += starts[i + 1] - starts[i];
    }
  }
  s2[n] = k;
  return { starts: s2, pts: p2 };
}

/** Geometry with the objects of a patch replaced (the arrays are copied, not changed). */
export function applyPatch(g: Geometry, p: GeometryPatch): Geometry {
  const out = { ...g };
  if (p.nodes.length) {
    out.nodes = g.nodes.slice();
    for (const [i, xy] of p.nodes) ((out.nodes[2 * i] = num(xy[0])), (out.nodes[2 * i + 1] = num(xy[1])));
  }
  if (p.gages.length) {
    out.gages = g.gages.slice();
    for (const [i, xy] of p.gages) ((out.gages[2 * i] = num(xy[0])), (out.gages[2 * i + 1] = num(xy[1])));
  }
  if (p.links.length) {
    out.linkEnds = g.linkEnds.slice();
    for (const [i, ends] of p.links) ((out.linkEnds[2 * i] = ends[0]), (out.linkEnds[2 * i + 1] = ends[1]));
    const r = splice(g.linkStarts, g.linkPts, new Map(p.links.map(([i, , pts]) => [i, pts])));
    out.linkStarts = r.starts;
    out.linkPts = r.pts;
  }
  if (p.subcatchments.length) {
    out.subOutlets = g.subOutlets.slice();
    for (const [i, o] of p.subcatchments) ((out.subOutlets[2 * i] = o[0]), (out.subOutlets[2 * i + 1] = o[1]));
    const r = splice(g.subStarts, g.subPts, new Map(p.subcatchments.map(([i, , pts]) => [i, pts])));
    out.subStarts = r.starts;
    out.subPts = r.pts;
  }
  return out;
}

/** Updates the UI after the backend changed the model. */
export async function applyOutcome(o: EditOutcome) {
  const s = getState();
  const info = { ...o.info };
  // Results and report only change when the network is rebuilt (objects matched again):
  // keeping them unchanged spares the panels that depend on them a reload.
  if (!o.rebuilt && s.model) {
    if (s.model.results && info.results?.path === s.model.results.path) info.results = s.model.results;
    if (s.model.report && info.report?.path === s.model.report.path) info.report = s.model.report;
  }
  const same = o.selection.length === s.selection.length && o.selection.every((r, i) => r.kind === s.selection[i].kind && r.index === s.selection[i].index);
  const patch: Partial<State> = { model: info, selection: same ? s.selection : o.selection };
  if (o.geometry) patch.geometry = await api.geometry();
  else if (o.patch && s.geometry) patch.geometry = applyPatch(s.geometry, o.patch);
  if (o.rebuilt) {
    // Indices changed: reload the cached IDs and find plotted objects by name.
    const kinds = Object.keys(s.ids) as ObjKind[];
    const lists = await Promise.all(kinds.map((k) => api.ids(k)));
    const ids: State["ids"] = {};
    kinds.forEach((k, i) => (ids[k] = lists[i]));
    patch.ids = ids;
    patch.plotViews = mapPlotSeries(s.plotViews, (p) => {
      if (p.kind === "system" || !p.id) return p;
      const list = ids[p.kind as ObjKind];
      const index = list ? list.findIndex((x) => x.toUpperCase() === p.id!.toUpperCase()) : -1;
      return index < 0 ? null : { ...p, index, key: seriesKey(p.kind, index, p.var, p.b) };
    });
  }
  setState(patch);
  if (o.message) notify(o.message);
}

/** Applies an edit; errors are thrown (for inline display). */
export function tryEdit(req: EditRequest): Promise<EditOutcome> {
  return enqueue(async () => {
    const o = await api.edit(req, getState().selection);
    await applyOutcome(o);
    return o;
  });
}

/** Applies an edit; errors go to the status bar. */
export async function edit(req: EditRequest): Promise<EditOutcome | null> {
  try {
    return await tryEdit(req);
  } catch (e) {
    notify(errorText(e), true);
    return null;
  }
}

export function undo() {
  if (!getState().model?.undo) return;
  return enqueue(async () => {
    try {
      const o = await api.undo(getState().selection);
      await applyOutcome(o);
      notify(o.label);
    } catch (e) {
      notify(errorText(e), true);
    }
  });
}

export function redo() {
  if (!getState().model?.redo) return;
  return enqueue(async () => {
    try {
      const o = await api.redo(getState().selection);
      await applyOutcome(o);
      notify(o.label);
    } catch (e) {
      notify(errorText(e), true);
    }
  });
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

/** Asks for confirmation (with what else goes away), then deletes. */
export async function deleteObjects(objects: ObjRef[]) {
  if (objects.length === 0) return;
  try {
    const plan = await api.deletePlan(objects);
    const simple = plan.cascade_links.length === 0 && plan.cleared.length === 0 && plan.rules === 0;
    if (simple && objects.length === 1) {
      await edit({ op: "delete", objects });
    } else {
      setState({ pendingDelete: { objects, plan } });
    }
  } catch (e) {
    notify(errorText(e), true);
  }
}

export async function confirmDelete() {
  const p = getState().pendingDelete;
  setState({ pendingDelete: null });
  if (p) await edit({ op: "delete", objects: p.objects });
}
