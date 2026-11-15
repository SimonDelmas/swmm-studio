import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { confirmDiscard } from "../actions/edit";
import { api } from "../api";
import { getState, useStore } from "../store";

/**
 * A running simulation is not stopped and unsaved changes are not lost by surprise when
 * the window closes. (The engine is killed with the app process in any case.)
 */
function useCloseGuard() {
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
}

/** Window title: the model name, with a * when it has unsaved changes. */
function useWindowTitle() {
  const name = useStore((s) => s.model?.name);
  const dirty = useStore((s) => s.model?.dirty);
  useEffect(() => {
    getCurrentWindow()
      .setTitle(name ? `${dirty ? "* " : ""}${name} – SWMM Studio` : "SWMM Studio")
      .catch(() => {});
  }, [name, dirty]);
}

/** The window of the application: its title and what closing it asks first. */
export function useWindow() {
  useCloseGuard();
  useWindowTitle();
}
