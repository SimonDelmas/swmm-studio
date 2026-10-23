import { useEffect, useRef, useState } from "react";
import { onCacheProgress, onResultsChanged, api } from "./api";
import { CrsDialog } from "./components/CrsDialog";
import { PlotPanel } from "./components/PlotPanel";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { ReportPanel } from "./components/ReportPanel";
import { StatusBar } from "./components/StatusBar";
import { StylePanel } from "./components/StylePanel";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { MapView } from "./map/MapView";
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
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, []);

  // Keyboard: Space play/pause, arrows step, Escape clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
      const s = getState();
      const n = s.model?.results?.n_periods ?? 0;
      if (e.key === " " && n > 0) {
        setState({ playing: !s.playing });
        e.preventDefault();
      } else if (e.key === "ArrowRight" && n > 0) setState({ period: Math.min(n - 1, s.period + s.stride) });
      else if (e.key === "ArrowLeft" && n > 0) setState({ period: Math.max(0, s.period - s.stride) });
      else if (e.key === "Escape") setState({ selection: [], tool: "select" });
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
  const bottomTab = useStore((s) => s.bottomTab);
  const reportIssues = useStore((s) => (s.model?.report ? s.model.report.errors.length : 0));
  const [sideW, setSideW] = useState(340);
  const [bottomH, setBottomH] = useState(260);
  const [sideTab, setSideTab] = useState<"props" | "style">("props");

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
            </div>
            <div className="tab-body">{bottomTab === "plot" ? <PlotPanel /> : <ReportPanel />}</div>
          </div>
        </div>
        <Splitter vertical onDrag={(d) => setSideW((w) => Math.max(220, Math.min(700, w - d)))} />
        <div className="sidebar" style={{ width: sideW }}>
          <div className="tabs">
            <button className={sideTab === "props" ? "active" : ""} onClick={() => setSideTab("props")}>
              Properties
            </button>
            <button className={sideTab === "style" ? "active" : ""} onClick={() => setSideTab("style")}>
              Map style
            </button>
          </div>
          <div className="tab-body">{sideTab === "props" ? <PropertiesPanel /> : <StylePanel />}</div>
        </div>
      </div>
      <StatusBar />
      {crsDialog && <CrsDialog />}
    </div>
  );
}
