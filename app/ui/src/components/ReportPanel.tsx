import { Linkified, ObjLink } from "./ObjLink";
import { resolveName, useNameIndex } from "../hooks/useNameIndex";
import { selectObject } from "../actions/selection";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualRows } from "../hooks/useVirtualRows";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { exportTable } from "../exporting";
import { notify, setState, useStore } from "../store";
import type { BlockDto, MessageDto, ReportSummary } from "../types";
import { latest } from "../latest";


/** Continuity error thresholds (%): warning above the first, problem above the second. */
const CONTINUITY_WARN = 1;
const CONTINUITY_BAD = 5;

function Message({ m, kind }: { m: MessageDto; kind: "error" | "warning" }) {
  return (
    <div className={`msg msg-${kind}`}>
      <b>
        {kind === "error" ? "ERROR" : "WARNING"} {m.code}
      </b>{" "}
      <Linkified text={m.text} hint={m.object} whole />
      {m.context && (
        <div className="mono muted">
          <Linkified text={m.context} hint={m.object} />
        </div>
      )}
    </div>
  );
}

type Sort = { col: number; asc: boolean } | null;

/**
 * What a report tab shows, kept while another tab is open so that coming back finds it as
 * it was left: the section, the sort and scroll of its table, and the data already read.
 */
export interface ReportMemo {
  /** Report the rest belongs to (another report starts afresh). */
  path?: string;
  block: number;
  /** The data of the section shown. */
  data: BlockDto | null;
  sort: Sort;
  /** Scroll of the section list, of the summary and of the table. */
  side: number;
  main: number;
  table: number;
  /** A run's report and console, read once. */
  run?: { key: string; report: ReportSummary | null; error: string | null; console: string[] | null };
}

const memos = new Map<number, ReportMemo>();

/** The state kept for the report tab `id`. */
export function reportMemo(id: number): ReportMemo {
  let m = memos.get(id);
  if (!m) memos.set(id, (m = { block: -1, data: null, sort: null, side: 0, main: 0, table: 0 }));
  return m;
}

/** Forgets what the report tabs no longer open kept. */
export function pruneReportMemos(open: Set<number>) {
  for (const id of memos.keys()) if (!open.has(id)) memos.delete(id);
}

/** Virtualized, sortable table (a new one for each block: sort and scroll start afresh, or from `memo`). */
function Table({ block, memo }: { block: BlockDto; memo: ReportMemo }) {
  const [sort, setSortState] = useState<Sort>(memo.sort);
  const setSort = (s: Sort) => {
    memo.sort = s;
    setSortState(s);
  };
  const { box, onScroll, scrollTo, rowsInView } = useVirtualRows();
  // Back in the tab: the table is scrolled where it was.
  useLayoutEffect(() => {
    if (memo.table > 0) scrollTo(memo.table);
  }, []);
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
  const { first, last, before, after } = rowsInView(rows.length);
  const index = useNameIndex();
  const onRow = (r: string[]) => {
    const o = block.id_kind && r[0] ? resolveName(index, r[0], block.id_kind) : null;
    if (o) selectObject(o);
  };
  // Cells naming an object link to it: the first column of a table of objects, and text cells.
  const cell = (v: string | undefined, j: number) => {
    if (!v) return "";
    const named = (j === 0 && block.id_kind) || !Number.isFinite(Number(v));
    const o = named ? resolveName(index, v, j === 0 ? block.id_kind : null) : null;
    return o ? <ObjLink obj={o}>{v}</ObjLink> : v;
  };
  return (
    <div
      className="table-box"
      ref={box}
      onScroll={(e) => {
        memo.table = e.currentTarget.scrollTop;
        onScroll(e);
      }}
    >
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
          <tr style={{ height: before }} />
          {rows.slice(first, last).map((r, i) => (
            <tr key={first + i} className={block.id_kind ? "link-row" : undefined} onClick={() => onRow(r)}>
              {cols.map((_, j) => (
                <td key={j} className={j > 0 && Number.isFinite(Number(r[j])) ? "num" : undefined}>
                  {cell(r[j], j)}
                </td>
              ))}
            </tr>
          ))}
          <tr style={{ height: after }} />
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

/** The report of the loaded results, or a button to open one. */
export function ReportPanel({ memo }: { memo: ReportMemo }) {
  const report = useStore((s) => s.model?.report ?? null);
  const hasModel = useStore((s) => s.model !== null);
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
  return <ReportView report={report} source={null} memo={memo} />;
}

/**
 * A report: summary (continuity, errors and warnings) and its blocks, read from the
 * loaded report (`source` null) or from the report of a run (its path). `extra`: shown
 * at the top of the summary.
 */
export function ReportView({ report, source, extra, memo }: { report: ReportSummary; source: string | null; extra?: React.ReactNode; memo: ReportMemo }) {
  // Another report (results loaded again): it starts at its summary.
  if (memo.path !== report.path) Object.assign(memo, { path: report.path, block: -1, data: null, sort: null, main: 0, table: 0 });
  const [blockIndex, setBlockState] = useState<number>(memo.block);
  const [block, setBlockData] = useState<BlockDto | null>(memo.data);
  const setBlockIndex = (i: number) => {
    if (i === blockIndex) return;
    Object.assign(memo, { block: i, data: null, sort: null, main: 0, table: 0 });
    setBlockData(null);
    setBlockState(i);
  };
  const setBlock = (b: BlockDto | null) => {
    memo.data = b;
    setBlockData(b);
  };
  const shownPath = useRef(report.path);
  useEffect(() => {
    if (shownPath.current === report.path) return;
    shownPath.current = report.path;
    setBlockState(-1);
    setBlockData(null);
  }, [report.path]);

  useEffect(() => {
    if (blockIndex < 0) return setBlock(null);
    // Already read (back in the tab).
    if (memo.data) return;
    return latest(() => api.reportBlock(blockIndex, source), setBlock, (e) => notify(errorText(e), true));
  }, [blockIndex, report.path, source]);

  // Back in the tab: the section list and the summary are scrolled where they were.
  const side = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (side.current) side.current.scrollTop = memo.side;
    if (main.current) main.current.scrollTop = memo.main;
  }, []);

  return (
    <div className="report-panel">
      <div className="report-side" ref={side} onScroll={(e) => (memo.side = e.currentTarget.scrollTop)}>
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
      <div className="report-main" ref={main} onScroll={(e) => (memo.main = e.currentTarget.scrollTop)}>
        {blockIndex === -1 && (
          <div className="report-summary">
            {extra}
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
            {block.notes.length > 0 && (
              <pre className="notes">
                <Linkified text={block.notes.join("\n")} />
              </pre>
            )}
            {(block.kind === "table" || block.kind === "values") && <Table key={blockIndex} block={block} memo={memo} />}
          </div>
        )}
      </div>
    </div>
  );
}
