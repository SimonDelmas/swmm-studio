import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { closeAllViewTabs, closeViewTab, isViewTabOpen, newPlotName, newPlotView, openPlotView, openProfileView, openViewTab, renameViewTab, viewTabs, type ViewTab } from "../actions/views";
import { compareWithFile, compareWithRun, refreshRuns, runName } from "../actions/runs";
import { setState, useStore, type State } from "../store";
import type { BottomTab } from "../uiTypes";
import { ComparePanel } from "./ComparePanel";
import { EventsPanel } from "./EventsPanel";
import { IssuesPanel } from "./IssuesPanel";
import { deletePlotView, loadPlotView, savedPlotViews } from "../plot/savedViews";
import { PlotPanel } from "./PlotPanel";
import { deleteProfile, loadProfile, savedProfiles } from "../profile/profiles";
import { useDropdown } from "../hooks/useDropdown";
import { ProfilePanel } from "./ProfilePanel";
import { reportErrors, SimulationPanel } from "./SimulationPanel";
import { TablePanel } from "./TablePanel";

/** Views always there. */
const FIXED: [BottomTab, string, string][] = [
  ["table", "Table", "Edit the objects of a section in a table"],
  ["issues", "Issues", "Check the model data"],
  ["simulation", "Simulation", "Run the model; the runs, their console and their reports"],
  ["events", "Events", "Rain and flood events of the results"],
];

const ICONS: Record<ViewTab["type"], string> = { plot: "〜", profile: "⟋", compare: "⇄" };
const KINDS: Record<ViewTab["type"], string> = { plot: "Time series", profile: "Profile", compare: "Comparison" };

/**
 * The "+" menu: new time series, profile or comparison tab, or one rebuilt from a view or
 * profile saved in the project.
 */
function AddMenu() {
  const results = useStore((s) => !!s.model?.results);
  const model = useStore((s) => !!s.model);
  const runs = useStore((s) => s.runs);
  const comparable = (runs ?? []).filter((r) => r.out && !r.loaded);
  const views = useStore(savedPlotViews);
  const profiles = useStore(savedProfiles);
  const { open, setOpen, ref, run } = useDropdown();
  // Deleting a saved view cannot be undone: the first click asks, the second deletes.
  const [asking, setAsking] = useState<string | null>(null);
  useEffect(() => {
    if (!open) setAsking(null);
  }, [open]);
  const saved = (name: string, title: string, disabled: boolean, load: () => unknown, del: () => void) => {
    const id = `${title}|${name}`;
    const confirm = asking === id;
    return (
      <div key={name} className="menu-row">
        <button disabled={disabled} title={title} onClick={run(load)}>
          {name}
        </button>
        <button
          className={confirm ? "menu-del danger" : "menu-del"}
          title={confirm ? "Click again to delete it from the project (this cannot be undone)" : "Delete from the project"}
          onClick={() => {
            if (!confirm) return setAsking(id);
            setAsking(null);
            del();
          }}
        >
          {confirm ? "Delete?" : "×"}
        </button>
      </div>
    );
  };
  return (
    <div className="menu" ref={ref}>
      <button className={`tab-add${open ? " active" : ""}`} title="New view: time series, profile or comparison, or a saved one" onClick={() => setOpen(!open)}>
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
          <div className="menu-head">Compare the loaded results with</div>
          {results && comparable.length === 0 && <div className="menu-none">No other run with results</div>}
          {results &&
            comparable.slice(0, 15).map((r) => (
              <button key={r.dir} title={r.dir} onClick={run(() => compareWithRun(r))}>
                {runName(r)}
              </button>
            ))}
          <button disabled={!results} title={results ? "Compare with a SWMM results file (.out)" : "Load results first"} onClick={run(compareWithFile)}>
            Results file…
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

/** All the time series, profile and comparison tabs, when they do not fit in the tab bar: open or close one, or close them all. */
function TabList({ tabs, s }: { tabs: ViewTab[]; s: Pick<State, "bottomTab" | "plotView" | "profileView" | "compareView"> }) {
  const { open, setOpen, ref, run } = useDropdown();
  return (
    <div className="menu" ref={ref}>
      <button className={`tab-add${open ? " active" : ""}`} title={`All the ${tabs.length} tabs`} onClick={() => setOpen(!open)}>
        ▾ {tabs.length}
      </button>
      {open && (
        <div className="menu-items menu-right tab-list">
          {tabs.map((t) => (
            <div key={`${t.type}:${t.id}`} className={`menu-row${isViewTabOpen(s, t) ? " current" : ""}`}>
              <button title={t.name} onClick={run(() => openViewTab(t))}>
                <span className="view-tab-icon">{ICONS[t.type]}</span>
                {t.name}
              </button>
              <button className="menu-del" title="Close this tab" onClick={() => closeViewTab(t)}>
                ×
              </button>
            </div>
          ))}
          <hr />
          <button onClick={run(closeAllViewTabs)}>Close all the time series, profile and comparison tabs</button>
        </div>
      )}
    </div>
  );
}

/** The tab of a time series, profile or comparison view: double-click renames it, × or a middle click closes it. */
function ViewTab({ t, active, children }: { t: ViewTab; active: boolean; children?: React.ReactNode }) {
  const [editing, setEditing] = useState(false);
  const rename = (name: string) => {
    setEditing(false);
    if (!name.trim()) return;
    renameViewTab(t, name.trim());
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
    <span
      className={`view-tab${active ? " active" : ""}`}
      {...(t.type === "plot" ? { "data-drop-view": t.id } : {})}
      // Middle click closes the tab, as in a browser; mousedown is cancelled so it does not start autoscroll.
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        closeViewTab(t);
      }}
    >
      <button
        title={`${KINDS[t.type]} “${t.name}” – double-click to rename`}
        onClick={() => openViewTab(t)}
        onDoubleClick={() => setEditing(true)}
      >
        <span className="view-tab-icon">{ICONS[t.type]}</span>
        <span className="view-tab-name">{t.name}</span>
        {children}
      </button>
      <button className="view-tab-close" title="Close this tab" onClick={() => closeViewTab(t)}>
        ×
      </button>
    </span>
  );
}

function Body() {
  const tab = useStore((s) => s.bottomTab);
  const plot = useStore((s) => (s.bottomTab === "plot" ? s.plotViews.find((v) => v.id === s.plotView) : undefined));
  const profile = useStore((s) => (s.bottomTab === "profile" ? s.profileViews.find((v) => v.id === s.profileView) : undefined));
  const compare = useStore((s) => (s.bottomTab === "compare" ? s.compareViews.find((v) => v.id === s.compareView) : undefined));
  switch (tab) {
    case "table":
      return <TablePanel />;
    case "issues":
      return <IssuesPanel />;
    case "simulation":
      return <SimulationPanel />;
    case "events":
      return <EventsPanel />;
    case "compare":
      return compare ? <ComparePanel key={compare.id} view={compare} /> : <div className="panel-empty">No comparison tab open: “+” creates one.</div>;
    case "plot":
      return plot ? <PlotPanel key={plot.id} view={plot} /> : <div className="panel-empty">No time series tab open: “+” creates one.</div>;
    case "profile":
      return profile ? <ProfilePanel key={profile.id} view={profile} /> : <div className="panel-empty">No profile tab open: “+” creates one.</div>;
  }
}

/** The views of the bottom panel: fixed tabs, then time series, profile and comparison tabs created as needed. */
export function BottomPanel() {
  const bottomTab = useStore((x) => x.bottomTab);
  const plotView = useStore((x) => x.plotView);
  const profileView = useStore((x) => x.profileView);
  const plotViews = useStore((x) => x.plotViews);
  const profileViews = useStore((x) => x.profileViews);
  const compareView = useStore((x) => x.compareView);
  const compareViews = useStore((x) => x.compareViews);
  const running = useStore((x) => x.run.running);
  const runErrors = useStore(reportErrors);
  const bottomMax = useStore((x) => x.bottomMax);
  const modelErrors = useStore((x) => x.issues?.filter((i) => i.severity === "error").length ?? 0);
  // The runs (simulation tab, "+" menu) are listed again when the results shown change.
  const model = useStore((x) => x.model);
  useEffect(() => {
    void refreshRuns();
  }, [model?.path, model?.results?.path, model?.compare?.path, model?.overlays.length]);
  const s = { bottomTab, plotView, profileView, compareView, bottomMax };
  const tabs = viewTabs({ plotViews, profileViews, compareViews });
  // The time series and profile tabs scroll when they do not fit (wheel, or the list).
  const strip = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const tabNames = [...plotViews, ...profileViews, ...compareViews].map((v) => v.name).join("\n");
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return setOverflow(false);
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
    // Checked again when a tab is renamed: its width changes, not the strip's.
  }, [tabs.length, tabNames]);
  // The open tab is scrolled into view.
  const activeKey =
    bottomTab === "plot" ? `plot:${plotView}` : bottomTab === "profile" ? `profile:${profileView}` : bottomTab === "compare" ? `compare:${compareView}` : "";
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(".view-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey, tabs.length]);
  return (
    <>
      <div className="tabs bottom-tabs">
        {FIXED.map(([t, label, title]) => (
          <button key={t} className={s.bottomTab === t ? "active" : ""} title={title} onClick={() => setState({ bottomTab: t })}>
            {label}
            {t === "issues" && modelErrors > 0 && <span className="badge bad">{modelErrors}</span>}
            {t === "simulation" && running && <span className="badge warn">…</span>}
            {t === "simulation" && !running && runErrors > 0 && <span className="badge bad">{runErrors}</span>}
          </button>
        ))}
        {tabs.length > 0 && <span className="tabs-sep" />}
        {tabs.length > 0 && (
          <div
            ref={strip}
            className={`view-tabs${overflow ? " overflow" : ""}`}
            onWheel={(e) => {
              if (strip.current && e.deltaY !== 0 && !e.deltaX) strip.current.scrollLeft += e.deltaY;
            }}
          >
            {tabs.map((t) => (
              <ViewTab key={`${t.type}:${t.id}`} t={t} active={isViewTabOpen(s, t)} />
            ))}
          </div>
        )}
        {overflow && <TabList tabs={tabs} s={s} />}
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
