# Changelog

All notable changes to SWMM Studio are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Control rules editor (#35): in "Sections as text", `[CONTROLS]` is shown with line numbers
  and its syntax highlighted (RULE / IF / AND / OR / THEN / ELSE / PRIORITY, object types,
  names, comparisons, values, comments). The rules are checked as they are typed: clauses out
  of order, comparisons and actions that SWMM would not read, duplicate rule names, and nodes,
  links, rain gages, curves and time series that do not exist; the lines with problems are
  marked and listed (a click goes to the line). The same checks are in the Issues tab, with
  the line; a click opens the rules at that line.

- Time series: a click on a legend entry hides its line (and greys its chip) until it is clicked
  again; the y axes rescale to the lines shown, the hidden lines stay hidden when the graph is
  redrawn and are left out of the SVG and data exports. Not saved with the view.

- X-Y plots (#32): a new "X-Y" tab of the bottom panel ("+" menu) plots one result variable
  against another at each time of the run, for an object (depth vs flow of a conduit, rainfall
  vs runoff) or across objects ("Fix x" keeps one object's variable on the x axis). Points can
  be joined in time order to show hysteresis loops; drag a box to zoom, hover a point for its
  values and time, click it to go to that time. The current time is marked on every series.
  Exports to CSV / Excel, SVG and PNG. Long runs plot one time step in N (20,000 points at most
  per series).

- Autosave and crash recovery: while a model has unsaved changes, they are written every 30 s
  to a recovery file (in `%APPDATA%\SwmmStudio\recovery\`, removed on save or when the app
  quits). After a crash, the empty window lists the unsaved work, and opening the model offers
  to restore its changes (restored, they are unsaved changes: save to keep them) or discard
  them. Models open in another window are not taken for a crash.
- Recent files: the last 10 models opened or saved are listed in the Project menu and in the
  empty window (where one can be removed from the list).
- The empty window has Open and New model buttons.
- Select by query (toolbar "≟ Query", or Q): select the nodes, links or subcatchments matching
  an expression such as `diameter < 0.3`, `type = outfall and invert_elevation < 95`,
  `id = "C1*"` or `max(flow) > 2`. A query uses the object's ID, type and numeric attributes
  (`diameter` is the diameter or height of a link's cross-section), a result variable at the
  current time step (`flow`, `depth`…) or its statistic over the run (`max`, `min`, `mean`,
  `total`), with `= != < <= > >=`, `and`, `or`, `not`, parentheses and `+ - * /`; texts
  ignore case, and `*` and `?` are wildcards in quotes. The objects found replace the
  selection, are added to it, intersected with it or removed from it. On a model of 100,000
  conduits, `diameter < 0.3` takes about 25 ms.
- Command palette: Ctrl+P (or Project ▸ Command palette) lists the commands usable now — project,
  simulation, edition, adding objects, map tools, view, panels and results — with their
  shortcut. Typing filters them (words, or starts of words: "zsel" finds Zoom to the
  selection), ↑ / ↓ choose, Enter or a click runs; the commands last run come first.
- Shortcuts: P turns the longitudinal profile tool on or off, U the upstream highlight.
  S, B, L, M and V choose the select, box, lasso, move and vertices tools; F zooms to the
  whole model and Shift+F to the selection; T shows or hides the labels. Ctrl+F goes to the
  "Find object ID" field (Escape leaves it), Ctrl+, opens the simulation options, Alt+← / →
  go through the bottom panel tabs and Ctrl+ù maximizes or restores the panel. ? (or
  Project ▸ Keyboard shortcuts) lists them all. The toolbar tooltips show their key.
- Bottom panel: the time series, profile, comparison and report tabs are moved by dragging
  them, and "Close all tabs" closes them all at once.
- Reports: clicking a run in Simulation opens its report in a tab of its own (or shows the tab
  that already has it), as does the report of results loaded from outside the runs. A report
  tab is found as it was left after another tab was open: the same section, sort and scroll.
- Upstream: the "Upstream" toolbar button highlights, in blue, the network draining to the
  selected nodes, links and subcatchments (links followed from their to node to their from
  node, subcatchments to their outlet node or subcatchment). Only the objects the map draws are
  highlighted (hidden layers and types are left out, but the network is followed through them).
  The status bar counts the upstream nodes, links and subcatchments, and "select" selects them.
- Observed data: link a file of measured series to a node, link or subcatchment (properties
  panel, "Link a file…"). CSV and other delimited text (`,` `;` tab, decimal comma), Excel
  (`xlsx`, `xls`, `xlsb`), OpenDocument (`ods`) and Parquet files are read; the column of dates
  and times is found (ISO, day or month first), and the columns are mapped to the object's
  variables, by default from their titles (object name, variable names in English or French,
  units). The link is kept in the project file, and the observed values are drawn as points on
  the time series plots of the object's results (and in their exports).
- Observed data: the unit of each mapped column can be chosen (flows in CMS, LPS, m3/h, MLD,
  CFS, GPM or MGD; lengths in m, cm, mm, ft or in; velocities, volumes, rain and evaporation
  rates, fractions or %), proposed from the unit written in the column's title; the values
  are converted to the units of the results.
- Profile: hovering a conduit shows its length, diameter or height, inverts at both ends and
  slope; hovering a node shows its rim, invert and depth.
- Map style: show or hide each node and link type, whatever the layer is coloured by; hidden
  objects are not labelled or selectable on the map.
- One symbol per node type on the map (junction: circle, outfall: triangle, divider: diamond,
  storage: square) and, mid-link, per link type (pump: arrow, orifice: bar, weir: bow tie, outlet:
  chevron, pointing downstream); the legend uses the same symbols.
- Profile: click a conduit or a node in the profile to select it; the map highlights it and pans
  to it when it is out of view (Ctrl+click adds to the selection, double-click zooms to it). The
  selection is highlighted in the profile too.

- Results: drag a result from the properties panel onto a graph (or a time series tab) to add
  it there.
- An error in the interface shows its message and stack, with "Try again", "Save" (unsaved
  changes), "Copy the error" and "Reload", instead of leaving the window empty.

### Changed

- Simulation: back in the bottom panel, between Issues and Events, without sub-tabs. It lists
  the runs, the running one first with its progress bar; a click on a run shows its console
  while it runs, its report once it has finished, with the errors of its console when it failed
  (the console is now kept in the run folder). The first columns of the list: a check box that
  draws the run with each series of the time series graphs (dashed, in the colour of the
  series, one dash pattern per run), then Load.
- Compare: no longer a fixed tab. "+" opens a comparison tab with one of the runs or with a
  results file; closing the tab closes the comparison.
- Map labels are off by default.
- Bottom panel: 40 % of the height by default; under the timeline, one row of tabs: Table,
  Issues, Events and Compare, then time series and profile tabs created as needed. "+" opens a
  new time series or profile tab, or one rebuilt from a view or profile saved in the project
  (and deletes saved ones). Each profile drawn with the profile tool opens in its own tab;
  clicking a result in the properties panel plots it in a new time series tab. Double-click a
  tab to rename it. When the tabs do not fit, they scroll (mouse wheel; the open one is kept in
  view) and "▾ n" lists them all, to open or close one, or close them all.
- The console, run history and report moved to a "Simulation" tab of the side panel.
- Results of a run that did not finish (crashed, stopped or still running) get a results cache
  too, of the periods written; the status bar says the run is incomplete. Opened again after the
  file grew, its cache is rebuilt. A simulation that fails after writing results loads them,
  with its report.
- Without the results cache (while it is built), a time series too long to read directly opens
  on the longest readable window around the current time, which follows the current time,
  instead of failing.

- Shortcuts: Ctrl+O opens a model, Ctrl+N creates one, Home / End jump to the start / end of
  the run; Space at the end of the run plays again from the start. Escape cancels a drag on
  the map and closes the confirmations and the dialogs that edit nothing; the options,
  climatology and section dialogs are closed by their own buttons, and the table editor by
  Escape only while it has no change. In a dialog, Tab and Shift+Tab stay within the dialog.
- Thresholds accept a decimal comma (events, statistics, timeline, plots, comparison).
- Opening a model no longer rewrites its project file when its map styles and its view are
  unchanged, also in a window of another shape.
- The code is organised in smaller modules (back-end: session, commands and editing by
  domain; results cache and model operations by concern; front-end: actions, hooks, map
  viewers, layers and edit tools, plot and profile data, properties, one file per dialog).
- Actions shown as links (object names, "change", "remove"…) can be reached with Tab and
  triggered with Enter or Space.
- The Project menu and Ctrl+S are disabled while a model or results are loading.
- Deleting a saved time series view or profile asks for a second click ("Delete?"): it
  cannot be undone.
- A new, empty model with a projected coordinate system opens on the origin of its projection
  (the centre of a national grid, the central meridian of a UTM zone) instead of 0°, 0°.
- Section names are read like the engine does, with or without their final S (`[JUNCTION]`).
- A value containing a semicolon is refused (SWMM reads it as the start of a comment, even
  inside quotes); a subcatchment line needs its curb length and a subarea line its routing
  keyword, as the engine requires.

### Fixed

- Map: a model without a coordinate system, reopened with its labels on, no longer stops the
  interface ("deck.gl: assertion failed"); the labels asked for the view before the map was
  ready. The view is not saved in the project until the map has one.
- A model opened while an edit, undo or delete was on its way (for example from the file
  explorer while a dialog was open) can no longer receive that change with the object
  numbering of the previous model. The dialogs that edit the previous model (options,
  climatology, sections, tables, delete confirmation) close when another one opens, and the
  Issues tab is filled again when the same file is reopened.
- A model whose map cannot be read is shown without a map and with the reason, instead
  of the previous model staying on screen while the new one was the one being edited.
- Empty model view: the origin of a coordinate system counted from a named prime meridian
  other than Paris (Ferro, Lisbon, Madrid, Rome, Bern, Oslo…) or given as the centre of an
  oblique projection is found too.
- Object names shown as links are read from the names the app already keeps for the map
  labels and the plots, asked once however many links are on screen, instead of being asked
  again from the back-end after every edit.

- The model is shown as saved again when undo brings it back to the saved state, also after
  older edits have left the undo history.
- Results cache: two builds of the same cache no longer write over each other; an older cache
  is replaced even while it is still open elsewhere; a cache built from a file that is still
  being written is no longer reported out of date.
- Pollutant results are named, and given their unit, correctly in files written with fewer
  fixed variables.
- A run that completes at the moment it is cancelled keeps its results and its status.
- Renaming a curve also updates the underdrain curve of `[LID_CONTROLS]` and the curve of a
  custom `[INLETS]` entry.
- A file with a byte order mark and characters that are not UTF-8 is read with all its
  sections and saved back as it was.
- Tables of the input summary of a report (`INPUT YES`) are shown as tables.
- Pasting numbers with a decimal comma into the section table; the scroll buttons of the tab
  strip appear when a renamed tab no longer fits.
- A damaged results file (impossible start date, report step or period count) is reported
  as corrupt instead of crashing.
- Two runs started within the same second no longer share a folder; a run record is written
  whole or not at all; accented characters of the engine output are no longer garbled when a
  read cuts them.
- The preview of a long time series or curve no longer fails on its number of points.
- Cross-sections of shape CUSTOM: the number of barrels is read and written where the engine
  expects it (after two unused values).
- Climatology: clearing an entry that was written on two lines removes both.
- Deleting a transect no longer gives the next one a redundant roughness (`NC`) line.
- Report tables: a row with blank cells (no velocity for a pump in the Link Flow Summary…)
  keeps its values under their headings instead of shifting them left.
- Report messages are linked to the object they name: the capitalised type when there is one
  ("invalid pump curve assigned to Pump P1" is about P1), else the type in lower case
  ("… at node N1").
- Renaming or deleting an object also updates `[LID_USAGE]` drains, `[AQUIFERS]` patterns and
  the per-subcatchment lines of `[ADJUSTMENTS]`.
- Lines are split like the engine does: a `;` starts the comment even inside quotes, and a
  quote inside a name is part of the name.
- Cancelling a run also stops an engine started through a wrapper (batch file, launcher).
- The badge of the Issues tab follows the model after every edit, whatever tab is shown; the
  issues list keeps its sort and scroll position.
- Escape while dragging a result onto a graph only cancels the drag; the timeline jumps follow
  the variable the map is coloured by as soon as it changes.
- The map view saved in the project is restored when the model is opened again.
- Adding an object to a file whose last line has no line break no longer glues two lines.
- Editing a field of an `[INFILTRATION]` line that names its own method no longer drops or adds
  parameters.
- Errors written in the report after a block (run-time errors) are listed again.
- Results cache: progress no longer overflows above 4 GB; a chunk holding an infinite value
  keeps its true minimum and maximum; a failed build leaves no temporary file; an inconsistent
  cache file is rejected instead of crashing.
- Runs: a relative `--run-dir` works; stale files of a reused run folder are not read as
  results; a run that cannot start leaves no empty folder; without a simulation period the
  console no longer fills with one line per simulated hour. Ctrl+C stops `run --cache` while the
  cache is built.
- CLI: `out export` on results without periods and `out synth --step 0` report an error instead
  of crashing.
- Link slope with `LINK_OFFSETS ELEVATION` and default (`*`) offsets.
- Reordering objects or changing the case of a name (sections as text, rename) updates the
  network.
- The model stays marked as modified when the saved state can no longer be reached by undo.
- Absurd times in options (`10000000000000:00`) are rejected instead of crashing.
- Profiles and plotted series follow their objects when an edit changes the indices; water
  lines of a profile extended while playing are drawn for the right nodes.
- Events: clicking a row after changing the selectors selects the object the table was computed
  for; "outfalls only" no longer filters links.
- The table editor no longer shows (or saves) the previous table while another one loads.
- A dialog whose content cannot be loaded shows the error and can be closed.
- Late answers of the back-end no longer replace newer ones (properties, class limits,
  coordinate system search, section text, graphs).
- A plain click on a vertex handle no longer records an edit; holding Delete no longer asks to
  delete twice; the arrow keys no longer pan the basemap while stepping the timeline.
- "Open results…" resets map styles and series that the new results cannot show.

### Security

- MapLibre GL JS 6.16 (from 5.24), for an XSS sanitizer bypass in versions up to 6.4
  (GHSA-jrc7-96c5-q579) that `npm ci` reported as critical.

## [0.1.0] - 2026-10-29

First release: a Windows desktop app and a command-line tool to visualize, edit, simulate and
analyse EPA SWMM 5 models, built for large networks (100k+ objects) and long continuous simulations
(multi-year runs, `.out` files up to 10 GB). Installers: MSI and NSIS (`setup.exe`), x64. No SWMM
engine is bundled: register any `runswmm.exe`-compatible executable (EPA SWMM 5.1/5.2, OWA, custom
builds).

### Added

#### Models and files

- Lossless `.inp` reader and writer: saved files change only where you edited them (comments,
  alignment, line endings, unknown sections and UTF-8 / Windows-1252 encodings are kept).
- Project file `<model>.swproj` for the coordinate system, basemap, view, map styles and linked
  results; the results next to the model (`.out` / `.rpt`, or the latest run) are loaded on open.
- New model with default options, Save as, and opening the `.inp` passed on the command line (file
  association; a second launch hands its file to the running window).

#### Map

- Network over OpenStreetMap in any coordinate system, searched by EPSG code or name or given as a
  PROJ string; models without one are shown in their own coordinates.
- Selection by click, box or lasso, find by ID, labels when zoomed in.
- Map styles: colour nodes, links and subcatchments by type, input attribute or result (equal
  interval, quantile or custom classes); lines from subcatchments to their outlets.
- Animated results with a timeline (zoom from years to steps, play, jump to a date, to the time of
  maximum or to the next event above a threshold).

#### Editing

- Every change can be undone and redone (Ctrl+Z / Ctrl+Y).
- Properties panel with named, unit-aware, validated fields; type changes rebuild the line;
  renaming and deleting update every reference; one field set on many selected objects at once.
- Drawing on the map: nodes, rain gages, links with vertices, subcatchments; moving objects,
  editing vertices and reconnecting links.
- Curves, time series, patterns, unit hydrographs and RDII, transects, climatology, simulation
  options (with Files, Results and Engine tabs), and any section as text.
- Table editor: a whole section as a spreadsheet-like grid of 100k rows, with sort, filter and
  copy / paste with Excel.
- Model checks after every edit (missing references, bad geometry, adverse slopes, nodes that drain
  to no outfall…), linked to the objects.

#### Simulation

- Run the model as it is (F5) with the chosen engine, with progress, engine output and cancel.
- Run history in `<model>_runs/`: status, engine and continuity errors; label, load, compare or
  delete runs.
- Report viewer: errors and warnings linked to their objects, continuity errors, every summary
  table.

#### Analysis

- Results cache, built in the background, for fast multi-year time series and whole-run envelopes.
- Time series of any objects and variables, also per day, month or year; stacked graphs, view tabs
  and saved views.
- Statistics maps (maximum, minimum, mean, time of maximum, total, duration above a threshold) over
  the run or the current day, month or year.
- Longitudinal profiles along the shortest path between nodes, with the moving water line and the
  run's maximum.
- Event statistics above a threshold with a minimum inter-event time (e.g. overflow frequency),
  per object and per year.
- Comparison of two runs: per-object differences, difference maps and overlaid plots.
- Exports: tables to CSV or Excel, figures to PNG or SVG.

#### Command line

- `swmm-cli` to register engines, run models, list runs, inspect and check `.inp` files, read
  `.rpt` reports, and inspect, cache, summarize, export or synthesize `.out` files.

[Unreleased]: https://github.com/SimonDelmas/swmm-studio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SimonDelmas/swmm-studio/releases/tag/v0.1.0
