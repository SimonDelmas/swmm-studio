import { useEffect } from "react";
import { getState, setState, useStore } from "../store";

/** While playing, advances the current period at the chosen speed, and stops at the end of the run. */
export function usePlayback() {
  const playing = useStore((s) => s.playing);
  const fps = useStore((s) => s.fps);
  const n = useStore((s) => s.model?.results?.n_periods ?? 0);
  useEffect(() => {
    if (!playing || n === 0) return;
    const timer = setInterval(() => {
      const s = getState();
      const next = s.period + s.stride;
      if (next >= n) setState({ playing: false, period: n - 1 });
      else setState({ period: next });
    }, 1000 / fps);
    return () => clearInterval(timer);
  }, [playing, fps, n]);
}
