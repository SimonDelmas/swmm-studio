import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { exportTable } from "../exporting";
import { getState, notify, setState, useStore } from "../store";
import type { BlockDto, MessageDto, ObjRef } from "../types";

const ROW_H = 22;

/** Continuity error thresholds (%): warning above the first, problem above the second. */
const CONTINUITY_WARN = 1;
const CONTINUITY_BAD = 5;

function selectAndZoom(o: ObjRef) {
  setState({ selection: [o], fitSelection: getState().fitSelection + 1 });
}

function Message({ m, kind }: { m: MessageDto; kind: "error" | "warning" }) {
  return (
    <div className={`msg msg-${kind}`}>
      <b>
        {kind === "error" ? "ERROR" : "WARNING"} {m.code}
      </b>{" "}
      {m.object ? (
        <a onClick={() => selectAndZoom(m.object!)} title="Select on the map">
          {m.text}
        </a>
      ) : (
        m.text
      )}
      {m.context && <div className="mono muted">{m.context}</div>}
    </div>
  );
}

/** Virtualized, sortable table. */
function Table({ block }: { block: BlockDto }) {
  const [sort, setSort] = useState<{ col: number; asc: boolean } | null>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(300);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    setSort(null);
    setScroll(0);
    if (box.current) box.current.scrollTop = 0;
  }, [block]);
  const rows = useMemo(() => {
    if (!sort) return block.rows;
    const num = (s: string | undefined) => {
      const v = Number(s);
      return Number.isFinite(v) ? v : null;
    };
    return [...block.rows].sort((a, b) => {
      const x = a[sort.col];
      const y = b[sort.col];
      const nx = num(x);
      const ny = num(y);
      const c = nx !== null && ny !== null ? nx - ny : (x ?? "").localeCompare(y ?? "");
      return sort.asc ? c : -c;
    });
  }, [block, sort]);
  const ncol = Math.max(block.columns.length, ...block.rows.slice(0, 50).map((r) => r.length));
  const cols = Array.from({ length: ncol }, (_, i) => block.columns[i] ?? "");
  const first = Math.max(0, Math.floor(scroll / ROW_H) - 10);
  const last = Math.min(rows.length, first + Math.ceil(height / ROW_H) + 20);
  const onRow = (r: string[]) => {
    if (!block.id_kind || !r[0]) return;
    api.findObject(r[0]).then((o) => o && selectAndZoom(o));
  };
  return (
    <div className="table-box" ref={box} onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)}>
      <table className="grid">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th
                key={i}
                onClick={() => setSort(sort?.col === i ? { col: i, asc: !sort.asc } : { col: i, asc: true })}
                title="Sort"
              >
                {c}
                {sort?.col === i ? (sort.asc ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr style={{ height: first * ROW_H }} />
          {rows.slice(first, last).map((r, i) => (
            <tr key={first + i} className={block.id_kind ? "link-row" : undefined} onClick={() => onRow(r)}>
              {cols.map((_, j) => (
                <td key={j} className={j > 0 && Number.isFinite(Number(r[j])) ? "num" : undefined}>
                  {r[j] ?? ""}
                </td>
              ))}
            </tr>
          ))}
          <tr style={{ height: (rows.length - last) * ROW_H }} />
          {block.footer.map((r, i) => (
            <tr key={`f${i}`} className="footer-row">
              {cols.map((_, j) => (
                <td key={j} className={j > 0 ? "num" : undefined}>
                  {r[j] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReportPanel() {
  const report = useStore((s) => s.model?.report ?? null);
  const hasModel = useStore((s) => s.model !== null);
  const [blockIndex, setBlockIndex] = useState<number>(-1);
  const [block, setBlock] = useState<BlockDto | null>(null);

  useEffect(() => {
    setBlockIndex(-1);
    setBlock(null);
  }, [report?.path]);

  useEffect(() => {
    if (blockIndex < 0) return setBlock(null);
    api
      .reportBlock(blockIndex)
      .then(setBlock)
      .catch((e) => notify(errorText(e), true));
  }, [blockIndex, report?.path]);

  if (!hasModel) return <div className="panel-empty">Open a model first.</div>;
  if (!report) {
    const openRpt = async () => {
      const path = await open({ filters: [{ name: "SWMM report", extensions: ["rpt"] }] });
      if (typeof path !== "string") return;
      api
        .openReport(path)
        .then((m) => setState({ model: m }))
        .catch((e) => notify(errorText(e), true));
    };
    return (
      <div className="panel-empty">
        No report loaded. <button onClick={openRpt}>Open report…</button>
      </div>
    );
  }

  return (
    <div className="report-panel">
      <div className="report-side">
        <div className="report-head">
          <div className="muted">{report.path}</div>
          {report.version && <div>SWMM {report.version}</div>}
          {report.analysis_begun && <div className="muted">Run {report.analysis_begun}</div>}
          {report.elapsed && <div className="muted">Elapsed {report.elapsed}</div>}
        </div>
        <div className={`summary-item ${blockIndex === -1 ? "active" : ""}`} onClick={() => setBlockIndex(-1)}>
          Summary
          {report.errors.length > 0 && <span className="badge bad">{report.errors.length}</span>}
          {report.warnings.length > 0 && <span className="badge warn">{report.warnings.length}</span>}
        </div>
        {report.blocks.map((b, i) => (
          <div
            key={i}
            className={`summary-item ${blockIndex === i ? "active" : ""}`}
            onClick={() => setBlockIndex(i)}
            title={`${b.rows} rows`}
          >
            {b.title}
            {b.kind === "table" && <span className="muted"> ({b.rows})</span>}
          </div>
        ))}
      </div>
      <div className="report-main">
        {blockIndex === -1 && (
          <div className="report-summary">
            <h4>Continuity errors</h4>
            {report.continuity.length === 0 && <div className="muted">None reported.</div>}
            <table className="kv">
              <tbody>
                {report.continuity.map(([name, v]) => {
                  const cls = Math.abs(v) > CONTINUITY_BAD ? "bad" : Math.abs(v) > CONTINUITY_WARN ? "warn" : "ok";
                  return (
                    <tr key={name}>
                      <td>{name}</td>
                      <td className={`num ${cls}`}>{v.toFixed(3)} %</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <h4>
              Errors ({report.errors.length}) and warnings ({report.warnings.length})
            </h4>
            {report.errors.map((m, i) => (
              <Message key={`e${i}`} m={m} kind="error" />
            ))}
            {report.warnings.slice(0, 500).map((m, i) => (
              <Message key={`w${i}`} m={m} kind="warning" />
            ))}
            {report.warnings.length > 500 && <div className="muted">… {report.warnings.length - 500} more warnings</div>}
          </div>
        )}
        {block && blockIndex >= 0 && (
          <div className="report-block">
            <div className="report-block-head">
              <h4>{block.title}</h4>
              {(block.kind === "table" || block.kind === "values") && (
                <button
                  onClick={() => {
                    const cols = Array.from({ length: Math.max(block.columns.length, ...block.rows.slice(0, 50).map((r) => r.length)) }, (_, i) => block.columns[i] ?? "");
                    exportTable(block.title.toLowerCase().replace(/[^a-z0-9]+/g, "_"), block.title, cols, [...block.rows, ...block.footer]);
                  }}
                >
                  Export
                </button>
              )}
            </div>
            {block.notes.length > 0 && <pre className="notes">{block.notes.join("\n")}</pre>}
            {(block.kind === "table" || block.kind === "values") && <Table block={block} />}
          </div>
        )}
      </div>
    </div>
  );
}
