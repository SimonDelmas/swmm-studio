# Developing SWMM Studio

How the project is built, organised and tested. For what the application does, see the [README](README.md); for the full specification and roadmap, [SPEC.md](SPEC.md).

## Crates

| Crate | Purpose |
|---|---|
| [`swmm-inp`](crates/swmm-inp) | Lossless `.inp` reader/writer: untouched lines are written back byte-for-byte (comments, alignment, line endings, unknown sections, UTF-8/Windows-1252). Options, simulation period, external file references. |
| [`swmm-out`](crates/swmm-out) | Memory-mapped `.out` reader (any size, partial files of running simulations), writer, synthetic generator, and the **results cache**: an object-major, losslessly compressed copy built in one pass, with per-chunk min/max/time-of-max/sum, for fast multi-year series and whole-run envelopes. |
| [`swmm-rpt`](crates/swmm-rpt) | `.rpt` parser: errors/warnings (with input line and object), continuity errors, RDII, every summary block as a table / key-values / text. |
| [`swmm-engine`](crates/swmm-engine) | Engine registry (`%APPDATA%\SwmmStudio\settings.json`), version detection, runs in `<model>_runs/<timestamp>_<label>/` with progress, cancel and a `run.json` record. |
| [`swmm-geo`](crates/swmm-geo) | EPSG registry (search by code or name), reprojection of model coordinates to WGS 84 (pure Rust, `proj4rs`), Web Mercator, R-tree for box / lasso selection and picking. |
| [`swmm-model`](crates/swmm-model) | Network view of a model: nodes, links, subcatchments, rain gages, connectivity and map geometry; named properties of any object; numeric attributes for thematic maps; expressions over the values of objects (selection queries). Editing: undoable line-level transactions, field schema (types, units, validation), rename and delete with every reference, curves / time series / patterns / unit hydrographs / transects. |
| [`swmm-analysis`](crates/swmm-analysis) | Statistics of results over any range of periods (max, min, mean, time of max, total volume / depth, time above a threshold) from the cache's chunk summaries; calendar days / months / years; event detection with a minimum inter-event time and per-year statistics; shortest path and longitudinal profile between nodes. |
| [`swmm-obs`](crates/swmm-obs) | Observed series read from tabular files (CSV and other delimited text, Excel, OpenDocument, Parquet): column of dates and times found and read (ISO, day or month first), series sorted and decimated to min/max per bucket, default mapping of the columns to an object's variables. |
| [`swmm-cli`](crates/swmm-cli) | Command-line front-end. |
| [`app/src-tauri`](app/src-tauri) | Desktop application (Tauri 2): session state, commands, background results cache. |
| [`app/ui`](app/ui) | Front-end (React, TypeScript, MapLibre GL, deck.gl, uPlot). |

## Building the desktop app

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

`scripts/build-exe.ps1` does both steps: it builds the front-end, then `target/release/swmm-studio.exe`
(`-Installers`: also the installers, in `target/release/bundle/`; `-Out <folder>`: copies them there).

```powershell
./scripts/build-exe.ps1
```

Basemap tiles come from OpenStreetMap (© OpenStreetMap contributors); the app identifies itself
with its own User-Agent, as the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
requires. The tile URL is stored in the project file.

## Front-end layout

The modules of `app/ui/src` are in layers; a module imports only from its own layer or from a
lower one. `npm run build` checks it (`scripts/check-layers.mjs`).

| Layer | Modules | Holds |
|---|---|---|
| types | `types`, `analysisTypes`, `uiTypes` | What the back-end sends and what the state of the interface is made of. |
| libraries | `api`, `format`, `classify`, `chartSvg`, `geometryPatch`, `latest` | Calls to the back-end and functions that know nothing of the state. |
| store | `store` | The state and how to read, change and follow it. |
| actions | `actions/`, `exporting`, `dragSeries` | What the user can do: open, edit, run, style, open and close tabs, save files. |
| features | `hooks/`, `plot/`, `profile/` | Hooks shared by components; time series and profiles. |
| map | `map/` | The map: viewers, layers, drawing tools. |
| components | `components/` | Panels and dialogs. |
| application | `App`, `main` | The window. |

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

- `SWMM_ENGINE=<path to runswmm.exe>`: run the engine integration tests. They also check, against
  that engine, what the editors assume about the input format (required fields, where a custom
  shape keeps its barrels, section names, comments and quotes, curves named by LID drains and inlets).
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

Profile test (profile tool, saved profiles): `node app/ui/e2e/profile.mjs copy/tiny.inp shots`.
Select by query test (Q, replace / add / intersect / remove, names inserted from the dialog, errors): `node app/ui/e2e/query.mjs copy/tiny.inp shots`.
X-Y plot test (runs the model, "+" → X-Y, depth vs flow, fixed x, system pair, joined points, box zoom, hover and click on a point, values against the results, rename and close): `node app/ui/e2e/xy.mjs copy/tiny.inp "C:\Program Files\EPA SWMM 5.2.4 (64-bit)
unswmm.exe" shots`.
Time series legend test (hide a line from the legend, kept when the chart is made again, shown again): `node app/ui/e2e/legend.mjs copy/tiny.inp "C:Program FilesEPA SWMM 5.2.4 (64-bit)
unswmm.exe" shots`.
Control rules test (adds rules to the model, issue with its line in the Issues tab, opened at the line, highlighting, checked while typing, fixed): `node app/ui/e2e/controls.mjs copy/tiny.inp shots`.
Map extras test (runs the model; flow arrows against the flows, greyscale basemap saved in the project, tooltips of a node and a link, measure tool with Enter, Backspace, Escape and a double-click): `node app/ui/e2e/map-extras.mjs copy/tiny.inp "C:\Program Files\EPA SWMM 5.2.4 (64-bit)\runswmm.exe" shots`.
External changes test (the model changed by another program offered, kept, offered again, reloaded; the unsaved-changes warning; saving from the app not reported; the results reloaded where the system lets the loaded `.out` be written over): `node app/ui/e2e/files.mjs m.inp`, on a model with results such as `swmm-cli out synth m.out --nodes 20 --links 20 --subcatchments 5 --periods 50 --inp m.inp`.
Command palette test (Ctrl+P, filtering, arrows, recent commands, Escape): `node app/ui/e2e/palette.mjs copy/tiny.inp`.
Dialog keyboard, name link and edit-queue test (Escape, Tab, object names loaded once, no edit sent to a model opened since, map drawn when a model is reopened with its labels on): `node app/ui/e2e/dialogs.mjs copy/tiny.inp`.
Observed data test (link a file to a link through the dialog, proposed mapping, saved in the project, drawn on the plot), on a model with results and a file with columns such as `C1 Débit (l/s)`, `C1 Hauteur (m)`: `node app/ui/e2e/observed.mjs copy/tiny.inp mesures.csv C1 shots`.

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

