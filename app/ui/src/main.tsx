import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyCrs, openModel } from "./actions/model";
import { startRun } from "./actions/run";
import { validateModel } from "./actions/validate";
import { api } from "./api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { edit, redo, saveModel, tryEdit, undo } from "./actions/edit";
import { loadPlotView, savePlotView } from "./plot/savedViews";
import { addToPlot } from "./plot/series";
import { profileFromSelection } from "./profile/profiles";
import { applyStyle } from "./actions/style";
import { mapPerf } from "./map/useMapLayers";
import { mapProject } from "./map/useViewer";
import { currentPlotView } from "./actions/views";
import { getState, setState } from "./store";
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
