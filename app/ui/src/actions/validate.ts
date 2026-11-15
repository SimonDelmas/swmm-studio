// Model checks: run after every edit, whatever panel is shown, so that the badge of the
// Issues tab is always that of the model as it is.

import { useEffect } from "react";
import { api, errorText } from "../api";
import { getState, setState, useStore } from "../store";
import type { Issue } from "../types";

/** Runs the model checks; the result is kept in the store. Errors are thrown. */
export async function validateModel(): Promise<Issue[]> {
  const revision = getState().model?.revision;
  try {
    const issues = await api.validate();
    // An answer for an earlier state of the model is dropped: a newer check follows.
    if (getState().model?.revision === revision) setState({ issues, issuesError: null });
    return issues;
  } catch (e) {
    if (getState().model?.revision === revision) setState({ issues: null, issuesError: errorText(e) });
    throw e;
  }
}

/** Checks the model when it is opened and after every edit (debounced). Mounted once, in the app. */
export function useModelChecks() {
  const path = useStore((s) => s.model?.path);
  const revision = useStore((s) => s.model?.revision ?? 0);
  useEffect(() => {
    if (!path) return;
    const t = setTimeout(() => void validateModel().catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [path, revision]);
}
