import { open as openFile, save } from "@tauri-apps/plugin-dialog";

/** Tokens of a line, quoted strings kept whole (without quotes); stops at a comment. */
function tokens(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|(;)|([^\s;"]+)/g)) {
    if (m[2]) break;
    out.push(m[1] ?? m[3]);
  }
  return out;
}

const lines = (text: string) => text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim());
/** Lines of a section, with a blank line before the next section header. */
const join = (ls: string[]) => (ls.length ? ls.map((l) => l + "\n").join("") + "\n" : "");
const isComment = (l: string) => l.trim().startsWith(";");

// ---- [FILES] -------------------------------------------------------------------------

type Mode = "USE" | "SAVE";
const FILE_KINDS: [string, string, Mode[]][] = [
  ["RAINFALL", "Rainfall", ["USE", "SAVE"]],
  ["RUNOFF", "Runoff", ["USE", "SAVE"]],
  ["HOTSTART", "Hot start", ["USE", "SAVE"]],
  ["RDII", "RDII", ["USE", "SAVE"]],
  ["INFLOWS", "Routing inflows", ["USE"]],
  ["OUTFLOWS", "Routing outflows", ["SAVE"]],
];
const modesOf = (kind: string) => FILE_KINDS.find(([k]) => k === kind)?.[2] ?? ["USE", "SAVE"];

export interface FileLine {
  mode: Mode;
  kind: string;
  path: string;
}
/** Interface files, and the other lines (comments) kept as they are. */
export interface FilesData {
  files: FileLine[];
  other: string[];
}

export function parseFiles(text: string): FilesData {
  const d: FilesData = { files: [], other: [] };
  for (const l of lines(text)) {
    const t = tokens(l);
    const mode = t[0]?.toUpperCase();
    const kind = t[1]?.toUpperCase();
    if (t.length >= 3 && (mode === "USE" || mode === "SAVE") && FILE_KINDS.some(([k]) => k === kind)) {
      d.files.push({ mode, kind, path: t.slice(2).join(" ") });
    } else d.other.push(l);
  }
  return d;
}

export function filesText(d: FilesData): string {
  return join([...d.other, ...d.files.map((f) => `${f.mode.padEnd(5)}${f.kind.padEnd(10)}"${f.path.trim()}"`)]);
}

export function filesError(d: FilesData): string | null {
  const f = d.files.find((f) => !f.path.trim());
  return f ? `Files: the path of the ${f.kind.toLowerCase()} file is missing` : null;
}

export function FilesPane({ data, onChange }: { data: FilesData; onChange: (d: FilesData) => void }) {
  const set = (i: number, patch: Partial<FileLine>) =>
    onChange({
      ...data,
      files: data.files.map((f, j) => {
        if (j !== i) return f;
        const g = { ...f, ...patch };
        return modesOf(g.kind).includes(g.mode) ? g : { ...g, mode: modesOf(g.kind)[0] };
      }),
    });
  const browse = async (i: number) => {
    const f = data.files[i];
    const p = f.mode === "USE" ? await openFile({ defaultPath: f.path || undefined }) : await save({ defaultPath: f.path || undefined });
    if (typeof p === "string") set(i, { path: p });
  };
  const unknown = data.other.filter((l) => !isComment(l));
  return (
    <div className="option-pane">
      <p className="muted">
        Interface files read (use) or written (save) by the engine. Relative paths are relative to the model folder.
      </p>
      <table className="kv files-table">
        <thead>
          <tr>
            <th>Action</th>
            <th>File</th>
            <th>Path</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data.files.map((f, i) => (
            <tr key={i}>
              <td>
                <select value={f.mode} onChange={(e) => set(i, { mode: e.target.value as Mode })}>
                  {modesOf(f.kind).map((m) => (
                    <option key={m} value={m}>
                      {m === "USE" ? "Use" : "Save"}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select value={f.kind} onChange={(e) => set(i, { kind: e.target.value })}>
                  {FILE_KINDS.map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="files-path">
                <input value={f.path} placeholder="Path" onChange={(e) => set(i, { path: e.target.value })} />
              </td>
              <td className="nowrap">
                <button onClick={() => browse(i)}>Browse…</button>{" "}
                <a className="muted" title="Remove" onClick={() => onChange({ ...data, files: data.files.filter((_, j) => j !== i) })}>
                  ✕
                </a>
              </td>
            </tr>
          ))}
          {data.files.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No interface file.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="row">
        <button onClick={() => onChange({ ...data, files: [...data.files, { mode: "SAVE", kind: "HOTSTART", path: "" }] })}>
          Add a file
        </button>
      </div>
      {unknown.length > 0 && <div className="warn">Lines not understood, kept as they are: {unknown.join(" · ")}</div>}
    </div>
  );
}

// ---- [REPORT] ------------------------------------------------------------------------

const YN = ["YES", "NO"];
const REPORT_FLAGS: [string, string][] = [
  ["INPUT", "Input summary (default NO)"],
  ["CONTINUITY", "Continuity checks (default YES)"],
  ["FLOWSTATS", "Flow statistics (default YES)"],
  ["CONTROLS", "Control actions (default NO)"],
  ["AVERAGES", "Period averages (default NO)"],
];
const REPORT_OBJECTS: [string, string][] = [
  ["SUBCATCHMENTS", "Subcatchments"],
  ["NODES", "Nodes"],
  ["LINKS", "Links"],
];

type ObjMode = "" | "ALL" | "LIST";
/** Report flags, objects with results, and the other lines (comments, LID) kept as they are. */
export interface ReportData {
  flags: Record<string, string>;
  objects: Record<string, { mode: ObjMode; names: string }>;
  other: string[];
}

export function parseReport(text: string): ReportData {
  const d: ReportData = { flags: {}, objects: {}, other: [] };
  for (const [k] of REPORT_OBJECTS) d.objects[k] = { mode: "", names: "" };
  for (const l of lines(text)) {
    const t = tokens(l);
    const key = t[0]?.toUpperCase() ?? "";
    const o = d.objects[key];
    if (REPORT_FLAGS.some(([k]) => k === key) && t.length === 2) d.flags[key] = t[1].toUpperCase();
    else if (o && t.length >= 2) {
      const v = t[1].toUpperCase();
      if (t.length === 2 && v === "ALL") o.mode = "ALL";
      else if (t.length === 2 && v === "NONE") o.mode = "";
      else {
        o.mode = "LIST";
        o.names = [o.names, ...t.slice(1)].filter(Boolean).join(" ");
      }
    } else d.other.push(l);
  }
  return d;
}

export function reportText(d: ReportData): string {
  const out = [...d.other];
  for (const [k] of REPORT_FLAGS) if (d.flags[k]) out.push(`${k.padEnd(14)}${d.flags[k]}`);
  for (const [k] of REPORT_OBJECTS) {
    const o = d.objects[k];
    if (o.mode === "ALL") out.push(`${k.padEnd(14)}ALL`);
    const names = o.names.split(/\s+/).filter(Boolean);
    if (o.mode === "LIST") for (let i = 0; i < names.length; i += 10) out.push(`${k.padEnd(14)}${names.slice(i, i + 10).join(" ")}`);
  }
  return join(out);
}

export function reportError(d: ReportData): string | null {
  const k = REPORT_OBJECTS.find(([k]) => d.objects[k].mode === "LIST" && !d.objects[k].names.trim());
  return k ? `Results: list the ${k[1].toLowerCase()} to report` : null;
}

export function ReportPane({ data, onChange }: { data: ReportData; onChange: (d: ReportData) => void }) {
  const setObj = (k: string, patch: Partial<ReportData["objects"][string]>) =>
    onChange({ ...data, objects: { ...data.objects, [k]: { ...data.objects[k], ...patch } } });
  const none = REPORT_OBJECTS.every(([k]) => data.objects[k].mode === "");
  return (
    <div className="option-pane">
      <h4>Report file</h4>
      <div className="options-grid">
        {REPORT_FLAGS.map(([k, label]) => (
          <label key={k} className="option">
            <span>{label}</span>
            <select value={data.flags[k] ?? ""} onChange={(e) => onChange({ ...data, flags: { ...data.flags, [k]: e.target.value } })}>
              <option value="">(default)</option>
              {YN.map((c) => (
                <option key={c}>{c}</option>
              ))}
              {data.flags[k] && !YN.includes(data.flags[k]) && <option>{data.flags[k]}</option>}
            </select>
          </label>
        ))}
      </div>
      <h4>Objects with results</h4>
      <p className="muted">Only these objects get time series in the results file: the others cannot be mapped or plotted.</p>
      {REPORT_OBJECTS.map(([k, label]) => {
        const o = data.objects[k];
        return (
          <div key={k} className="row report-objects">
            <span>{label}</span>
            <select value={o.mode} onChange={(e) => setObj(k, { mode: e.target.value as ObjMode })}>
              <option value="">None</option>
              <option value="ALL">All</option>
              <option value="LIST">Only these</option>
            </select>
            {o.mode === "LIST" && (
              <input className="grow" placeholder="Names separated by spaces" value={o.names} onChange={(e) => setObj(k, { names: e.target.value })} />
            )}
          </div>
        );
      })}
      {none && <div className="warn">No object is reported: the run gives no results to map or plot.</div>}
      {data.other.some((l) => !isComment(l)) && (
        <div className="muted">Other lines kept as they are: {data.other.filter((l) => !isComment(l)).join(" · ")}</div>
      )}
    </div>
  );
}
