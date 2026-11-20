import { forwardRef, useImperativeHandle, useMemo, useRef, type ReactNode } from "react";
import type { RuleIssue } from "../analysisTypes";

const CLAUSES = new Set(["RULE", "IF", "AND", "OR", "THEN", "ELSE", "PRIORITY", "VARIABLE", "EXPRESSION"]);
const OBJECTS = new Set(["NODE", "LINK", "CONDUIT", "PUMP", "ORIFICE", "WEIR", "OUTLET", "GAGE", "SUBCATCH", "SIMULATION", "CURVE", "TIMESERIES", "PID"]);
const RELATIONS = new Set(["=", "<>", "<", "<=", ">", ">="]);

/** Spans of one line of control rules: clause keywords, object types, names, values, comments. */
function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  // A `;` outside quotes starts a comment.
  let code = line;
  let comment = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ";" && !quoted) {
      code = line.slice(0, i);
      comment = line.slice(i);
      break;
    }
  }
  let first = true;
  let after = ""; // previous word, upper case: a name follows an object type
  for (const m of code.matchAll(/(\s+)|("[^"]*"?)|([^\s"]+)/g)) {
    const [text, space] = m;
    if (space) {
      out.push(text);
      continue;
    }
    const up = text.toUpperCase();
    let cls: string | undefined;
    if (first && CLAUSES.has(up)) cls = "rk-clause";
    else if (OBJECTS.has(up)) cls = "rk-object";
    else if (RELATIONS.has(text)) cls = "rk-relation";
    else if (after === "RULE" || (OBJECTS.has(after) && after !== "SIMULATION" && after !== "PID")) cls = "rk-name";
    else if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$|^\d+:\d+(:\d+)?$/.test(text)) cls = "rk-number";
    out.push(cls ? <span key={out.length} className={cls}>{text}</span> : text);
    first = false;
    after = up;
  }
  if (comment) out.push(<span key="c" className="rk-comment">{comment}</span>);
  return out;
}

export interface RulesEditorHandle {
  /** Puts the caret at the start of a line (0 = the first) and scrolls it into view. */
  goTo(line: number): void;
}

/**
 * Text area for `[CONTROLS]` with syntax highlighting and the lines with problems marked:
 * the text is drawn by a layer under a transparent text area that keeps the native editing.
 */
export const RulesEditor = forwardRef<RulesEditorHandle, { text: string; issues: RuleIssue[]; disabled: boolean; onChange: (t: string) => void }>(
  function RulesEditor({ text, issues, disabled, onChange }, ref) {
    const area = useRef<HTMLTextAreaElement>(null);
    const layer = useRef<HTMLPreElement>(null);
    const gutter = useRef<HTMLDivElement>(null);
    const lines = useMemo(() => text.split("\n"), [text]);
    const marks = useMemo(() => {
      const m = new Map<number, RuleIssue>();
      // Errors win over warnings on the same line.
      for (const i of issues) if (!m.has(i.line) || i.severity === "error") m.set(i.line, i);
      return m;
    }, [issues]);
    const sync = () => {
      const a = area.current;
      if (!a) return;
      if (layer.current) {
        layer.current.scrollTop = a.scrollTop;
        layer.current.scrollLeft = a.scrollLeft;
      }
      if (gutter.current) gutter.current.scrollTop = a.scrollTop;
    };
    useImperativeHandle(ref, () => ({
      goTo(line: number) {
        const a = area.current;
        if (!a) return;
        const all = a.value.split("\n");
        const at = all.slice(0, Math.max(0, line)).reduce((n, l) => n + l.length + 1, 0);
        a.focus();
        a.setSelectionRange(at, at + (all[line]?.length ?? 0));
        const h = parseFloat(getComputedStyle(a).lineHeight) || 16;
        a.scrollTop = Math.max(0, line * h - a.clientHeight / 3);
        sync();
      },
    }));
    return (
      <div className="rules-editor">
        <div className="rules-gutter" ref={gutter} aria-hidden>
          {lines.map((_, i) => {
            const m = marks.get(i);
            return (
              <div key={i} className={m ? `rk-mark-${m.severity}` : undefined} title={m?.message}>
                {i + 1}
              </div>
            );
          })}
        </div>
        <div className="rules-code">
          <pre ref={layer} aria-hidden>
            {lines.map((l, i) => {
              const m = marks.get(i);
              return (
                <div key={i} className={m ? `rk-line-${m.severity}` : undefined}>
                  {l === "" ? " " : highlight(l)}
                </div>
              );
            })}
          </pre>
          <textarea
            ref={area}
            spellCheck={false}
            value={text}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onScroll={sync}
            wrap="off"
          />
        </div>
      </div>
    );
  },
);
