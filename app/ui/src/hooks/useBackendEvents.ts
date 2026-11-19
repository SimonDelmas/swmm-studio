import { useEffect } from "react";
import { confirmDiscard } from "../actions/edit";
import { refreshEngine } from "../actions/engines";
import { openModel } from "../actions/model";
import { onFinished, onOutput, onProgress } from "../actions/run";
import { api, onCacheProgress, onResultsChanged, onRunFinished, onRunOutput, onRunProgress } from "../api";
import { getState, setState } from "../store";

let launchFileOpened = false;

/** Follows what the backend reports: cache builds, results that changed on disk, the run. */
function useResultsAndRunEvents() {
  useEffect(() => {
    const un = [
      onCacheProgress(({ path, progress }) => {
        const m = getState().model;
        if (!m) return;
        const cache = { state: "building" as const, progress };
        if (m.results?.path === path) setState({ model: { ...m, results: { ...m.results, cache } } });
        else if (m.compare?.path === path) setState({ model: { ...m, compare: { ...m.compare, cache } } });
        else if (m.overlays.some((o) => o.path === path))
          setState({ model: { ...m, overlays: m.overlays.map((o) => (o.path === path ? { ...o, cache } : o)) } });
      }),
      onResultsChanged((r) => {
        const m = getState().model;
        if (m?.results?.path === r.path) setState({ model: { ...getState().model!, results: r } });
        if (m?.compare?.path === r.path) setState({ model: { ...getState().model!, compare: r } });
        if (m?.overlays.some((o) => o.path === r.path)) {
          const cur = getState().model!;
          setState({ model: { ...cur, overlays: cur.overlays.map((o) => (o.path === r.path ? r : o)) } });
        }
      }),
      onRunProgress(onProgress),
      onRunOutput(onOutput),
      onRunFinished(onFinished),
    ];
    refreshEngine();
    return () => un.forEach((p) => p.then((f) => f()));
  }, []);
}

/** File association: opens the model the app was launched with (each launch is its own instance). */
function useLaunchFile() {
  useEffect(() => {
    // Once per page load: not again when the app is rendered anew after an error.
    if (launchFileOpened) return;
    launchFileOpened = true;
    api.launchFile().then(async (p) => {
      if (p && (await confirmDiscard())) await openModel(p);
    });
  }, []);
}

/** Keeps the state in step with the events of the backend. */
export function useBackendEvents() {
  useResultsAndRunEvents();
  useLaunchFile();
}
