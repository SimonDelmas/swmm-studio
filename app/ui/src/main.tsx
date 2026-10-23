import { createRoot } from "react-dom/client";
import { App } from "./App";
import { api } from "./api";
import { applyCrs } from "./components/CrsDialog";
import { addToPlot } from "./components/PlotPanel";
import { applyStyle } from "./components/StylePanel";
import { openModel } from "./components/Toolbar";
import { mapPerf } from "./map/MapView";
import { getState, setState } from "./store";
import "./styles.css";

// Entry points for automated UI tests (e2e/smoke.mjs drives the app over CDP).
(window as unknown as { swmmStudio: unknown }).swmmStudio = {
  api,
  openModel,
  applyCrs,
  applyStyle,
  addToPlot,
  getState,
  setState,
  mapPerf,
};

createRoot(document.getElementById("root")!).render(<App />);
