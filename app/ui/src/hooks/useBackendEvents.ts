import { useEffect } from "react";
import { confirmDiscard } from "../actions/edit";
import { refreshEngine } from "../actions/engines";
import { openModel } from "../actions/model";
import { onFinished, onOutput, onProgress } from "../actions/run";
import { api, onCacheProgress, onOpenFile, onResultsChanged, onRunFinished, onRunOutput, onRunProgress } from "../api";
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
}

/** File association: opens the model the app was launched with, or sent by a second launch. */
function useOpenedFiles() {
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
}

/** Keeps the state in step with the events of the backend. */
export function useBackendEvents() {
  useResultsAndRunEvents();
  useOpenedFiles();
}
