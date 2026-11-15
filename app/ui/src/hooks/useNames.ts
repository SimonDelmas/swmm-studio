import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { RefKind } from "../types";

/** Names of the objects of a kind (curves, patterns…), reloaded after every edit. */
export function useNames(kind: RefKind | null): string[] {
  const revision = useStore((s) => s.model?.revision ?? 0);
  const path = useStore((s) => s.model?.path);
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!kind || !path) return setNames([]);
    // The names of a kind asked for earlier, answered late, are dropped.
    let current = true;
    api.names(kind).then(
      (n) => current && setNames(n),
      () => current && setNames([]),
    );
    return () => {
      current = false;
    };
  }, [kind, revision, path]);
  return names;
}
