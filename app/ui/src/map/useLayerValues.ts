import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { notify, type LayerStyle, type StyledKind } from "../store";

/**
 * Values used to colour a layer: an input attribute, or a result variable at the current
 * period. Frame requests are coalesced: while one is in flight only the latest wanted
 * period is kept, so playback runs as fast as the backend answers.
 */
export function useLayerValues(
  kind: StyledKind,
  style: LayerStyle,
  period: number,
  resultsKey: string | null,
  modelKey: string | null,
): Float32Array | null {
  const [values, setValues] = useState<Float32Array | null>(null);
  const req = useRef<{ busy: boolean; next: { v: number; p: number; token: number } | null; token: number }>({
    busy: false,
    next: null,
    token: 0,
  });

  // Attribute or no colouring: (re)load when the choice or the model changes.
  useEffect(() => {
    req.current.token++;
    if (style.source === "type" || !style.field) {
      setValues(null);
      return;
    }
    if (style.source === "attribute") {
      const token = req.current.token;
      api
        .attribute(kind, style.field)
        .then((v) => token === req.current.token && setValues(v))
        .catch((e) => notify(errorText(e), true));
    }
  }, [kind, style.source, style.field, modelKey]);

  useEffect(() => {
    if (style.source !== "result" || !resultsKey || style.field === "") return;
    const load = (v: number, p: number, token: number) => {
      const r = req.current;
      if (r.busy) {
        r.next = { v, p, token };
        return;
      }
      r.busy = true;
      api
        .frame(kind, v, p)
        .then((f) => token === r.token && setValues(f))
        .catch((e) => notify(errorText(e), true))
        .finally(() => {
          r.busy = false;
          const n = r.next;
          r.next = null;
          if (n && n.token === r.token) load(n.v, n.p, n.token);
        });
    };
    load(Number(style.field), period, req.current.token);
  }, [kind, style.source, style.field, period, resultsKey]);

  return values;
}
