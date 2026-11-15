import { useEffect } from "react";
import { updateProjectUi } from "../actions/project";
import { getState, useStore } from "../store";
import { defaultStyle, type LayerStyle, type StyledKind } from "../uiTypes";

const STYLED: StyledKind[] = ["node", "link", "subcatchment"];
const sameStyle = (a: LayerStyle, b: LayerStyle) => JSON.stringify(a) === JSON.stringify(b);

/** Saves the map styles in the project, a moment after they change. */
export function useStylePersistence() {
  const styles = useStore((s) => s.styles);
  const labels = useStore((s) => s.labels);
  useEffect(() => {
    const m = getState().model;
    // A project that never had styles is not given the default ones just for being opened.
    const untouched = m?.project.ui.styles === undefined && !labels && STYLED.every((k) => sameStyle(styles[k], defaultStyle(k)));
    if (!m || untouched) return;
    const t = setTimeout(() => updateProjectUi({ styles, labels }, m.path), 1000);
    return () => clearTimeout(t);
  }, [styles, labels]);
}
