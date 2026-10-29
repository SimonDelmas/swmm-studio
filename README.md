# SWMM Studio

Visualize, edit, simulate and analyse EPA SWMM 5 models, built for large networks
(100k+ objects) and long continuous simulations (multi-year runs, `.out` files up to 10 GB).

See [SPEC.md](SPEC.md) for the functional and technical specification and the roadmap.

**Status: M3 (analysis, v1.0).** Desktop app: open or create a model, set its coordinate system,
see the network over OpenStreetMap, edit it (properties, objects drawn on the map, vertices, curves,
time series, patterns, transects, unit hydrographs and RDII, climatology, any section as text, or
whole sections in a spreadsheet-like table) with undo / redo, check it, run it with your SWMM
engine, then analyse the results: animated maps, envelope and time-aggregated maps, time series of
any length (also per day / month / year), longitudinal profiles with the moving water line,
long-term event statistics (e.g. overflow frequency), and comparisons between runs kept in the run
history. Tables export to CSV or Excel, figures to PNG or SVG. Saved files change only where you
edited them.

## Crates

| Crate | Purpose |
|---|---|
| [`swmm-inp`](crates/swmm-inp) | Lossless `.inp` reader/writer: untouched lines are written back byte-for-byte (comments, alignment, line endings, unknown sections, UTF-8/Windows-1252). Options, simulation period, external file references. |
| [`swmm-out`](crates/swmm-out) | Memory-mapped `.out` reader (any size, partial files of running simulations), writer, synthetic generator, and the **results cache**: an object-major, losslessly compressed copy built in one pass, with per-chunk min/max/time-of-max/sum, for fast multi-year series and whole-run envelopes. |
| [`swmm-rpt`](crates/swmm-rpt) | `.rpt` parser: errors/warnings (with input line and object), continuity errors, RDII, every summary block as a table / key-values / text. |
| [`swmm-engine`](crates/swmm-engine) | Engine registry (`%APPDATA%\SwmmStudio\settings.json`), version detection, runs in `<model>_runs/<timestamp>_<label>/` with progress, cancel and a `run.json` record. |
| [`swmm-geo`](crates/swmm-geo) | EPSG registry (search by code or name), reprojection of model coordinates to WGS 84 (pure Rust, `proj4rs`), Web Mercator, R-tree for box / lasso selection and picking. |
| [`swmm-model`](crates/swmm-model) | Network view of a model: nodes, links, subcatchments, rain gages, connectivity and map geometry; named properties of any object; numeric attributes for thematic maps. Editing: undoable line-level transactions, field schema (types, units, validation), rename and delete with every reference, curves / time series / patterns / unit hydrographs / transects. |
| [`swmm-analysis`](crates/swmm-analysis) | Statistics of results over any range of periods (max, min, mean, time of max, total volume / depth, time above a threshold) from the cache's chunk summaries; calendar days / months / years; event detection with a minimum inter-event time and per-year statistics; shortest path and longitudinal profile between nodes. |
| [`swmm-cli`](crates/swmm-cli) | Command-line front-end. |
| [`app/src-tauri`](app/src-tauri) | Desktop application (Tauri 2): session state, commands, background results cache. |
| [`app/ui`](app/ui) | Front-end (React, TypeScript, MapLibre GL, deck.gl, uPlot). |

## Desktop app

Requirements: Rust, Node.js 20+, the Tauri CLI (`cargo install tauri-cli --version ^2`), and the
WebView2 runtime (preinstalled on Windows 10/11).

```bash
npm ci --prefix app/ui
```

```bash
cd app/src-tauri && cargo tauri dev
```

`cargo tauri build` makes the MSI and NSIS installers. A plain `cargo build --release` also makes
a working `target/release/swmm-studio.exe` once the front-end is built (`npm run build --prefix app/ui`):
the app embeds `app/ui/dist`.

- **Open model…** reads the `.inp`, its project file `<model>.swproj` (coordinate system, basemap,
  view, map styles, linked results) and the results found next to it (`<model>.out` / `.rpt`, or
  the latest run in `<model>_runs/`). **Open results…** loads any other `.out` (and the `.rpt`
  beside it).
- The coordinate system (button in the toolbar) is searched by EPSG code or name (`2154`,
  `Lambert-93`, `CC44`, `27563`) or given as a PROJ string. Without one the network is shown in its
  own coordinates, without basemap. The `.inp` is never modified.
- Map: click to select (Shift adds), box and lasso tools, find by ID, labels when zoomed in. The
  **Map style** tab colours nodes, links and subcatchments by type, by an input attribute or by a
  result variable (equal-interval, quantile or custom classes; class limits of results come from
  each object's maximum over the run, so colours stay comparable while animating).
- Timeline: wheel to zoom (years → steps), drag to pan, click to jump; play with speed and step
  stride; jump to a date, to the time of maximum of the selected object, or to its next event above
  a threshold. Keyboard: Space plays, arrows step, Escape clears the selection.
- Time series: any objects and variables, one axis per unit; the backend sends at most one min/max
  pair per pixel, so a multi-year series plots in milliseconds; drag to zoom (more detail is
  loaded), double-click to reset, export PNG / CSV.
- Report: errors and warnings linked to the objects they name, continuity errors (amber above 1 %,
  red above 5 %), every summary table, sortable, rows linked to the map.
- A large `.out` gets its results cache built in the background on open (progress in the status
  bar); until it is ready, series over long ranges wait for it and short ranges are read directly.

Editing (every change can be undone with Ctrl+Z and redone with Ctrl+Y; Ctrl+S saves):

- **Properties**: every field of the selected object, named, with its unit and checked as you type
  (Enter or leaving the field applies it, Escape restores it). Changing a type (outfall, storage
  shape, cross-section shape, rain gage source…) rebuilds the line and keeps the other values.
  Renaming updates every reference. Optional lines (direct inflow, dry weather flow, RDII, losses)
  are added and removed from the panel.
- **Several objects selected**: set one field on all of them, assign a unit hydrograph and a
  sewershed area to the selected nodes, delete them.
- **Map**: **+ Add…** draws junctions, outfalls, storage units, dividers, rain gages (click), links
  (click the start node, optional vertices, the end node) and subcatchments (click the outline,
  Enter to finish; area, width and outlet are filled in). **Move** drags nodes and gages, or the
  selection. **Vertices** edits the selected link or subcatchment: drag a vertex, drag a midpoint to
  add one, Alt+click to delete one, drag a link end onto another node to reconnect it. Delete
  removes the selection, with the connected links (a dialog lists what else changes).
- **Data** tab: curves, time series, time patterns, unit hydrographs (per month, short / medium /
  long responses) and transects, in grids that accept cells pasted from a spreadsheet, with a
  preview. **Options** edits the simulation options and the title.
- **Run** (F5) simulates the model as it is, without saving it first, with the engine chosen in
  **Engines** (shared with the CLI; a model can use its own). Progress, elapsed time and the engine
  output are shown in the **Run** tab; Cancel stops the engine. The results and the report are
  loaded at the end.
- **New** writes an empty model with default options; **Save as** continues with the new file.

Analysis (bottom tabs; every table has an **Export** button, CSV or Excel):

- **Map style → Statistics**: colour nodes, links or subcatchments by the maximum, minimum, mean,
  time of maximum, total (volume of a flow, depth of a rainfall) or duration above a threshold of a
  result, over the whole run or over the day, month or year of the current time (the map follows the
  timeline). With a compared run: **Δ** maps (A − B), at the current time or of any statistic.
- **Time series**: **per day / month / year** plots daily, monthly or yearly statistics; **+ From
  run B** overlays the same objects from the compared run (dashed). **Data**, **SVG**, **PNG** export.
- **Profile**: select two nodes or more (Shift+click, in order) and click *From selected nodes*: the
  shortest path, with ground, conduits, the water line at the current time (it moves with the
  timeline), the maximum water line of the run and the water line of run B. SVG / PNG / data export.
- **Events**: events of a variable above a threshold, closer than a minimum inter-event time merged
  (e.g. outfall inflow above 0, 6 h apart): count, events per year, volume, duration and peak per
  object, a per-year table and the list of events (click one to jump to it on the timeline).
- **Compare**: per-object statistics of the loaded run (A) and another one (B), with their
  difference; difference maps and overlaid plots. Runs are matched by object name and by time.
- **Runs**: every simulation kept in `<model>_runs/`, with status, engine, continuity errors; label,
  load, compare or delete them.
- **Table**: a section (junctions, conduits, subareas, infiltration, inflows…) as a grid of 100k rows:
  sort, filter, show the selection only; Enter or typing edits a cell; Shift+click selects a range;
  Ctrl+C / Ctrl+V copy and paste with Excel (one undoable edit).
- **Issues**: checks run after every edit: duplicate names, references to missing objects (curves,
  time series, unit hydrographs…), links without cross-section, bad lengths and roughness, adverse
  slopes, offsets below the node inverts, subcatchments without subareas or infiltration, unconnected
  nodes, sub-networks that drain to no outfall. Click an issue to select the object.
- **Data → Climatology…**: evaporation (constant, monthly, time series, temperatures, climate file,
  recovery pattern, dry only), temperature, wind speed, snowmelt, areal depletion and monthly
  adjustments. **Sections as text…** edits any section as text (water quality, LID, groundwater…).

Basemap tiles come from OpenStreetMap (© OpenStreetMap contributors); the app identifies itself
with its own User-Agent, as the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
requires. The tile URL is stored in the project file.

## CLI

```bash
cargo build --release
```

```bash
target/release/swmm-cli engine add epa52 "C:\Program Files\EPA SWMM 5.2.4\runswmm.exe"
```

```bash
target/release/swmm-cli run model.inp --label "base case" --cache
```

Other commands:

- `swmm-cli runs model.inp`: previous runs with status and continuity error.
- `swmm-cli inp info|check|validate`: sections and object counts, simulation period, external files; lossless round-trip check; model checks (exit code 1 on errors).
- `swmm-cli rpt report.rpt --blocks`: errors, warnings, continuity, list of report blocks.
- `swmm-cli out info|cache|stats|events|export|synth`: inspect results, build the cache, whole-run statistics (e.g. max depth of every node), events per object and year (`--threshold`, `--gap` hours), CSV export, synthetic files for benchmarks.

No SWMM engine is bundled: register any `runswmm.exe`-compatible executable (EPA SWMM 5.1/5.2, OWA, custom builds).

## Tests

```bash
cargo test --workspace
```

Optional, with external resources:

- `SWMM_ENGINE=<path to runswmm.exe>`: run the engine integration tests.
- `SWMM_INP_CORPUS=<folder>`: byte-exact round-trip of every `.inp` under the folder.
- `SWMM_OUT_SAMPLE=<file.out>`: read a file produced by a real engine.

Benchmarks: `cargo bench`, and `cargo run --release -p swmm-out --example bench_large -- big.out` on files made with `swmm-cli out synth`.

`swmm-cli out synth big.out --nodes 50000 --links 52000 --subcatchments 10000 --periods 400 --inp big.inp`
also writes a matching model (same IDs, on a grid in Lambert 93) to try the app at scale.

UI smoke test of the running app (driven through the WebView2 DevTools protocol; opens the model,
sets the CRS, selects with the mouse, animates, plots, opens the report, measures time-step latency
and pan frame rate):

```bash
export WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
```

```bash
node app/ui/e2e/smoke.mjs model.inp EPSG:2154 shots
```

Editing test (real mouse and keyboard; use a copy of `testdata/tiny.inp` and `storm.dat`, and a
scratch settings file in `SWMM_STUDIO_SETTINGS` since the test registers the engine):

```bash
node app/ui/e2e/edit.mjs copy/tiny.inp "C:\Program Files\EPA SWMM 5.2.4 (64-bit)\runswmm.exe" shots EPSG:2154
```

Edit latency on a large model: `node app/ui/e2e/edit-perf.mjs big.inp EPSG:2154`.

Analysis test (runs the model twice, then run history, comparison, envelope maps, profile, events,
aggregated plots, tabular editor, validation, climatology, section text, exports):

```bash
node app/ui/e2e/analysis.mjs copy/tiny.inp "C:\Program Files\EPA SWMM 5.2.4 (64-bit)\runswmm.exe" shots
```

Analysis timings on a large model: `node app/ui/e2e/analysis-perf.mjs big.inp EPSG:2154`.

## Releases

Versions follow [SemVer](https://semver.org/). The only version is `workspace.package.version` in
`Cargo.toml`: the app, its installers and its User-Agent take it from there. To release, set the new
version, commit, then tag and push:

```bash
cargo set-version --workspace 0.2.0
```

```bash
git commit -am "Release 0.2.0" && git tag v0.2.0 && git push --follow-tags
```

The tag starts the *Release* workflow, which checks the tag against the version, builds the MSI and
NSIS installers and attaches them to a **draft** GitHub release with generated notes; review it and
publish it on GitHub. A tag with a `-` is marked as a pre-release; the MSI installer only accepts
numeric pre-releases (`v0.2.0-1`, not `v0.2.0-beta.1`).

`cargo set-version` comes from `cargo install cargo-edit`.

## Licence

MIT
