// What the map draws: the network coloured by its styles, the profile, the selection,
// the labels and the shapes of the drawing tools.

import { useEffect, useMemo, useRef } from "react";
import { COORDINATE_SYSTEM, type Layer } from "@deck.gl/core";
import { ensureIds } from "../actions/ids";
import { useStore } from "../store";
import { defaultStyle, type LayerStyle } from "../uiTypes";
import { arrowGeometry, flowArrowLayers, flowVariable } from "./arrows";
import { styleObjects } from "./colors";
import { baseLayers, staticGeometry } from "./layers";
import { outletSegments } from "./outlets";
import { labelLayer, profileLayers, selectionLayers, upstreamLayers } from "./overlayLayers";
import { useUpstream } from "./upstream";
import { useLayerValues } from "./useLayerValues";
import type { Viewer } from "./viewers";

/** Rendering measurements, read by the UI tests. */
export const mapPerf = { steps: [] as { period: number; ms: number }[], layers: [] as Layer[] };

/**
 * Keeps the layers of the viewer in step with the state. `modelKey` changes with the
 * model and its coordinate system, `viewTick` when the view moves, `toolLayers` are
 * the shapes of the drawing tools (drawn on top).
 */
export function useMapLayers(viewer: React.RefObject<Viewer | null>, modelKey: string | null, viewTick: number, toolLayers: Layer[]) {
  const model = useStore((s) => s.model);
  const g = useStore((s) => s.geometry);
  const styles = useStore((s) => s.styles);
  const period = useStore((s) => s.period);
  const selection = useStore((s) => s.selection);
  const labels = useStore((s) => s.labels);
  const ids = useStore((s) => s.ids);
  const profile = useStore((s) => s.profile);
  const profileStart = useStore((s) => s.profileStart);

  // Values are reloaded after every edit (the objects or their attributes may differ).
  const revision = model?.revision ?? 0;
  const resultsKey = model?.results ? `${model.results.path}:${model.results.cache.state}:${revision}` : null;
  const valuesKey = modelKey ? `${modelKey}:${revision}` : null;
  const compareKey = model?.compare ? `${model.compare.path}:${model.compare.cache.state}:${revision}` : null;
  const nodeValues = useLayerValues("node", styles.node, period, resultsKey, valuesKey, compareKey);
  const linkValues = useLayerValues("link", styles.link, period, resultsKey, valuesKey, compareKey);
  const subValues = useLayerValues("subcatchment", styles.subcatchment, period, resultsKey, valuesKey, compareKey);
  // Flows at the current time, for the arrows (none asked when they are off or without results).
  const flowVar = flowVariable(model?.results?.variables.link);
  const arrowsOn = styles.link.visible && styles.link.flowArrows;
  const flowStyle = useMemo(
    (): LayerStyle => ({ ...defaultStyle("link"), ...(arrowsOn && flowVar >= 0 ? { source: "result", field: String(flowVar) } : {}) }),
    [arrowsOn, flowVar],
  );
  const flows = useLayerValues("link", flowStyle, period, resultsKey, valuesKey);

  // Labels need the IDs, also when an edit dropped them (they are then asked again).
  useEffect(() => {
    if (labels && model) ensureIds(["node", "link"]).catch(() => {});
  }, [labels, modelKey, ids]);

  const coordSystem = g?.space === "lonlat" ? COORDINATE_SYSTEM.LNGLAT : COORDINATE_SYSTEM.CARTESIAN;

  const nodeStyled = useMemo(
    () => g && styleObjects("node", styles.node, g.nodeTypes.length, g.nodeTypes, nodeValues),
    [g, styles.node, nodeValues],
  );
  const linkStyled = useMemo(
    () => g && styleObjects("link", styles.link, g.linkTypes.length, g.linkTypes, linkValues),
    [g, styles.link, linkValues],
  );
  const subStyled = useMemo(
    () => g && styleObjects("subcatchment", styles.subcatchment, g.subStarts.length - 1, null, subValues),
    [g, styles.subcatchment, subValues],
  );

  const geo = useMemo(() => g && staticGeometry(g), [g]);
  const outlets = useMemo(() => (g && styles.subcatchment.outletLinks ? outletSegments(g) : null), [g, styles.subcatchment.outletLinks]);

  const visible = useMemo(
    () => ({ node: styles.node.visible, link: styles.link.visible, subcatchment: styles.subcatchment.visible }),
    [styles.node.visible, styles.link.visible, styles.subcatchment.visible],
  );
  const base = useMemo(
    () => (g && geo && nodeStyled && linkStyled && subStyled ? baseLayers(g, geo, outlets, nodeStyled, linkStyled, subStyled, visible, coordSystem) : []),
    [g, geo, outlets, nodeStyled, linkStyled, subStyled, visible, coordSystem],
  );
  const arrowGeo = useMemo(() => (g && arrowsOn ? arrowGeometry(g) : null), [g, arrowsOn]);
  // Without results, the direction the links are drawn in; with results, once the flows are loaded.
  const withFlows = flowStyle.source === "result" && !!resultsKey;
  const arrowed = useMemo(
    () =>
      g && arrowGeo && linkStyled && (!withFlows || flows) ? flowArrowLayers(g, arrowGeo, linkStyled, withFlows ? flows : null, coordSystem) : [],
    [g, arrowGeo, linkStyled, withFlows, flows, coordSystem],
  );
  const selected = useMemo(
    () => (g ? selectionLayers(g, selection, coordSystem, styles.link.size, styles.node.size) : []),
    [g, selection, coordSystem, styles.link.size, styles.node.size],
  );
  const upstream = useUpstream();
  const upstreamed = useMemo(
    () => (g && upstream ? upstreamLayers(g, upstream, coordSystem, styles.link.size, styles.node.size) : []),
    [g, upstream, coordSystem, styles.link.size, styles.node.size],
  );
  const profiled = useMemo(
    () => (g ? profileLayers(g, profile, profileStart, coordSystem, styles.link.size, styles.node.size) : []),
    [g, profile, profileStart, coordSystem, styles.link.size, styles.node.size],
  );
  // Labels of the objects in view (viewTick: recomputed when the view moves).
  const labelled = useMemo(
    () => (labels && g && viewer.current ? labelLayer(g, ids, viewer.current.extent(), coordSystem, styles) : null),
    [labels, g, ids, viewTick, coordSystem, styles.node.visible, styles.link.visible, styles.node.hiddenTypes, styles.link.hiddenTypes],
  );

  // Time from a period change to the map drawn with it (see `mapPerf`).
  const stepStart = useRef<{ period: number; t0: number } | null>(null);
  useEffect(() => {
    stepStart.current = { period, t0: performance.now() };
  }, [period]);

  useEffect(() => {
    const layers = [...base, ...arrowed, ...upstreamed, ...profiled, ...selected, ...(labelled ? [labelled] : []), ...toolLayers];
    viewer.current?.setLayers(layers);
    mapPerf.layers = layers;
    const s = stepStart.current;
    if (s) {
      requestAnimationFrame(() => {
        mapPerf.steps.push({ period: s.period, ms: performance.now() - s.t0 });
        if (mapPerf.steps.length > 500) mapPerf.steps.shift();
      });
    }
  }, [base, arrowed, upstreamed, profiled, selected, labelled, toolLayers]);

  return useMemo(() => ({ node: nodeValues, link: linkValues, subcatchment: subValues }), [nodeValues, linkValues, subValues]);
}
