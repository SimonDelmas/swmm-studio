import { createRoot } from "react-dom/client";
import { App } from "./App";
import { api } from "./api";
import { applyCrs } from "./components/CrsDialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { startRun } from "./components/RunPanel";
import { edit, redo, saveModel, tryEdit, undo } from "./edit";
import { addToPlot, loadPlotView, savePlotView } from "./components/PlotPanel";
import { validateModel } from "./components/IssuesPanel";
import { profileFromSelection } from "./components/ProfilePanel";
import { applyStyle } from "./components/StylePanel";
import { openModel } from "./components/Toolbar";
import { mapPerf, mapProject } from "./map/MapView";
import { currentPlotView, getState, setState } from "./store";
import "./styles.css";

// Entry points for automated UI tests (e2e/smoke.mjs drives the app over CDP).
(window as unknown as { swmmStudio: unknown }).swmmStudio = {
  api,
  openModel,
  applyCrs,
  applyStyle,
  addToPlot,
  savePlotView,
  loadPlotView,
  currentPlotView: () => currentPlotView(getState()),
  getState,
  setState,
  mapPerf,
  mapProject: (p: [number, number]) => mapProject.current?.(p) ?? null,
  edit,
  tryEdit,
  undo,
  redo,
  saveModel,
  startRun,
  validateModel,
  profileFromSelection,
};

// A render error shows its message (ErrorBoundary) instead of an empty window.
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
