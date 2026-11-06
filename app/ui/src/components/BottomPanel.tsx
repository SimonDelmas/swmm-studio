import { useEffect, useRef, useState } from "react";
import { getState, newPlotName, newPlotView, openPlotView, openProfileView, selectProfileView, setState, updatePlotView, updateProfileView, useStore, type BottomTab, type State } from "../store";
import { ComparePanel } from "./ComparePanel";
import { EventsPanel } from "./EventsPanel";
import { IssuesPanel } from "./IssuesPanel";
import { deletePlotView, loadPlotView, PlotPanel, savedPlotViews } from "./PlotPanel";
import { deleteProfile, loadProfile, ProfilePanel, savedProfiles } from "./ProfilePanel";
import { TablePanel } from "./TablePanel";

/** Views always there. */
const FIXED: [BottomTab, string, string][] = [
  ["table", "Table", "Edit the objects of a section in a table"],
  ["issues", "Issues", "Check the model data"],
  ["events", "Events", "Rain and flood events of the results"],
  ["compare", "Compare", "Compare the results with another run"],
];

/** A time series or profile tab. */
interface DynTab {
  type: "plot" | "profile";
  id: number;
  name: string;
}

/** The tabs created as needed, in creation order. */
function dynTabs(s: Pick<State, "plotViews" | "profileViews">): DynTab[] {
  return [
    ...s.plotViews.map((v) => ({ type: "plot" as const, id: v.id, name: v.name })),
    ...s.profileViews.map((v) => ({ type: "profile" as const, id: v.id, name: v.name })),
  ].sort((a, b) => a.id - b.id);
}

const isOpen = (s: Pick<State, "bottomTab" | "plotView" | "profileView">, t: DynTab) => s.bottomTab === t.type && (t.type === "plot" ? s.plotView : s.profileView) === t.id;

function openTab(t: DynTab) {
  if (t.type === "plot") setState({ plotView: t.id, bottomTab: "plot" });
  else selectProfileView(t.id);
}

/** Closes a tab; when it was open, the next one (or the previous, or the table) opens. */
function closeTab(s: State, t: DynTab) {
  const tabs = dynTabs(s);
  const i = tabs.findIndex((x) => x.type === t.type && x.id === t.id);
  const wasOpen = isOpen(s, t);
  if (t.type === "plot") setState({ plotViews: s.plotViews.filter((v) => v.id !== t.id) });
  else setState({ profileViews: s.profileViews.filter((v) => v.id !== t.id), ...(wasOpen ? { profileNodes: [], profileStart: null } : {}) });
  if (!wasOpen) return;
  const next = tabs[i + 1] ?? tabs[i - 1];
  if (next) openTab(next);
  else setState({ bottomTab: "table" });
}

/** The "+" menu: new time series or profile tab, or one rebuilt from a view or profile saved in the project. */
function AddMenu() {
  const results = useStore((s) => !!s.model?.results);
  const model = useStore((s) => !!s.model);
  const views = useStore(savedPlotViews);
  const profiles = useStore(savedProfiles);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current?.contains(e.target as Node) || setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const run = (f: () => unknown) => () => {
    setOpen(false);
    f();
  };
  const saved = (name: string, title: string, disabled: boolean, load: () => unknown, del: () => void) => (
    <div key={name} className="menu-row">
      <button disabled={disabled} title={title} onClick={run(load)}>
        {name}
      </button>
      <button className="menu-del" title="Delete from the project" onClick={del}>
        ×
      </button>
    </div>
  );
  return (
    <div className="menu" ref={ref}>
      <button className={`tab-add${open ? " active" : ""}`} title="New view: time series or profile, or a saved one" onClick={() => setOpen(!open)}>
        +
      </button>
      {open && (
        <div className="menu-items">
          <button disabled={!results} title={results ? "" : "Load results first"} onClick={run(() => openPlotView(newPlotView(newPlotName())))}>
            Time series
          </button>
          <button disabled={!model} onClick={run(() => openProfileView([]))}>
            Profile
          </button>
          <hr />
          <div className="menu-head">Saved time series</div>
          {views.length === 0 && <div className="menu-none">None (“Save” in a time series tab)</div>}
          {views.map((v) =>
            saved(v.name, results ? "Open this saved view in a new tab" : "Load results first", !results, () => loadPlotView(v.name), () => deletePlotView(v.name)),
          )}
          <hr />
          <div className="menu-head">Saved profiles</div>
          {profiles.length === 0 && <div className="menu-none">None (“Save” in a profile tab)</div>}
          {profiles.map((p) => saved(p.name, "Open this saved profile in a new tab", false, () => loadProfile(p.name), () => deleteProfile(p.name)))}
        </div>
      )}
    </div>
  );
}

/** The tab of a time series or profile view: double-click renames it, × closes it. */
function ViewTab({ t, active, children }: { t: DynTab; active: boolean; children?: React.ReactNode }) {
  const [editing, setEditing] = useState(false);
  const rename = (name: string) => {
    setEditing(false);
    if (!name.trim()) return;
    if (t.type === "plot") updatePlotView(t.id, { name: name.trim() });
    else updateProfileView(t.id, { name: name.trim() });
  };
  if (editing)
    return (
      <input
        className="narrow-name"
        autoFocus
        defaultValue={t.name}
        onBlur={(e) => rename(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  return (
    <span className={`view-tab${active ? " active" : ""}`} {...(t.type === "plot" ? { "data-drop-view": t.id } : {})}>
      <button
        title={`${t.type === "plot" ? "Time series" : "Profile"} – double-click to rename`}
        onClick={() => openTab(t)}
        onDoubleClick={() => setEditing(true)}
      >
        <span className="view-tab-icon">{t.type === "plot" ? "〜" : "⟋"}</span>
        {t.name}
        {children}
      </button>
      <button className="view-tab-close" title="Close this tab" onClick={() => closeTab(getState(), t)}>
        ×
      </button>
    </span>
  );
}

function Body() {
  const tab = useStore((s) => s.bottomTab);
  const plot = useStore((s) => (s.bottomTab === "plot" ? s.plotViews.find((v) => v.id === s.plotView) : undefined));
  const profile = useStore((s) => (s.bottomTab === "profile" ? s.profileViews.find((v) => v.id === s.profileView) : undefined));
  switch (tab) {
    case "table":
      return <TablePanel />;
    case "issues":
      return <IssuesPanel />;
    case "events":
      return <EventsPanel />;
    case "compare":
      return <ComparePanel />;
    case "plot":
      return plot ? <PlotPanel key={plot.id} view={plot} /> : <div className="panel-empty">No time series tab open: “+” creates one.</div>;
    case "profile":
      return profile ? <ProfilePanel key={profile.id} view={profile} /> : <div className="panel-empty">No profile tab open: “+” creates one.</div>;
  }
}

/** The views of the bottom panel: fixed tabs, then time series and profile tabs created as needed. */
export function BottomPanel() {
  const bottomTab = useStore((x) => x.bottomTab);
  const plotView = useStore((x) => x.plotView);
  const profileView = useStore((x) => x.profileView);
  const plotViews = useStore((x) => x.plotViews);
  const profileViews = useStore((x) => x.profileViews);
  const bottomMax = useStore((x) => x.bottomMax);
  const modelErrors = useStore((x) => x.issues?.filter((i) => i.severity === "error").length ?? 0);
  const comparing = useStore((x) => !!x.model?.compare);
  const s = { bottomTab, plotView, profileView, bottomMax };
  const tabs = dynTabs({ plotViews, profileViews });
  return (
    <>
      <div className="tabs bottom-tabs">
        {FIXED.map(([t, label, title]) => (
          <button key={t} className={s.bottomTab === t ? "active" : ""} title={title} onClick={() => setState({ bottomTab: t })}>
            {label}
            {t === "issues" && modelErrors > 0 && <span className="badge bad">{modelErrors}</span>}
            {t === "compare" && comparing && <span className="badge">B</span>}
          </button>
        ))}
        {tabs.length > 0 && <span className="tabs-sep" />}
        {tabs.map((t) => (
          <ViewTab key={`${t.type}:${t.id}`} t={t} active={isOpen(s, t)} />
        ))}
        <AddMenu />
        <span className="grow" />
        <button
          className="tabs-tool"
          title={s.bottomMax ? "Show the map again" : "Hide the map: the panel fills the window (more room for the graphs)"}
          onClick={() => setState({ bottomMax: !s.bottomMax })}
        >
          {s.bottomMax ? "▾ Restore" : "▴ Maximize"}
        </button>
      </div>
      <div className="tab-body">
        <Body />
      </div>
    </>
  );
}
