import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { tryEdit } from "../edit";
import { setState } from "../store";
import { EnginesPane } from "./EnginesPane";
import { LoadingModal, Modal } from "./Modal";
import { FilesPane, filesError, filesText, parseFiles, parseReport, ReportPane, reportError, reportText, type FilesData, type ReportData } from "./OptionSections";

type Opt = { key: string; label: string; choices?: string[]; kind?: "date" | "time" | "number" | "day" };

const YN = ["YES", "NO"];
const OPTION_GROUPS: [string, Opt[]][] = [
  [
    "General",
    [
      { key: "FLOW_UNITS", label: "Flow units", choices: ["CFS", "GPM", "MGD", "CMS", "LPS", "MLD"] },
      {
        key: "INFILTRATION",
        label: "Infiltration model",
        choices: ["HORTON", "MODIFIED_HORTON", "GREEN_AMPT", "MODIFIED_GREEN_AMPT", "CURVE_NUMBER"],
      },
      { key: "FLOW_ROUTING", label: "Routing model", choices: ["STEADY", "KINWAVE", "DYNWAVE"] },
      { key: "LINK_OFFSETS", label: "Link offsets", choices: ["DEPTH", "ELEVATION"] },
      { key: "FORCE_MAIN_EQUATION", label: "Force main equation", choices: ["H-W", "D-W"] },
      { key: "MIN_SLOPE", label: "Minimum conduit slope (%)", kind: "number" },
      { key: "ALLOW_PONDING", label: "Allow ponding", choices: YN },
      { key: "SKIP_STEADY_STATE", label: "Skip steady flow periods", choices: YN },
      { key: "IGNORE_RAINFALL", label: "Ignore rainfall/runoff", choices: YN },
      { key: "IGNORE_RDII", label: "Ignore RDII", choices: YN },
      { key: "IGNORE_SNOWMELT", label: "Ignore snowmelt", choices: YN },
      { key: "IGNORE_GROUNDWATER", label: "Ignore groundwater", choices: YN },
      { key: "IGNORE_ROUTING", label: "Ignore flow routing", choices: YN },
      { key: "IGNORE_QUALITY", label: "Ignore water quality", choices: YN },
    ],
  ],
  [
    "Dates",
    [
      { key: "START_DATE", label: "Start date (MM/DD/YYYY)", kind: "date" },
      { key: "START_TIME", label: "Start time", kind: "time" },
      { key: "REPORT_START_DATE", label: "Report start date", kind: "date" },
      { key: "REPORT_START_TIME", label: "Report start time", kind: "time" },
      { key: "END_DATE", label: "End date", kind: "date" },
      { key: "END_TIME", label: "End time", kind: "time" },
      { key: "SWEEP_START", label: "Street sweeping start (MM/DD)", kind: "day" },
      { key: "SWEEP_END", label: "Street sweeping end (MM/DD)", kind: "day" },
      { key: "DRY_DAYS", label: "Antecedent dry days", kind: "number" },
    ],
  ],
  [
    "Time steps",
    [
      { key: "REPORT_STEP", label: "Reporting", kind: "time" },
      { key: "WET_STEP", label: "Runoff, wet weather", kind: "time" },
      { key: "DRY_STEP", label: "Runoff, dry weather", kind: "time" },
      { key: "ROUTING_STEP", label: "Routing (H:MM:SS or seconds)", kind: "time" },
      { key: "RULE_STEP", label: "Control rule step", kind: "time" },
    ],
  ],
  [
    "Dynamic wave",
    [
      { key: "INERTIAL_DAMPING", label: "Inertial terms", choices: ["NONE", "PARTIAL", "FULL"] },
      { key: "NORMAL_FLOW_LIMITED", label: "Normal flow criterion", choices: ["SLOPE", "FROUDE", "BOTH"] },
      { key: "SURCHARGE_METHOD", label: "Surcharge method", choices: ["EXTRAN", "SLOT"] },
      { key: "VARIABLE_STEP", label: "Variable time step factor", kind: "number" },
      { key: "LENGTHENING_STEP", label: "Conduit lengthening step (s)", kind: "number" },
      { key: "MIN_SURFAREA", label: "Minimum nodal surface area", kind: "number" },
      { key: "MAX_TRIALS", label: "Maximum trials", kind: "number" },
      { key: "HEAD_TOLERANCE", label: "Head convergence tolerance", kind: "number" },
      { key: "SYS_FLOW_TOL", label: "System flow tolerance (%)", kind: "number" },
      { key: "LAT_FLOW_TOL", label: "Lateral flow tolerance (%)", kind: "number" },
      { key: "MINIMUM_STEP", label: "Minimum variable step (s)", kind: "number" },
      { key: "THREADS", label: "Threads", kind: "number" },
    ],
  ],
];

function check(o: Opt, v: string): string | null {
  if (!v.trim()) return null;
  const t = v.trim();
  if (o.kind === "number" && !Number.isFinite(Number(t))) return `${o.label}: not a number`;
  if (o.kind === "date" && !/^(\d{1,2}|[A-Za-z]{3})[/-]\d{1,2}[/-]\d{4}$/.test(t)) return `${o.label}: use MM/DD/YYYY`;
  if (o.kind === "day" && !/^\d{1,2}\/\d{1,2}$/.test(t)) return `${o.label}: use MM/DD`;
  if (o.kind === "time" && !/^\d+(:\d{1,2}){0,2}$|^\d*\.?\d+$/.test(t)) return `${o.label}: use H:MM:SS`;
  return null;
}

/** Tabs of the options dialog that are not plain [OPTIONS] groups. */
const OTHER_TABS = ["Files", "Results", "Engine", "Title & other"];

/** Simulation options: [OPTIONS], [FILES], [REPORT], title, and the engine that runs the model. */
export function OptionsDialog({ initialTab = "General" }: { initialTab?: string }) {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [orig, setOrig] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const [origTitle, setOrigTitle] = useState("");
  const [files, setFiles] = useState<FilesData>({ files: [], other: [] });
  const [origFiles, setOrigFiles] = useState("");
  const [report, setReport] = useState<ReportData>(parseReport(""));
  const [origReport, setOrigReport] = useState("");
  const [tab, setTab] = useState(initialTab);
  const [error, setError] = useState<string | null>(null);
  const close = () => setState({ dialog: null });
  useEffect(() => {
    Promise.all([api.options(), api.sectionText("FILES"), api.sectionText("REPORT")]).then(([o, f, r]) => {
      const v: Record<string, string> = {};
      o.values.forEach(([k, x]) => (v[k] = x));
      setValues(v);
      setOrig(v);
      setTitle(o.title);
      setOrigTitle(o.title);
      const fd = parseFiles(f);
      setFiles(fd);
      setOrigFiles(filesText(fd));
      const rd = parseReport(r);
      setReport(rd);
      setOrigReport(reportText(rd));
    }, (e) => setError(errorText(e)));
  }, []);
  if (!values) return <LoadingModal title="Simulation options" error={error} onClose={close} />;
  const known = new Set(OPTION_GROUPS.flatMap(([, g]) => g.map((o) => o.key)));
  const others = Object.keys(values).filter((k) => !known.has(k));
  const groups: [string, Opt[]][] = [...OPTION_GROUPS, ["Title & other", others.map((k) => ({ key: k, label: k }))]];
  const tabs = [...OPTION_GROUPS.map(([g]) => g), ...OTHER_TABS];
  const fail = (t: string, e: string) => {
    setTab(t);
    setError(e);
  };
  const ok = async () => {
    for (const [g, opts] of groups) {
      for (const o of opts) {
        const e = check(o, values[o.key] ?? "");
        if (e) return fail(g, e);
      }
    }
    const fe = filesError(files);
    if (fe) return fail("Files", fe);
    const re = reportError(report);
    if (re) return fail("Results", re);
    const changed: [string, string][] = Object.keys({ ...values, ...orig })
      .filter((k) => (values[k] ?? "").trim() !== (orig[k] ?? ""))
      .map((k) => [k, (values[k] ?? "").trim()]);
    try {
      if (changed.length) await tryEdit({ op: "set_options", values: changed });
      if (title.trim() !== origTitle.trim()) await tryEdit({ op: "set_title", text: title });
      if (filesText(files) !== origFiles) await tryEdit({ op: "set_section_text", section: "FILES", text: filesText(files) });
      if (reportText(report) !== origReport) await tryEdit({ op: "set_section_text", section: "REPORT", text: reportText(report) });
      close();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const flowChanged = (values.FLOW_UNITS ?? "") !== (orig.FLOW_UNITS ?? "");
  const infilChanged = (values.INFILTRATION ?? "") !== (orig.INFILTRATION ?? "");
  const group = groups.find(([g]) => g === tab)?.[1];
  return (
    <Modal title="Simulation options" onClose={close} modal className="wide-modal">
        <div className="tabs">
          {tabs.map((g) => (
            <button key={g} className={g === tab ? "active" : ""} onClick={() => setTab(g)}>
              {g}
            </button>
          ))}
        </div>
        {group && (
          <div className="options-grid">
            {group.map((o) => (
              <label key={o.key} className="option">
                <span>{o.label}</span>
                {o.choices ? (
                  <select value={values[o.key] ?? ""} onChange={(e) => setValues({ ...values, [o.key]: e.target.value })}>
                    <option value="">(default)</option>
                    {o.choices.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                    {values[o.key] && !o.choices.includes(values[o.key]) && <option>{values[o.key]}</option>}
                  </select>
                ) : (
                  <input
                    value={values[o.key] ?? ""}
                    placeholder="(default)"
                    onChange={(e) => setValues({ ...values, [o.key]: e.target.value })}
                  />
                )}
              </label>
            ))}
            {tab === "Title & other" && (
              <label className="option title-option">
                <span>Title / notes</span>
                <textarea rows={4} value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
            )}
          </div>
        )}
        {tab === "Files" && <FilesPane data={files} onChange={setFiles} />}
        {tab === "Results" && <ReportPane data={report} onChange={setReport} />}
        {tab === "Engine" && <EnginesPane />}
        {flowChanged && <div className="warn">Changing the flow units does not convert any value of the model.</div>}
        {infilChanged && (
          <div className="warn">The [INFILTRATION] parameters are not converted: check them for the new model.</div>
        )}
        {error && <div className="panel-error">{error}</div>}
        <div className="row end">
          <button className="primary" onClick={ok}>
            OK
          </button>
          <button onClick={close}>Cancel</button>
        </div>
    </Modal>
  );
}
