import { useRef, useState } from "react";
import { useModelChecks } from "./actions/validate";
import { BottomPanel } from "./components/BottomPanel";
import { ClimateDialog } from "./components/ClimateDialog";
import { CrsDialog } from "./components/CrsDialog";
import { DataPanel } from "./components/DataPanel";
import { DeleteDialog } from "./components/DeleteDialog";
import { NewModelDialog } from "./components/NewModelDialog";
import { OptionsDialog } from "./components/OptionsDialog";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { QueryDialog } from "./components/QueryDialog";
import { SectionsDialog } from "./components/SectionsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { StatusBar } from "./components/StatusBar";
import { StylePanel } from "./components/StylePanel";
import { TableEditor } from "./components/TableEditor";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { useBackendEvents } from "./hooks/useBackendEvents";
import { useShortcuts } from "./hooks/useShortcuts";
import { useStylePersistence } from "./hooks/useStylePersistence";
import { useWindow } from "./hooks/useWindow";
import { MapView } from "./map/MapView";
import { useProfile } from "./profile/profiles";
import { getState, setState, useStore } from "./store";

/** Drag handle that resizes a panel. */
function Splitter({ vertical, onDrag }: { vertical: boolean; onDrag: (delta: number) => void }) {
  const last = useRef(0);
  return (
    <div
      className={vertical ? "splitter-v" : "splitter-h"}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        last.current = vertical ? e.clientX : e.clientY;
      }}
      onPointerMove={(e) => {
        if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
        const p = vertical ? e.clientX : e.clientY;
        onDrag(p - last.current);
        last.current = p;
      }}
    />
  );
}

export function App() {
  useBackendEvents();
  useWindow();
  useShortcuts();
  useStylePersistence();
  useProfile();
  useModelChecks();
  const crsDialog = useStore((s) => s.crsDialog);
  const dialog = useStore((s) => s.dialog);
  const bottomMax = useStore((s) => s.bottomMax);
  const sideTab = useStore((s) => s.sideTab);
  const [sideW, setSideW] = useState(360);
  // Null: 40 % of the centre (60 % for the map) until dragged.
  const [bottomH, setBottomH] = useState<number | null>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // From the current height (also when maximized), up to hiding the map.
  const dragBottom = (d: number) => {
    const c = centerRef.current;
    const b = bottomRef.current;
    if (!c || !b) return;
    const timeline = c.querySelector<HTMLElement>(".timeline")?.offsetHeight ?? 0;
    const max = c.clientHeight - timeline - 5;
    if (getState().bottomMax) setState({ bottomMax: false });
    setBottomH(Math.max(80, Math.min(max, b.offsetHeight - d)));
  };
  const sideTabs: [typeof sideTab, string][] = [
    ["props", "Properties"],
    ["data", "Data"],
    ["style", "Map style"],
  ];

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <div ref={centerRef} className={bottomMax ? "center bottom-max" : "center"}>
          <MapView />
          <Timeline />
          <Splitter vertical={false} onDrag={dragBottom} />
          <div ref={bottomRef} className="bottom" style={{ height: bottomMax ? undefined : (bottomH ?? "40%") }}>
            <BottomPanel />
          </div>
        </div>
        <Splitter vertical onDrag={(d) => setSideW((w) => Math.max(240, Math.min(760, w - d)))} />
        <div className="sidebar" style={{ width: sideW }}>
          <div className="tabs">
            {sideTabs.map(([t, label]) => (
              <button key={t} className={sideTab === t ? "active" : ""} onClick={() => setState({ sideTab: t })}>
                {label}
              </button>
            ))}
          </div>
          <div className="tab-body">
            {sideTab === "props" ? (
              <PropertiesPanel />
            ) : sideTab === "data" ? (
              <DataPanel />
            ) : (
              <StylePanel />
            )}
          </div>
        </div>
      </div>
      <StatusBar />
      {crsDialog && <CrsDialog />}
      {dialog === "options" && <OptionsDialog />}
      {dialog === "engines" && <OptionsDialog initialTab="Engine" />}
      {dialog === "new" && <NewModelDialog />}
      {dialog === "climate" && <ClimateDialog />}
      {dialog === "sections" && <SectionsDialog />}
      {dialog === "shortcuts" && <ShortcutsDialog />}
      {dialog === "query" && <QueryDialog />}
      <TableEditor />
      <DeleteDialog />
    </div>
  );
}
