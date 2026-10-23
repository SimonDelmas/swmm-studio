import { useEffect } from "react";
import { api, errorText } from "../api";
import { notify, setState, useStore } from "../store";

export function StatusBar() {
  const model = useStore((s) => s.model);
  const selection = useStore((s) => s.selection);
  const message = useStore((s) => s.message);
  const busy = useStore((s) => s.busy);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setState({ message: null }), message.error ? 10000 : 5000);
    return () => clearTimeout(t);
  }, [message]);

  const r = model?.results;
  let cache: React.ReactNode = null;
  if (r) {
    const c = r.cache;
    if (c.state === "building")
      cache = (
        <span title="Results cache: object-major copy for fast time series">
          Building results cache {Math.round(c.progress * 100)}%
          <span className="progress">
            <span style={{ width: `${c.progress * 100}%` }} />
          </span>
        </span>
      );
    else if (c.state === "ready") cache = <span className="muted">Results cache ready</span>;
    else
      cache = (
        <span className="warn" title={c.message}>
          No results cache: {c.message}{" "}
          {c.state === "failed" && (
            <a
              onClick={() =>
                api
                  .rebuildCache()
                  .then((m) => setState({ model: m }))
                  .catch((e) => notify(errorText(e), true))
              }
            >
              retry
            </a>
          )}
        </span>
      );
  }
  return (
    <div className="statusbar">
      {busy && <span className="busy">{busy}</span>}
      {model && (
        <span title={model.path}>
          {model.name} · {model.counts.nodes} nodes · {model.counts.links} links · {model.counts.subcatchments} subcatchments ·{" "}
          {model.flow_units}
        </span>
      )}
      {model && model.missing_coordinates > 0 && <span className="warn">{model.missing_coordinates} nodes without coordinates</span>}
      {model && model.unprojected > 0 && <span className="warn">{model.unprojected} points outside the CRS domain</span>}
      {r && (
        <span title={r.path}>
          Results: {r.n_periods} periods · matched {r.matched.node ?? 0}/{r.in_file.node ?? 0} nodes, {r.matched.link ?? 0}/
          {r.in_file.link ?? 0} links
        </span>
      )}
      {cache}
      {selection.length > 0 && <span>{selection.length} selected</span>}
      <span className="grow" />
      {message && <span className={message.error ? "bad" : ""}>{message.text}</span>}
    </div>
  );
}
