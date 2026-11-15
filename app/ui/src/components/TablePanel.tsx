import { useEffect, useMemo, useRef, useState } from "react";
import { ROW_HEIGHT, useVirtualRows } from "../hooks/useVirtualRows";
import { api, errorText } from "../api";
import { edit } from "../actions/edit";
import { exportTable } from "../exporting";
import { notify, setState, useStore } from "../store";
import type { Grid } from "../analysisTypes";
import type { GridCell } from "../types";
import { latest } from "../latest";
import { GRID_SECTIONS, pastedCells, rangeLines, rowsShown, withCells, type Cell, type Sort } from "./tables/gridData";

/** The grid of a section of the open model, reloaded after every edit, and how to edit its cells. */
function useGrid(section: string) {
  const path = useStore((s) => s.model?.path);
  const revision = useStore((s) => s.model?.revision ?? 0);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) return;
    // A short wait: one reload for a burst of edits.
    return latest(
      () => api.grid(section),
      (g) => (setGrid(g), setError(null)),
      (e) => setError(errorText(e)),
      120,
    );
  }, [section, revision, path]);

  /** Edits cells; the table shows the new values at once (the reload that follows confirms them). */
  const setCells = async (cells: GridCell[]) => {
    if (!grid) return;
    const o = await edit({ op: "set_cells", section: grid.section, cells });
    if (o) setGrid((g) => (g && g.section === grid.section ? withCells(g, cells) : g));
  };
  return { grid, error, setCells };
}

/** Spreadsheet-like editor of one section: one row per line, one column per field. */
export function TablePanel() {
  const hasModel = useStore((s) => !!s.model);
  const selection = useStore((s) => s.selection);
  const [section, setSection] = useState("CONDUITS");
  const { grid, error, setCells } = useGrid(section);
  const [filter, setFilter] = useState("");
  const [selOnly, setSelOnly] = useState(false);
  const [sort, setSort] = useState<Sort | null>(null);
  const [active, setActive] = useState<Cell | null>(null);
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // Keyboard focus lives in a hidden text area: clipboard events always reach an
  // editable element (a focused div gets none when nothing is selected).
  const keys = useRef<HTMLTextAreaElement>(null);
  const focusKeys = () => {
    const k = keys.current;
    if (!k) return;
    k.focus({ preventScroll: true });
    k.select();
  };
  const { box, onScroll, rowsInView, height } = useVirtualRows(grid !== null);

  useEffect(() => {
    setActive(null);
    setAnchor(null);
    setEditing(null);
    setSort(null);
  }, [section]);

  /** Rows of the objects selected on the map. */
  const selected = useMemo(() => {
    if (!grid) return new Set<number>();
    return new Set(selection.filter((o) => o.kind === grid.object_kind).map((o) => o.index));
  }, [grid, selection]);

  // Rows shown: filtered (text, selection) and sorted.
  const view = useMemo(() => (grid ? rowsShown(grid, filter, selOnly ? selected : null, sort) : []), [grid, filter, selOnly, selected, sort]);

  if (!hasModel) return <div className="panel-empty">Open a model first.</div>;

  const ncol = grid?.columns.length ?? 0;
  const inRange = (r: number, c: number) => {
    if (!active) return false;
    const a = anchor ?? active;
    return r >= Math.min(a.r, active.r) && r <= Math.max(a.r, active.r) && c >= Math.min(a.c, active.c) && c <= Math.max(a.c, active.c);
  };
  const rowOf = (r: number) => grid!.rows[view[r]];
  const scrollTo = (r: number) => {
    const el = box.current;
    if (!el) return;
    const top = (r + 1) * ROW_HEIGHT;
    if (top < el.scrollTop + ROW_HEIGHT) el.scrollTop = top - ROW_HEIGHT;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  };
  const move = (dr: number, dc: number, extend: boolean) => {
    if (!active) return;
    const next = { r: Math.max(0, Math.min(view.length - 1, active.r + dr)), c: Math.max(0, Math.min(ncol - 1, active.c + dc)) };
    if (!extend) setAnchor(null);
    else if (!anchor) setAnchor(active);
    setActive(next);
    scrollTo(next.r);
  };
  const commit = async (value: string, then?: () => void) => {
    setEditing(null);
    if (!grid || !active) return;
    const row = rowOf(active.r);
    const col = grid.columns[active.c];
    if (row.cells[active.c] === null || row.cells[active.c] === value) return then?.();
    await setCells([{ key: row.key, field: col.key, value }]);
    then?.();
    focusKeys();
  };
  // Clipboard events (Ctrl+C / Ctrl+V on the focused table) need no permission, unlike
  // navigator.clipboard, which WebView2 does not grant.
  const onCopy = (e: React.ClipboardEvent) => {
    if (!grid || !active || editing !== null) return;
    e.preventDefault();
    const lines = rangeLines(grid, view, anchor ?? active, active);
    e.clipboardData.setData("text/plain", lines.join("\r\n"));
    notify(`Copied ${lines.length} row(s)`);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (editing !== null) return;
    e.preventDefault();
    paste(e.clipboardData.getData("text/plain"));
  };
  const paste = async (text: string) => {
    if (!grid || !active || !text) return;
    const { cells, skipped } = pastedCells(grid, view, active, text);
    if (cells.length === 0) return notify(skipped ? `Nothing pasted: ${skipped} cell(s) cannot be edited here` : "Nothing changed");
    await setCells(cells);
    if (skipped) notify(`${skipped} cell(s) skipped (names, fields that do not apply, outside the table)`);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    // Keys stay in the table (arrows would move the timeline, Delete delete objects),
    // except undo, redo, save, open and new.
    if (!(ctrl && ["z", "y", "s", "o", "n"].includes(k.toLowerCase()))) e.stopPropagation();
    if (editing !== null || !active) return;
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, e.shiftKey ? -1 : 1] };
    if (moves[k]) {
      e.preventDefault();
      return move(moves[k][0], moves[k][1], e.shiftKey && k !== "Tab");
    }
    if (k === "PageDown" || k === "PageUp") {
      e.preventDefault();
      return move((k === "PageDown" ? 1 : -1) * Math.floor(height / ROW_HEIGHT), 0, e.shiftKey);
    }
    const editable = active.c > 0 && rowOf(active.r)?.cells[active.c] !== null;
    if ((k === "Enter" || k === "F2") && editable) {
      e.preventDefault();
      return setEditing(rowOf(active.r).cells[active.c] ?? "");
    }
    if (k.length === 1 && !ctrl && !e.altKey && editable) {
      e.preventDefault();
      setEditing(k);
    }
  };
  const clickCell = (r: number, c: number, e: React.MouseEvent) => {
    // Clicks in the cell being edited go to its input.
    if (editing !== null && active?.r === r && active?.c === c) return;
    // No default focus change: the keyboard target takes the focus now.
    e.preventDefault();
    if (e.shiftKey && active) {
      focusKeys();
      if (!anchor) setAnchor(active);
      setActive({ r, c });
      return;
    }
    focusKeys();
    setAnchor(null);
    setActive({ r, c });
    const obj = rowOf(r).object;
    if (c === 0 && obj !== null && grid) setState({ selection: [{ kind: grid.object_kind, index: obj }] });
  };
  const { first, last, before, after } = rowsInView(view.length);
  const doExport = () =>
    grid &&
    exportTable(
      section.toLowerCase(),
      section,
      grid.columns.map((c) => (c.unit ? `${c.name} (${c.unit})` : c.name)),
      view.map((i) => grid.rows[i].cells),
    );
  const choices = active && grid && "options" in grid.columns[active.c] ? (grid.columns[active.c] as { options: string[] }).options : null;
  return (
    <div className="table-panel">
      <div className="panel-toolbar">
        <select value={section} onChange={(e) => setSection(e.target.value)}>
          {GRID_SECTIONS.map(([s, t]) => (
            <option key={s} value={s}>
              {t}
            </option>
          ))}
        </select>
        <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label>
          <input type="checkbox" checked={selOnly} onChange={(e) => setSelOnly(e.target.checked)} /> selected objects only
        </label>
        {grid && (
          <span className="muted">
            {view.length} / {grid.rows.length} rows
          </span>
        )}
        <span className="grow" />
        <span className="muted">Enter edits · Ctrl+C / Ctrl+V copy and paste with Excel · Shift+click selects a range</span>
        <button disabled={!grid} onClick={doExport}>
          Export
        </button>
      </div>
      {error && <div className="panel-error">{error}</div>}
      {grid && (
        <div
          className="table-box grid-editor"
          ref={box}
          onKeyDown={onKey}
          onCopy={onCopy}
          onPaste={onPaste}
          onScroll={onScroll}
        >
          <textarea ref={keys} className="grid-keys" value=" " onChange={() => {}} aria-label="Table keyboard" />
          <table className="grid">
            <thead>
              <tr>
                {grid.columns.map((c, i) => (
                  <th key={c.key} title={`${c.key}${c.unit ? ` (${c.unit})` : ""} – click to sort`} onClick={() => setSort(sort?.col === i ? { col: i, asc: !sort.asc } : { col: i, asc: true })}>
                    {c.name}
                    {c.unit && <span className="muted"> {c.unit}</span>}
                    {sort?.col === i ? (sort.asc ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr style={{ height: before }} />
              {view.slice(first, last).map((ri, k) => {
                const r = first + k;
                const row = grid.rows[ri];
                return (
                  <tr key={ri} className={row.object !== null && selected.has(row.object) ? "selected-row" : undefined}>
                    {row.cells.map((v, c) => {
                      const isActive = active?.r === r && active?.c === c;
                      const cls = [v === null ? "na" : "", inRange(r, c) ? "in-range" : "", isActive ? "active-cell" : "", c === 0 ? "id-cell" : ""].join(" ");
                      return (
                        <td key={c} className={cls} onMouseDown={(e) => clickCell(r, c, e)} onDoubleClick={() => c > 0 && v !== null && setEditing(v)}>
                          {isActive && editing !== null ? (
                            <input
                              autoFocus
                              className="cell-input"
                              list={choices ? "grid-choices" : undefined}
                              value={editing}
                              onChange={(e) => setEditing(e.target.value)}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === "Enter") commit(editing, () => move(1, 0, false));
                                else if (e.key === "Tab") (e.preventDefault(), commit(editing, () => move(0, e.shiftKey ? -1 : 1, false)));
                                else if (e.key === "Escape") (setEditing(null), focusKeys());
                              }}
                              onBlur={() => editing !== null && commit(editing)}
                            />
                          ) : (
                            (v ?? "")
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              <tr style={{ height: after }} />
            </tbody>
          </table>
          {choices && (
            <datalist id="grid-choices">
              {choices.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          )}
        </div>
      )}
      {!grid && !error && <div className="panel-empty">Loading…</div>}
      {grid && grid.rows.length === 0 && <div className="panel-empty">No line in [{section}].</div>}
    </div>
  );
}
