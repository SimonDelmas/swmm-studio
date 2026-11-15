// What the drawing tools of the map answer to the keyboard. The map registers its tools
// here; the shortcuts read them without depending on the map.

export interface MapToolKeys {
  /** Escape: drops the current sketch or drag; true if there was one. */
  cancel(): boolean;
  /** Enter: finishes a subcatchment outline. */
  finish(): void;
  /** Backspace: removes the last sketch point. */
  back(): boolean;
  /** A sketch or a drag is in progress. */
  busy: boolean;
}

export const mapTools: { current: MapToolKeys | null } = { current: null };
