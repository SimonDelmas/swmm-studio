import { fromInputValue, periodAt, periodMs, toInputValue } from "../../format";
import { setState, useStore } from "../../store";
import type { ResultsInfo } from "../../types";

const SPEEDS = [1, 2, 5, 10, 20, 30, 60];
const STRIDES = [1, 2, 3, 6, 12, 24, 48, 96, 288, 2016];

/** Play / pause, step, the current date and the speed of the animation. */
export function TransportControls({ results }: { results: ResultsInfo }) {
  const period = useStore((s) => s.period);
  const playing = useStore((s) => s.playing);
  const fps = useStore((s) => s.fps);
  const stride = useStore((s) => s.stride);
  const n = results.n_periods;
  const step = (k: number) => setState({ period: Math.max(0, Math.min(n - 1, period + k * stride)) });
  return (
    <>
      <button title="Previous step" onClick={() => step(-1)}>
        ◀
      </button>
      <button className="primary" title="Play / pause (Space)" onClick={() => setState({ playing: !playing })}>
        {playing ? "❚❚" : "▶"}
      </button>
      <button title="Next step" onClick={() => step(1)}>
        ▶|
      </button>
      <input
        type="datetime-local"
        value={toInputValue(periodMs(results, period))}
        onChange={(e) => {
          const ms = fromInputValue(e.target.value);
          if (ms !== null) setState({ period: periodAt(results, ms) });
        }}
      />
      <span className="muted">
        {period + 1} / {n}
      </span>
      <label>
        Speed
        <select value={fps} onChange={(e) => setState({ fps: Number(e.target.value) })}>
          {SPEEDS.map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
      </label>
      <label>
        Every
        <select value={stride} onChange={(e) => setState({ stride: Number(e.target.value) })}>
          {STRIDES.map((s) => (
            <option key={s} value={s}>
              {s} step{s > 1 ? "s" : ""}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
