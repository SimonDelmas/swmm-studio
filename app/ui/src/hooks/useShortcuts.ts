import { useEffect } from "react";
import { deleteObjects, redo, saveModel, undo } from "../actions/edit";
import { mapTools } from "../actions/mapTools";
import { askNewModel, chooseModel } from "../actions/model";
import { startRun } from "../actions/run";
import { getState, setState, type State } from "../store";

/** Shortcuts that also work while typing in a field. Returns true when the key was one. */
function fileShortcut(e: KeyboardEvent, s: State, modal: boolean): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && k === "s") {
    e.preventDefault();
    // Nothing is saved while a model or results are loading.
    if (!s.busy && !e.repeat) saveModel(e.shiftKey);
    return true;
  }
  if (ctrl && (k === "o" || k === "n") && !modal && !s.busy) {
    e.preventDefault();
    if (!e.repeat) void (k === "o" ? chooseModel() : askNewModel());
    return true;
  }
  return false;
}

/** Moving in time through the results: play / pause and steps. Returns true when the key was one. */
function timeShortcut(e: KeyboardEvent, s: State): boolean {
  const n = s.model?.results?.n_periods ?? 0;
  if (n === 0) return false;
  if (e.key === " ") {
    // Play at the end of the run starts over.
    setState(!s.playing && s.period >= n - 1 ? { playing: true, period: 0 } : { playing: !s.playing });
    e.preventDefault();
  } else if (e.key === "ArrowRight") setState({ period: Math.min(n - 1, s.period + s.stride) });
  else if (e.key === "ArrowLeft") setState({ period: Math.max(0, s.period - s.stride) });
  else if (e.key === "Home") setState({ period: 0 });
  else if (e.key === "End") setState({ period: n - 1 });
  else return false;
  return true;
}

/** Editing and the map tools. */
function editShortcut(e: KeyboardEvent, s: State) {
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && k === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (ctrl && (k === "y" || (k === "z" && e.shiftKey))) {
    e.preventDefault();
    redo();
  } else if (e.key === "F5") {
    e.preventDefault();
    startRun();
  } else if (e.key === "Delete" && !mapTools.current?.busy && s.selection.length > 0) {
    e.preventDefault();
    // A held key must not ask twice for the same objects (their indices change once deleted).
    if (!e.repeat) deleteObjects(s.selection);
  } else if (e.key === "Backspace" && mapTools.current?.back()) {
    e.preventDefault();
  } else if (!ctrl && !e.altKey && (k === "p" || k === "u")) {
    // Same as the toolbar buttons: P turns the profile tool on or off, U the upstream highlight.
    if (!s.model || e.repeat) return;
    if (k === "p") setState({ tool: s.tool === "profile" ? "select" : "profile" });
    else setState({ upstream: !s.upstream });
  } else if (e.key === "Enter") {
    mapTools.current?.finish();
  } else if (e.key === "Escape") {
    // Each press steps back once: the shape being drawn, the profile start, the tool, the selection.
    if (mapTools.current?.cancel()) return;
    if (s.profileStart !== null) setState({ profileStart: null });
    else if (s.tool !== "select") setState({ tool: "select" });
    else setState({ selection: [] });
  }
}

/** Keyboard shortcuts of the application. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      // The tabular editor keeps its keyboard focus in a hidden text area.
      const typing = (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") && !t.classList.contains("grid-keys");
      const s = getState();
      const modal = !!(s.dialog || s.tableEditor || s.pendingDelete || s.crsDialog);
      if (fileShortcut(e, s, modal) || typing || modal) return;
      if (!timeShortcut(e, s)) editShortcut(e, s);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
