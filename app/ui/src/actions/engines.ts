// The SWMM engine a run would use.

import { api } from "../api";
import { setState } from "../store";
import type { EnginesDto } from "../types";

/** Reloads the engine registry and remembers the engine a run would use. */
export async function refreshEngine(): Promise<EnginesDto | null> {
  try {
    const e = await api.engines();
    setState({ engine: e.effective });
    return e;
  } catch {
    return null;
  }
}
