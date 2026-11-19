import { useEffect } from "react";
import { deleteObjects, redo, saveModel, undo } from "../actions/edit";
import { mapTools } from "../actions/mapTools";
import { askNewModel, chooseModel } from "../actions/model";
import { startRun } from "../actions/run";
import { zoomToSelection } from "../actions/selection";
import { stepBottomTab } from "../actions/views";
import { getState, setState, type State } from "../store";
import type { Tool } from "../uiTypes";

/** Id of the toolbar field that finds an object by its ID (Ctrl+F). */
export const FIND_INPUT_ID = "find-object";

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
  if (!ctrl || modal) return false;
  if (k === "f") {
    e.preventDefault();
    const input = document.getElementById(FIND_INPUT_ID) as HTMLInputElement | null;
    input?.focus();
    input?.select();
  } else if (k === "," && s.model) {
    e.preventDefault();
    setState({ dialog: "options" });
  } else if (e.code === "Quote" || k === "ù") {
    // The key right of L: ù on an AZERTY keyboard.
    e.preventDefault();
    if (!e.repeat) setState({ bottomMax: !s.bottomMax });
  } else return false;
  return true;
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

/** Map tools chosen by a single letter. */
const TOOL_KEYS: Record<string, Tool> = { s: "select", b: "box", l: "lasso", m: "move", v: "vertex" };

/** Single keys (no Ctrl / Alt) acting on the map: tools and view. Returns true when the key was one. */
function letterShortcut(e: KeyboardEvent, s: State): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === "?") {
    setState({ dialog: "shortcuts" });
    return true;
  }
  const k = e.key.toLowerCase();
  if (k.length !== 1 || !"sblmvputf".includes(k)) return false;
  if (!s.model || e.repeat) return true;
  const tool = TOOL_KEYS[k];
  if (tool) setState({ tool });
  // Same as the toolbar buttons: P turns the profile tool on or off, U the upstream highlight.
  else if (k === "p") setState({ tool: s.tool === "profile" ? "select" : "profile" });
  else if (k === "u") setState({ upstream: !s.upstream });
  else if (k === "t") setState({ labels: !s.labels });
  else if (k === "f") {
    if (!e.shiftKey) setState({ fitExtent: s.fitExtent + 1 });
    else if (s.selection.length > 0) zoomToSelection();
  }
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

/** Keyboard shortcuts of the application (listed for the user in `ShortcutsDialog`). */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      // The tabular editor keeps its keyboard focus in a hidden text area.
      const typing = (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") && !t.classList.contains("grid-keys");
      const s = getState();
      const modal = !!(s.dialog || s.tableEditor || s.pendingDelete || s.crsDialog);
      if (fileShortcut(e, s, modal) || typing || modal) return;
      // Alt+arrows go through the bottom panel tabs (before the arrows step in time).
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        stepBottomTab(e.key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (!timeShortcut(e, s) && !letterShortcut(e, s)) editShortcut(e, s);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
