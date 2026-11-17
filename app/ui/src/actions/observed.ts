// Observed data of the objects: files of measured series linked to an object in the project,
// with the column of each variable.

import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { getState, setState } from "../store";
import type { ModelInfo, ObservedLink } from "../types";

/** Extensions of the files that can hold observed series. */
export const OBSERVED_EXTENSIONS = ["csv", "txt", "tsv", "dat", "prn", "xlsx", "xlsm", "xlsb", "xls", "ods", "parquet", "pq"];

const NONE: ObservedLink[] = [];

export function observedLinks(model: ModelInfo | null | undefined = getState().model): ObservedLink[] {
  return model?.project.observed ?? NONE;
}

/** The file linked to an object, if any. */
export function observedLink(kind: string, id: string, model = getState().model): ObservedLink | undefined {
  return observedLinks(model).find((l) => l.kind === kind && l.id === id);
}

/** For automated UI tests: the file the next choice gives, without the system dialog. */
export const observedChooser: { next: string | null } = { next: null };

/** Asks for a file of observed series. */
export async function chooseObservedFile(): Promise<string | null> {
  if (observedChooser.next) {
    const p = observedChooser.next;
    observedChooser.next = null;
    return p;
  }
  const path = await open({ filters: [{ name: "Time series (CSV, Excel, Parquet…)", extensions: OBSERVED_EXTENSIONS }] });
  return typeof path === "string" ? path : null;
}

/** Links a file to an object (null: removes the link) and keeps the project the back-end saved; errors are thrown. */
export async function saveObserved(kind: string, id: string, link: ObservedLink | null) {
  const info = await api.setObserved(kind, id, link);
  const m = getState().model;
  if (m && m.path === info.path) setState({ model: { ...m, project: info.project } });
}

/** File name of a path. */
export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
