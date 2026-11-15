import { api, errorText } from "../../api";
import { focusVar, parseNumber } from "../../format";
import { getState, notify, setState, useStore } from "../../store";

/**
 * Jumps in time for the selected object, on the variable its layer is coloured by: to
 * its maximum, or to the next time it rises above a threshold.
 */
export function JumpButtons({ threshold, setThreshold }: { threshold: string; setThreshold: (t: string) => void }) {
  const styles = useStore((s) => s.styles);
  const results = useStore((s) => s.model?.results ?? null);
  const period = useStore((s) => s.period);
  const selected = useStore((s) => s.selection[0]);
  const target = selected ? focusVar({ styles }, selected) : null;
  const varLabel = target && results ? results.variables[target.kind][target.var] : null;

  const jumpMax = () => {
    const o = getState().selection[0];
    if (!target || !o) return;
    api
      .timeOfMax(target.kind, o.index, target.var)
      .then((p) => setState({ period: p }))
      .catch((e) => notify(errorText(e), true));
  };
  const nextEvent = () => {
    const o = getState().selection[0];
    if (!target || !o) return;
    const thr = parseNumber(threshold);
    if (!Number.isFinite(thr)) return notify("The threshold is not a number.", true);
    api
      .nextEvent(target.kind, o.index, target.var, period, thr)
      .then((p) => (p === null ? notify("No later event above the threshold.") : setState({ period: p })))
      .catch((e) => notify(errorText(e), true));
  };

  return (
    <>
      <button disabled={!target} onClick={jumpMax} title="Jump to the time of maximum of the selected object">
        Max{varLabel ? ` ${varLabel.name}` : ""}
      </button>
      <button disabled={!target} onClick={nextEvent} title="Jump to the next time the value rises above the threshold">
        Next event &gt;
      </button>
      <input className="narrow" value={threshold} onChange={(e) => setThreshold(e.target.value)} title="Event threshold" />
    </>
  );
}
