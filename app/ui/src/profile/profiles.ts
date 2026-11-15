// Profiles: saved in the project, drawn from the map or the selection, and the path computed
// for the profile tab shown.

import { useEffect } from "react";
import { ensureIds } from "../actions/ids";
import { updateProjectUi } from "../actions/project";
import { api, errorText } from "../api";
import { currentProfileView, getState, notify, openProfileView, setState, showProfile, updateProfileView, useStore } from "../store";
import type { ObjRef } from "../types";

/** A profile saved in the project: its control nodes, by ID (indices change with edits). */
export interface SavedProfile {
  name: string;
  nodes: string[];
}

const NONE: SavedProfile[] = [];

export function savedProfiles(s = getState()): SavedProfile[] {
  const list = s.model?.project.ui.profiles;
  return Array.isArray(list) ? (list as SavedProfile[]) : NONE;
}

function storeProfiles(list: SavedProfile[]) {
  updateProjectUi({ profiles: list });
}

/** Saves the current profile under `name` (replaces a profile of the same name). */
export function saveProfile(name: string) {
  const { profile, profileNodes } = getState();
  if (!profile) return;
  const idOf = new Map(profile.nodes.map((n) => [n.index, n.id]));
  const nodes = profileNodes.map((i) => idOf.get(i)).filter((id): id is string => id !== undefined);
  storeProfiles([...savedProfiles().filter((p) => p.name !== name), { name, nodes }]);
}

export function deleteProfile(name: string) {
  storeProfiles(savedProfiles().filter((p) => p.name !== name));
}

/** Opens a saved profile: in the profile tab shown if it is still empty, else in a new tab. */
export async function loadProfile(name: string) {
  const saved = savedProfiles().find((p) => p.name === name);
  if (!saved) return;
  const refs = await Promise.all(saved.nodes.map((id) => api.findObject(id).catch(() => null)));
  const missing = saved.nodes.filter((_, i) => refs[i]?.kind !== "node");
  if (missing.length > 0) return notify(`Profile “${name}”: node${missing.length > 1 ? "s" : ""} ${missing.join(", ")} no longer in the model.`, true);
  const nodes = refs.map((r) => r!.index);
  const cur = currentProfileView();
  if (cur && cur.nodes.length < 2) updateProfileView(cur.id, { nodes, name });
  else openProfileView(nodes, name);
}

/**
 * Profile tool: the first click picks the start node, the second draws the profile in a new
 * tab (or the profile tab shown, if still empty); Shift+click extends the profile shown.
 */
export function profileClick(hit: ObjRef | null, shift: boolean) {
  if (hit?.kind !== "node") return;
  const { profileStart } = getState();
  const cur = currentProfileView();
  if (shift && profileStart === null && cur && cur.nodes.length >= 2) {
    if (cur.nodes[cur.nodes.length - 1] !== hit.index) updateProfileView(cur.id, { nodes: [...cur.nodes, hit.index] });
  } else if (profileStart === null || profileStart === hit.index) {
    setState({ profileStart: hit.index });
  } else {
    showProfile([profileStart, hit.index]);
  }
}

/** Computes the profile path whenever its nodes or the model change (mounted once, in the app). */
export function useProfile() {
  const nodes = useStore((s) => s.profileNodes);
  const revision = useStore((s) => s.model?.revision ?? 0);
  const resultsPath = useStore((s) => s.model?.results?.path);
  const cacheState = useStore((s) => s.model?.results?.cache.state);
  useEffect(() => {
    setState({ profile: null, profileError: null });
    if (nodes.length < 2) return;
    // The node names let the profiles follow their nodes when an edit changes the indices.
    void ensureIds(["node"]);
    let live = true;
    const t = setTimeout(() => {
      api
        .profile(nodes)
        .then((profile) => live && setState({ profile }))
        .catch((e) => live && setState({ profileError: errorText(e) }));
    }, 100);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [nodes, revision, resultsPath, cacheState]);
}

/** Draws the profile through the selected nodes (in selection order), in the profile tab shown or a new one. */
export function profileFromSelection() {
  const nodes = getState()
    .selection.filter((o) => o.kind === "node")
    .map((o) => o.index);
  if (nodes.length < 2) return notify("Select two nodes or more (Shift+click), in order along the profile.", true);
  showProfile(nodes, true);
}
