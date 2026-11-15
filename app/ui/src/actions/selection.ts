// Selecting objects and showing them on the map.

import { getState, setState } from "../store";
import type { ObjRef } from "../types";

/** Selects one object; by default the map zooms to it. */
export function selectObject(o: ObjRef, zoom = true) {
  selectObjects([o], zoom);
}

/** Selects objects and, with `zoom`, shows them on the map. */
export function selectObjects(selection: ObjRef[], zoom = true) {
  setState(zoom ? { selection, fitSelection: getState().fitSelection + 1 } : { selection });
}

/** Zooms the map to the selected objects. */
export function zoomToSelection() {
  setState({ fitSelection: getState().fitSelection + 1 });
}
