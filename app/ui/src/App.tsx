import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onCacheProgress, onResultsChanged, onRunFinished, onRunOutput, onRunProgress, api } from "./api";
import { CrsDialog } from "./components/CrsDialog";
import { DataPanel } from "./components/DataPanel";
import { DeleteDialog, EnginesDialog, NewModelDialog, OptionsDialog, refreshEngine } from "./components/Dialogs";
import { PlotPanel } from "./components/PlotPanel";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { ReportPanel } from "./components/ReportPanel";
import { onFinished, onOutput, onProgress, RunPanel, startRun } from "./components/RunPanel";
import { StatusBar } from "./components/StatusBar";
import { StylePanel } from "./components/StylePanel";
import { TableEditor } from "./components/TableEditor";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { confirmDiscard, deleteObjects, redo, saveModel, undo } from "./edit";
import { MapView, mapTools } from "./map/MapView";
import { getState, setState, useStore } from "./store";

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

function useEvents() {
  useEffect(() => {
    const un = [
      onCacheProgress(({ path, progress }) => {
        const m = getState().model;
        if (!m?.results || m.results.path !== path) return;
        setState({ model: { ...m, results: { ...m.results, cache: { state: "building", progress } } } });
      }),
      onResultsChanged((results) => {
        const m = getState().model;
        if (m?.results?.path === results.path) setState({ model: { ...m, results } });
      }),
      onRunProgress(onProgress),
      onRunOutput(onOutput),
      onRunFinished(onFinished),
    ];
    refreshEngine();
    return () => un.forEach((p) => p.then((f) => f()));
  }, []);

  // Unsaved changes are not lost when the window closes.
  useEffect(() => {
    const w = getCurrentWindow();
    const un = w.onCloseRequested(async (e) => {
      if (!getState().model?.dirty) return;
      e.preventDefault();
      if (await confirmDiscard()) await w.destroy();
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
      const typing = t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA";
      const s = getState();
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // Shortcuts that also work in text fields.
      if (ctrl && k === "s") {
        e.preventDefault();
        saveModel(e.shiftKey);
        return;
      }
      if (typing || s.dialog || s.tableEditor || s.pendingDelete || s.crsDialog) return;
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
        deleteObjects(s.selection);
      } else if (e.key === "Backspace" && mapTools.current?.back()) {
        e.preventDefault();
      } else if (e.key === "Enter") {
        mapTools.current?.finish();
      } else if (e.key === " " && n > 0) {
        setState({ playing: !s.playing });
        e.preventDefault();
      } else if (e.key === "ArrowRight" && n > 0) setState({ period: Math.min(n - 1, s.period + s.stride) });
      else if (e.key === "ArrowLeft" && n > 0) setState({ period: Math.max(0, s.period - s.stride) });
      else if (e.key === "Escape") {
        if (mapTools.current?.cancel()) return;
        if (s.tool !== "select") setState({ tool: "select" });
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
    const t = setTimeout(() => {
      const m = getState().model;
      if (!m) return;
      m.project.ui = { ...m.project.ui, styles, labels };
      api.updateProject(undefined, m.project.ui).catch(() => {});
    }, 1000);
    return () => clearTimeout(t);
  }, [styles, labels]);
}

export function App() {
  useEvents();
  const crsDialog = useStore((s) => s.crsDialog);
  const dialog = useStore((s) => s.dialog);
  const bottomTab = useStore((s) => s.bottomTab);
  const sideTab = useStore((s) => s.sideTab);
  const running = useStore((s) => s.run.running);
  const reportIssues = useStore((s) => (s.model?.report ? s.model.report.errors.length : 0));
  const [sideW, setSideW] = useState(360);
  const [bottomH, setBottomH] = useState(260);

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <div className="center">
          <MapView />
          <Timeline />
          <Splitter vertical={false} onDrag={(d) => setBottomH((h) => Math.max(80, Math.min(window.innerHeight - 250, h - d)))} />
          <div className="bottom" style={{ height: bottomH }}>
            <div className="tabs">
              <button className={bottomTab === "plot" ? "active" : ""} onClick={() => setState({ bottomTab: "plot" })}>
                Time series
              </button>
              <button className={bottomTab === "report" ? "active" : ""} onClick={() => setState({ bottomTab: "report" })}>
                Report{reportIssues > 0 && <span className="badge bad">{reportIssues}</span>}
              </button>
              <button className={bottomTab === "run" ? "active" : ""} onClick={() => setState({ bottomTab: "run" })}>
                Run{running && <span className="badge warn">…</span>}
              </button>
            </div>
            <div className="tab-body">
              {bottomTab === "plot" ? <PlotPanel /> : bottomTab === "report" ? <ReportPanel /> : <RunPanel />}
            </div>
          </div>
        </div>
        <Splitter vertical onDrag={(d) => setSideW((w) => Math.max(240, Math.min(760, w - d)))} />
        <div className="sidebar" style={{ width: sideW }}>
          <div className="tabs">
            <button className={sideTab === "props" ? "active" : ""} onClick={() => setState({ sideTab: "props" })}>
              Properties
            </button>
            <button className={sideTab === "data" ? "active" : ""} onClick={() => setState({ sideTab: "data" })}>
              Data
            </button>
            <button className={sideTab === "style" ? "active" : ""} onClick={() => setState({ sideTab: "style" })}>
              Map style
            </button>
          </div>
          <div className="tab-body">
            {sideTab === "props" ? <PropertiesPanel /> : sideTab === "data" ? <DataPanel /> : <StylePanel />}
          </div>
        </div>
      </div>
      <StatusBar />
      {crsDialog && <CrsDialog />}
      {dialog === "options" && <OptionsDialog />}
      {dialog === "engines" && <EnginesDialog />}
      {dialog === "new" && <NewModelDialog />}
      <TableEditor />
      <DeleteDialog />
    </div>
  );
}
