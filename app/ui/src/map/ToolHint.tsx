const HINTS: Partial<Record<string, string>> = {
  move: "Drag a node or gage; drag a selected object to move the selection.",
  vertex: "Select a link or subcatchment: drag a vertex, drag a midpoint to add one, Alt+click to delete one. Drag a link end onto a node to reconnect it.",
  "add-subcatchment": "Click the outline points; click the first point or press Enter to finish. Backspace removes the last point.",
  "add-gage": "Click to place a rain gage.",
  measure: "Click points: distance along them, and area from three points. Double-click or Enter ends; Backspace removes the last point.",
};

/** One-line help for the active editing tool. */
export function ToolHint({ tool, sketching }: { tool: string; sketching: boolean }) {
  let text = HINTS[tool];
  if (tool === "profile")
    text = sketching
      ? "Click the end node: the profile is drawn."
      : "Click the start node of a profile (Shift+click extends the current profile through another node).";
  if (!text && /^add-(junction|outfall|divider|storage)$/.test(tool)) text = `Click to add a ${tool.slice(4)}.`;
  if (!text && tool.startsWith("add-"))
    text = sketching
      ? "Click to add vertices, then click the end node. Backspace removes the last vertex, Escape cancels."
      : `Click the start node of the ${tool.slice(4)}.`;
  if (!text) return null;
  return <div className="map-hint">{text} Escape: back to selection.</div>;
}
