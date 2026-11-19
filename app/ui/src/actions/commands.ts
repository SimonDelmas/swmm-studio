// The commands of the application, as the command palette (Ctrl+P) lists them: what each
// does, its keyboard shortcut and when it can be used.

import { getState, setState, type State } from "../store";
import type { BottomTab, Tool } from "../uiTypes";
import { deleteObjects, redo, saveModel, undo } from "./edit";
import { askNewModel, chooseModel, chooseResults } from "./model";
import { cancelRun, startRun } from "./run";
import { zoomToSelection } from "./selection";
import { closeAllViewTabs, stepBottomTab, viewTabs } from "./views";

/** Id of the toolbar field that finds an object by its ID (Ctrl+F). */
export const FIND_INPUT_ID = "find-object";

/** Puts the keyboard in the "Find object ID" field of the toolbar. */
export function focusFind() {
  const input = document.getElementById(FIND_INPUT_ID) as HTMLInputElement | null;
  input?.focus();
  input?.select();
}

export interface Command {
  id: string;
  group: string;
  label: string;
  /** The keyboard shortcut, as `ShortcutsDialog` writes it. */
  keys?: string;
  /** Whether the command can be used now (always, when absent). */
  when?: (s: State) => boolean;
  run: () => unknown;
}

const hasModel = (s: State) => !!s.model;
// Nothing is opened or saved while a model or results are loading.
const idle = (s: State) => s.busy === null;
const editable = (s: State) => !!s.model && idle(s);
const hasResults = (s: State) => (s.model?.results?.n_periods ?? 0) > 0;

const tool = (t: Tool, label: string, keys?: string): Command => ({
  id: `tool.${t}`,
  group: t.startsWith("add-") ? "Add" : "Map tools",
  label,
  keys,
  when: (s) => hasModel(s) && s.tool !== t,
  run: () => setState({ tool: t, ...(t.startsWith("add-") ? { selection: [] } : {}) }),
});

const bottomTab = (t: BottomTab, label: string): Command => ({
  id: `bottom.${t}`,
  group: "Panels",
  label: `Bottom panel: ${label}`,
  when: (s) => s.bottomTab !== t,
  run: () => setState({ bottomTab: t }),
});

const sideTab = (t: State["sideTab"], label: string): Command => ({
  id: `side.${t}`,
  group: "Panels",
  label: `Side panel: ${label}`,
  when: (s) => s.sideTab !== t,
  run: () => setState({ sideTab: t }),
});

export const COMMANDS: Command[] = [
  // Project
  { id: "model.new", group: "Project", label: "New model", keys: "Ctrl+N", when: idle, run: askNewModel },
  { id: "model.open", group: "Project", label: "Open a model…", keys: "Ctrl+O", when: idle, run: chooseModel },
  { id: "model.save", group: "Project", label: "Save", keys: "Ctrl+S", when: editable, run: () => saveModel() },
  { id: "model.saveAs", group: "Project", label: "Save as…", keys: "Ctrl+Shift+S", when: editable, run: () => saveModel(true) },
  { id: "model.results", group: "Project", label: "Open results…", when: editable, run: chooseResults },
  { id: "model.crs", group: "Project", label: "Projection (coordinate system)…", when: editable, run: () => setState({ crsDialog: true }) },
  { id: "options", group: "Simulation", label: "Simulation options", keys: "Ctrl+,", when: hasModel, run: () => setState({ dialog: "options" }) },
  { id: "engines", group: "Simulation", label: "SWMM engines", run: () => setState({ dialog: "engines" }) },
  { id: "run.start", group: "Simulation", label: "Run the model", keys: "F5", when: (s) => hasModel(s) && !s.run.running, run: () => startRun() },
  { id: "run.cancel", group: "Simulation", label: "Cancel the run", when: (s) => s.run.running, run: cancelRun },
  { id: "help.shortcuts", group: "Help", label: "Keyboard shortcuts", keys: "?", run: () => setState({ dialog: "shortcuts" }) },
  // Edition
  { id: "edit.undo", group: "Edition", label: "Undo", keys: "Ctrl+Z", when: (s) => !!s.model?.undo, run: undo },
  { id: "edit.redo", group: "Edition", label: "Redo", keys: "Ctrl+Y", when: (s) => !!s.model?.redo, run: redo },
  {
    id: "edit.delete",
    group: "Edition",
    label: "Delete the selected objects",
    keys: "Delete",
    when: (s) => s.selection.length > 0,
    run: () => deleteObjects(getState().selection),
  },
  { id: "edit.query", group: "Edition", label: "Select by query…", keys: "Q", when: hasModel, run: () => setState({ dialog: "query" }) },
  { id: "edit.deselect", group: "Edition", label: "Clear the selection", when: (s) => s.selection.length > 0, run: () => setState({ selection: [] }) },
  tool("add-junction", "Add a junction"),
  tool("add-outfall", "Add an outfall"),
  tool("add-storage", "Add a storage unit"),
  tool("add-divider", "Add a flow divider"),
  tool("add-conduit", "Add a conduit"),
  tool("add-pump", "Add a pump"),
  tool("add-orifice", "Add an orifice"),
  tool("add-weir", "Add a weir"),
  tool("add-outlet", "Add an outlet"),
  tool("add-subcatchment", "Add a subcatchment"),
  tool("add-gage", "Add a rain gage"),
  // Map tools
  tool("select", "Select tool", "S"),
  tool("box", "Box selection tool", "B"),
  tool("lasso", "Lasso selection tool", "L"),
  tool("move", "Move tool", "M"),
  tool("vertex", "Edit vertices tool", "V"),
  {
    id: "tool.profile",
    group: "Map tools",
    label: "Longitudinal profile tool (on / off)",
    keys: "P",
    when: hasModel,
    run: () => setState((s) => ({ tool: s.tool === "profile" ? "select" : "profile" })),
  },
  {
    id: "upstream",
    group: "Map tools",
    label: "Upstream highlight (on / off)",
    keys: "U",
    when: hasModel,
    run: () => setState((s) => ({ upstream: !s.upstream })),
  },
  // View
  { id: "view.extent", group: "View", label: "Zoom to the whole model", keys: "F", when: hasModel, run: () => setState((s) => ({ fitExtent: s.fitExtent + 1 })) },
  { id: "view.selection", group: "View", label: "Zoom to the selection", keys: "Shift+F", when: (s) => s.selection.length > 0, run: zoomToSelection },
  { id: "view.labels", group: "View", label: "Labels (show / hide)", keys: "T", when: hasModel, run: () => setState((s) => ({ labels: !s.labels })) },
  { id: "view.find", group: "View", label: "Find an object by its ID", keys: "Ctrl+F", when: hasModel, run: focusFind },
  { id: "view.timeline", group: "View", label: "Timeline strip (show / hide)", when: hasResults, run: () => setState((s) => ({ timeline: !s.timeline })) },
  // Panels
  { id: "bottom.max", group: "Panels", label: "Maximize / restore the bottom panel", keys: "Ctrl+ù", run: () => setState((s) => ({ bottomMax: !s.bottomMax })) },
  { id: "bottom.next", group: "Panels", label: "Next tab of the bottom panel", keys: "Alt+→", run: () => stepBottomTab(1) },
  { id: "bottom.previous", group: "Panels", label: "Previous tab of the bottom panel", keys: "Alt+←", run: () => stepBottomTab(-1) },
  bottomTab("table", "Table"),
  bottomTab("issues", "Issues"),
  bottomTab("simulation", "Simulation"),
  bottomTab("events", "Events"),
  {
    id: "bottom.closeAll",
    group: "Panels",
    label: "Close all the time series, profile, comparison and report tabs",
    when: (s) => viewTabs(s).length > 0,
    run: closeAllViewTabs,
  },
  sideTab("props", "Properties"),
  sideTab("data", "Data"),
  sideTab("style", "Map style"),
  // Results
  { id: "time.play", group: "Results", label: "Play / pause", keys: "Space", when: hasResults, run: playPause },
  { id: "time.first", group: "Results", label: "First time step", keys: "Home", when: hasResults, run: () => setState({ period: 0 }) },
  {
    id: "time.last",
    group: "Results",
    label: "Last time step",
    keys: "End",
    when: hasResults,
    run: () => setState((s) => ({ period: (s.model?.results?.n_periods ?? 1) - 1 })),
  },
];

/** Plays the results (from the start when at the end) or pauses them. */
export function playPause() {
  const s = getState();
  const n = s.model?.results?.n_periods ?? 0;
  if (n === 0) return;
  setState(!s.playing && s.period >= n - 1 ? { playing: true, period: 0 } : { playing: !s.playing });
}

/** Ids of the commands run from the palette, the last first. */
let recent: string[] = [];

/** Runs a command chosen in the palette and remembers it (listed first next time). */
export function runCommand(c: Command) {
  recent = [c.id, ...recent.filter((id) => id !== c.id)].slice(0, 8);
  void c.run();
}

/** Lower case, without accents. */
const fold = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** How well `word` matches `text` (higher is better), null when it does not. */
function wordScore(word: string, label: string, other: string): number | null {
  const at = label.indexOf(word);
  if (at === 0) return 4;
  if (at > 0) return /\w/.test(label[at - 1]) ? 2 : 3;
  if (other.includes(word)) return 1;
  // Starts of words in order (as "zsel" for "Zoom to the selection").
  return byPrefixes(word, label.split(/[^\p{L}\p{N}]+/u).filter(Boolean), 0) ? 0.5 : null;
}

/** Whether `word` is made of the starts of some of `words` from `from`, in order. */
function byPrefixes(word: string, words: string[], from: number): boolean {
  if (word === "") return true;
  for (let j = from; j < words.length; j++)
    for (let k = Math.min(word.length, words[j].length); k > 0; k--)
      if (words[j].startsWith(word.slice(0, k)) && byPrefixes(word.slice(k), words, j + 1)) return true;
  return false;
}

/**
 * The commands usable now that match `query`: every word of it must be found in the label
 * (or the group or keys); the best matches come first. Without a query, the recent ones first.
 */
export function findCommands(query: string, s: State = getState(), commands: Command[] = COMMANDS): Command[] {
  const usable = commands.filter((c) => !c.when || c.when(s));
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    const rank = (c: Command) => {
      const i = recent.indexOf(c.id);
      return i < 0 ? Infinity : i;
    };
    return usable.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
  }
  const scored: { c: Command; score: number; i: number }[] = [];
  usable.forEach((c, i) => {
    const label = fold(c.label);
    const other = fold(`${c.group} ${c.keys ?? ""}`);
    let score = 0;
    for (const w of words) {
      const sc = wordScore(w, label, other);
      if (sc === null) return;
      score += sc;
    }
    scored.push({ c, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.c);
}
