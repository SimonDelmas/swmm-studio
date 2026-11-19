import { useEffect, useState } from "react";
import { askNewModel, chooseModel, openModel } from "../actions/model";
import { api, errorText } from "../api";
import { notify, useStore } from "../store";
import type { RecentFile, RecoveryInfo } from "../types";

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** The window without a model: open or create one, recover unsaved work, recent files. */
export function Welcome() {
  const busy = useStore((s) => s.busy !== null);
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [recoveries, setRecoveries] = useState<RecoveryInfo[]>([]);
  useEffect(() => {
    api.recentFiles().then(setRecent).catch(() => {});
    api.recoveries().then(setRecoveries).catch(() => {});
  }, []);
  const forget = (path: string) =>
    api
      .forgetRecentFile(path)
      .then(setRecent)
      .catch((e) => notify(errorText(e), true));
  const discard = (r: RecoveryInfo) =>
    api
      .discardRecovery(r.model)
      .then(() => setRecoveries((l) => l.filter((x) => x !== r)))
      .catch((e) => notify(errorText(e), true));

  return (
    <div className="welcome">
      <div className="welcome-box">
        <p>Open a SWMM model (.inp) to start.</p>
        <div className="row">
          <button className="primary" disabled={busy} onClick={chooseModel}>
            Open…
          </button>
          <button disabled={busy} onClick={askNewModel}>
            New model…
          </button>
        </div>
        {recoveries.length > 0 && (
          <>
            <h4>Unsaved work</h4>
            <p className="muted">SWMM Studio closed without saving these models. Open one to restore its changes.</p>
            <ul className="welcome-list">
              {recoveries.map((r) => (
                <li key={r.model}>
                  <button className="link" disabled={busy} title={r.model} onClick={() => openModel(r.model)}>
                    {fileName(r.model)}
                  </button>
                  <span className="muted">autosaved {r.saved_at}</span>
                  <button className="danger" disabled={busy} title="Give these changes up" onClick={() => discard(r)}>
                    Discard
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {recent.length > 0 && (
          <>
            <h4>Recent</h4>
            <ul className="welcome-list">
              {recent.map((f) => (
                <li key={f.path}>
                  <button
                    className="link"
                    disabled={busy || !f.exists}
                    title={f.exists ? f.path : `${f.path} (not found)`}
                    onClick={() => openModel(f.path)}
                  >
                    {f.name}
                  </button>
                  <span className="muted path">{f.path}</span>
                  <button className="menu-del" title="Remove from the list" onClick={() => forget(f.path)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
