import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { askNewModel, chooseModel, openModel } from "./actions/model";
import { updateProjectUi } from "./actions/project";
import { onFinished, onOutput, onProgress, startRun } from "./actions/run";
import { useModelChecks } from "./actions/validate";
import { onCacheProgress, onOpenFile, onResultsChanged, onRunFinished, onRunOutput, onRunProgress, api } from "./api";
import { ClimateDialog } from "./components/ClimateDialog";
import { CrsDialog } from "./components/CrsDialog";
import { BottomPanel } from "./components/BottomPanel";
import { useProfile } from "./profile/profiles";
import { RunsPanel } from "./components/RunsPanel";
import { SectionsDialog } from "./components/SectionsDialog";
import { DataPanel } from "./components/DataPanel";
import { refreshEngine } from "./actions/engines";
import { DeleteDialog } from "./components/DeleteDialog";
import { NewModelDialog } from "./components/NewModelDialog";
import { OptionsDialog } from "./components/OptionsDialog";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { ReportPanel } from "./components/ReportPanel";
import { RunPanel } from "./components/RunPanel";
import { StatusBar } from "./components/StatusBar";
import { StylePanel } from "./components/StylePanel";
import { TableEditor } from "./components/TableEditor";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { confirmDiscard, deleteObjects, redo, saveModel, undo } from "./edit";
import { MapView, mapTools } from "./map/MapView";
import { getState, setState, useStore, type SimTab } from "./store";

/** Drag handle that resizes a panel. */
function Splitter({ vertical, onDrag }: { vertical: boolean; onDrag: (delta: number) => void }) {
  const last = useRef(0);
  return (
    <div
      className={vertical ? "splitter-v" : "splitter-h"}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        last.current = vertical ? e.clientX : e.clientY;
      }}
      onPointerMove={(e) => {
        if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
        const p = vertical ? e.clientX : e.clientY;
        onDrag(p - last.current);
        last.current = p;
      }}
    />
  );
}

let launchFileOpened = false;

function useEvents() {
  useEffect(() => {
    const un = [
      onCacheProgress(({ path, progress }) => {
        const m = getState().model;
        if (!m) return;
        const cache = { state: "building" as const, progress };
        if (m.results?.path === path) setState({ model: { ...m, results: { ...m.results, cache } } });
        else if (m.compare?.path === path) setState({ model: { ...m, compare: { ...m.compare, cache } } });
      }),
      onResultsChanged((r) => {
        const m = getState().model;
        if (m?.results?.path === r.path) setState({ model: { ...getState().model!, results: r } });
        if (m?.compare?.path === r.path) setState({ model: { ...getState().model!, compare: r } });
      }),
      onRunProgress(onProgress),
      onRunOutput(onOutput),
      onRunFinished(onFinished),
    ];
    refreshEngine();
    return () => un.forEach((p) => p.then((f) => f()));
  }, []);

  // File association: the model the app was launched with, or sent by a second launch.
  useEffect(() => {
    const open = async (path: string) => {
      if (await confirmDiscard()) await openModel(path);
    };
    // Once per page load: not again when the app is rendered anew after an error.
    if (!launchFileOpened) {
      launchFileOpened = true;
      api.launchFile().then((p) => {
        if (p) void open(p);
      });
    }
    const un = onOpenFile(open);
    return () => {
      un.then((f) => f());
    };
  }, []);

  // A running simulation is not stopped and unsaved changes are not lost by surprise
  // when the window closes. (The engine is killed with the app process in any case.)
  useEffect(() => {
    const w = getCurrentWindow();
    const un = w.onCloseRequested(async (e) => {
      const s = getState();
      if (!s.run.running && !s.model?.dirty) return;
      e.preventDefault();
      if (getState().run.running) {
        const quit = await ask("A simulation is running. Quitting will stop it and its results will be lost.", {
          title: "SWMM Studio",
          kind: "warning",
          okLabel: "Stop and quit",
          cancelLabel: "Keep running",
        });
        if (!quit) return;
      }
      if (!(await confirmDiscard())) return;
      if (getState().run.running) await api.runCancel().catch(() => {});
      await w.destroy();
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Window title: model name, * when modified.
  const name = useStore((s) => s.model?.name);
  const dirty = useStore((s) => s.model?.dirty);
  useEffect(() => {
    getCurrentWindow()
      .setTitle(name ? `${dirty ? "* " : ""}${name} – SWMM Studio` : "SWMM Studio")
      .catch(() => {});
  }, [name, dirty]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      // The tabular editor keeps its keyboard focus in a hidden text area.
      const typing = (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") && !t.classList.contains("grid-keys");
      const s = getState();
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // Shortcuts that also work in text fields.
      if (ctrl && k === "s") {
        e.preventDefault();
        saveModel(e.shiftKey);
        return;
      }
      const modal = s.dialog || s.tableEditor || s.pendingDelete || s.crsDialog;
      if (ctrl && (k === "o" || k === "n") && !modal && !s.busy) {
        e.preventDefault();
        if (!e.repeat) void (k === "o" ? chooseModel() : askNewModel());
        return;
      }
      if (typing || modal) return;
      const n = s.model?.results?.n_periods ?? 0;
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
      } else if (e.key === " " && n > 0) {
        // Play at the end of the run starts over.
        setState(!s.playing && s.period >= n - 1 ? { playing: true, period: 0 } : { playing: !s.playing });
        e.preventDefault();
      } else if (e.key === "ArrowRight" && n > 0) setState({ period: Math.min(n - 1, s.period + s.stride) });
      else if (e.key === "ArrowLeft" && n > 0) setState({ period: Math.max(0, s.period - s.stride) });
      else if (e.key === "Home" && n > 0) setState({ period: 0 });
      else if (e.key === "End" && n > 0) setState({ period: n - 1 });
      else if (e.key === "Escape") {
        if (mapTools.current?.cancel()) return;
        if (s.profileStart !== null) setState({ profileStart: null });
        else if (s.tool !== "select") setState({ tool: "select" });
        else setState({ selection: [] });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Save styles in the project (debounced).
  const styles = useStore((s) => s.styles);
  const labels = useStore((s) => s.labels);
  useEffect(() => {
    const path = getState().model?.path;
    const t = setTimeout(() => updateProjectUi({ styles, labels }, path), 1000);
    return () => clearTimeout(t);
  }, [styles, labels]);
}

const SIM_TABS: [SimTab, string, string][] = [
  ["run", "Console", "Run the model and follow its output"],
  ["runs", "Runs", "Previous runs: load or compare their results"],
  ["report", "Report", "Report of the loaded results"],
];

/** Side panel tab: run the model, previous runs and their reports. */
function SimulationPanel() {
  const simTab = useStore((s) => s.simTab);
  const running = useStore((s) => s.run.running);
  const reportIssues = useStore((s) => (s.model?.report ? s.model.report.errors.length : 0));
  return (
    <div className="sim-panel">
      <div className="sub-tabs">
        {SIM_TABS.map(([t, label, title]) => (
          <button key={t} className={simTab === t ? "active" : ""} title={title} onClick={() => setState({ simTab: t })}>
            {label}
            {t === "run" && running && <span className="badge warn">…</span>}
            {t === "report" && reportIssues > 0 && <span className="badge bad">{reportIssues}</span>}
          </button>
        ))}
      </div>
      <div className="sim-body">{simTab === "run" ? <RunPanel /> : simTab === "runs" ? <RunsPanel /> : <ReportPanel />}</div>
    </div>
  );
}

export function App() {
  useEvents();
  useProfile();
  useModelChecks();
  const crsDialog = useStore((s) => s.crsDialog);
  const dialog = useStore((s) => s.dialog);
  const bottomMax = useStore((s) => s.bottomMax);
  const sideTab = useStore((s) => s.sideTab);
  const running = useStore((s) => s.run.running);
  const reportIssues = useStore((s) => (s.model?.report ? s.model.report.errors.length : 0));
  const [sideW, setSideW] = useState(360);
  // Null: 40 % of the centre (60 % for the map) until dragged.
  const [bottomH, setBottomH] = useState<number | null>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // From the current height (also when maximized), up to hiding the map.
  const dragBottom = (d: number) => {
    const c = centerRef.current;
    const b = bottomRef.current;
    if (!c || !b) return;
    const timeline = c.querySelector<HTMLElement>(".timeline")?.offsetHeight ?? 0;
    const max = c.clientHeight - timeline - 5;
    if (getState().bottomMax) setState({ bottomMax: false });
    setBottomH(Math.max(80, Math.min(max, b.offsetHeight - d)));
  };
  const sideTabs: [typeof sideTab, string][] = [
    ["props", "Properties"],
    ["data", "Data"],
    ["style", "Map style"],
    ["simulation", "Simulation"],
  ];

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <div ref={centerRef} className={bottomMax ? "center bottom-max" : "center"}>
          <MapView />
          <Timeline />
          <Splitter vertical={false} onDrag={dragBottom} />
          <div ref={bottomRef} className="bottom" style={{ height: bottomMax ? undefined : (bottomH ?? "40%") }}>
            <BottomPanel />
          </div>
        </div>
        <Splitter vertical onDrag={(d) => setSideW((w) => Math.max(240, Math.min(760, w - d)))} />
        <div className="sidebar" style={{ width: sideW }}>
          <div className="tabs">
            {sideTabs.map(([t, label]) => (
              <button key={t} className={sideTab === t ? "active" : ""} onClick={() => setState({ sideTab: t })}>
                {label}
                {t === "simulation" && sideTab !== t && running && <span className="badge warn">…</span>}
                {t === "simulation" && sideTab !== t && !running && reportIssues > 0 && <span className="badge bad">{reportIssues}</span>}
              </button>
            ))}
          </div>
          <div className="tab-body">
            {sideTab === "props" ? (
              <PropertiesPanel />
            ) : sideTab === "data" ? (
              <DataPanel />
            ) : sideTab === "style" ? (
              <StylePanel />
            ) : (
              <SimulationPanel />
            )}
          </div>
        </div>
      </div>
      <StatusBar />
      {crsDialog && <CrsDialog />}
      {dialog === "options" && <OptionsDialog />}
      {dialog === "engines" && <OptionsDialog initialTab="Engine" />}
      {dialog === "new" && <NewModelDialog />}
      {dialog === "climate" && <ClimateDialog />}
      {dialog === "sections" && <SectionsDialog />}
      <TableEditor />
      <DeleteDialog />
    </div>
  );
}
