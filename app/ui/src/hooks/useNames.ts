import { useEffect, useState } from "react";
import { api } from "../api";
import { latest } from "../latest";
import { useStore } from "../store";
import type { RefKind } from "../types";

/** Names of the objects of a kind (curves, patterns…), reloaded after every edit. */
export function useNames(kind: RefKind | null): string[] {
  const revision = useStore((s) => s.model?.revision ?? 0);
  const path = useStore((s) => s.model?.path);
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!kind || !path) return setNames([]);
    return latest(() => api.names(kind), setNames, () => setNames([]));
  }, [kind, revision, path]);
  return names;
}
