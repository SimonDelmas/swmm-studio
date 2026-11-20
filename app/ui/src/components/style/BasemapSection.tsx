// Basemap settings of the project: tiles, opacity, visibility, greyscale.

import { api, errorText } from "../../api";
import { getState, notify, setState } from "../../store";
import type { Basemap } from "../../types";

function setBasemap(patch: Partial<Basemap>) {
  const m = getState().model;
  if (!m) return;
  const basemap = { ...m.project.basemap, ...patch };
  setState({ model: { ...m, project: { ...m.project, basemap } } });
  api.updateProject(basemap).catch((e) => notify(errorText(e), true));
}

/** Basemap tiles: only with a coordinate system (the cartesian view has none). */
export function BasemapSection({ basemap: bm }: { basemap: Basemap }) {
  return (
    <div className="style-section">
      <div className="style-head">
        <label title="Basemap (OpenStreetMap)">
          <input type="checkbox" checked={bm.visible} onChange={(e) => setBasemap({ visible: e.target.checked })} />
          <b>Basemap</b>
        </label>
        <label title="Basemap in shades of grey, so that the colours of the network stand out">
          <input type="checkbox" checked={bm.greyscale} onChange={(e) => setBasemap({ greyscale: e.target.checked })} />
          grey
        </label>
        <label title="Basemap opacity">
          opacity
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={bm.opacity}
            onChange={(e) => setBasemap({ opacity: Number(e.target.value) })}
          />
        </label>
      </div>
    </div>
  );
}
