import { useEffect, useRef, useState, type ReactNode } from "react";
import { mapTools } from "../actions/mapTools";
import { getState, setState, useStore } from "../store";
import { ToolHint } from "./ToolHint";
import { useEditTools } from "./useEditTools";
import { useMapLayers } from "./useMapLayers";
import { useMapSelection } from "./useMapSelection";
import { useViewer } from "./useViewer";

/** The map: the network on a basemap or on a plain plane, with the selection and drawing tools. `empty`: shown without a model. */
export function MapView({ empty }: { empty?: ReactNode }) {
  const hasModel = useStore((s) => !!s.model);
  const crs = useStore((s) => s.model?.crs?.id ?? "");
  const modelSeq = useStore((s) => s.modelSeq);
  const g = useStore((s) => s.geometry);
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const profileStart = useStore((s) => s.profileStart);
  const container = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<string>("");

  // The viewer is made again for another model or coordinate system.
  const modelKey = hasModel ? `${modelSeq}:${crs}` : null;
  const space = g?.space;
  const { viewer, viewTick } = useViewer(container, space, modelKey);
  const tools = useEditTools(viewer, container, g, tool, selection);
  mapTools.current = tools;
  useMapLayers(viewer, modelKey, viewTick, tools.layers);
  const select = useMapSelection(viewer, container, tool, tools);

  const drawingTool = tool.startsWith("add-");
  // Block body: an effect must return nothing or a cleanup function.
  useEffect(() => {
    viewer.current?.setDoubleClickZoom(!drawingTool);
  }, [drawingTool, modelKey]);
  // Leaving the profile tool forgets a half-picked profile.
  useEffect(() => {
    if (tool !== "profile" && getState().profileStart !== null) setState({ profileStart: null });
  }, [tool]);

  /** Follows the pointer: the drawing tools, and the coordinates shown in the corner. */
  const onPointerMove = (e: React.PointerEvent) => {
    const v = viewer.current;
    if (!v || !g) return;
    const p = select.relative(e);
    tools.onMove(p);
    const [x, y] = v.unproject(p);
    setCursor(g.space === "lonlat" ? `${y.toFixed(6)}°, ${x.toFixed(6)}°` : `X ${(x + g.origin[0]).toFixed(2)}  Y ${(y + g.origin[1]).toFixed(2)}`);
  };

  return (
    <div className="map-wrap">
      <div
        ref={container}
        className={`map tool-${drawingTool ? "add" : tool}`}
        {...select.map}
        onPointerMove={onPointerMove}
        onContextMenu={(e) => e.preventDefault()}
      />
      {(tool === "box" || tool === "lasso") && (
        <svg
          className="draw-overlay"
          onPointerDown={select.overlay.onPointerDown}
          onPointerMove={(e) => {
            onPointerMove(e);
            select.overlay.onPointerMove(e);
          }}
          onPointerUp={select.overlay.onPointerUp}
        >
          {select.shape}
        </svg>
      )}
      {hasModel && !g && <div className="map-note">The map of this model cannot be drawn (see the status bar); open it again to retry.</div>}
      {g && space !== "lonlat" && <div className="map-note">Local coordinates (no coordinate system)</div>}
      {cursor && <div className="map-cursor">{cursor}</div>}
      {hasModel && <ToolHint tool={tool} sketching={tools.busy || (tool === "profile" && profileStart !== null)} />}
      {!hasModel && (empty ?? <div className="map-empty">Open a SWMM model (.inp) to start.</div>)}
    </div>
  );
}
