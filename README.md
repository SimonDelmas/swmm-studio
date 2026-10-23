# SWMM Studio

Visualize, edit, simulate and analyse EPA SWMM 5 models, built for large networks
(100k+ objects) and long continuous simulations (multi-year runs, `.out` files up to 10 GB).

See [SPEC.md](SPEC.md) for the functional and technical specification and the roadmap.

**Status: M1 (results viewer).** Desktop app: open a model, set its coordinate system, see the
network over OpenStreetMap, select objects and read their properties, animate results on the map
with a zoomable timeline, plot time series of any length, browse the `.rpt` tables. Editing comes
in M2.

## Crates

| Crate | Purpose |
|---|---|
| [`swmm-inp`](crates/swmm-inp) | Lossless `.inp` reader/writer: untouched lines are written back byte-for-byte (comments, alignment, line endings, unknown sections, UTF-8/Windows-1252). Options, simulation period, external file references. |
| [`swmm-out`](crates/swmm-out) | Memory-mapped `.out` reader (any size, partial files of running simulations), writer, synthetic generator, and the **results cache**: an object-major, losslessly compressed copy built in one pass, with per-chunk min/max/time-of-max/sum, for fast multi-year series and whole-run envelopes. |
| [`swmm-rpt`](crates/swmm-rpt) | `.rpt` parser: errors/warnings (with input line and object), continuity errors, RDII, every summary block as a table / key-values / text. |
| [`swmm-engine`](crates/swmm-engine) | Engine registry (`%APPDATA%\SwmmStudio\settings.json`), version detection, runs in `<model>_runs/<timestamp>_<label>/` with progress, cancel and a `run.json` record. |
| [`swmm-geo`](crates/swmm-geo) | EPSG registry (search by code or name), reprojection of model coordinates to WGS 84 (pure Rust, `proj4rs`), Web Mercator, R-tree for box / lasso selection and picking. |
| [`swmm-model`](crates/swmm-model) | Network view of a model: nodes, links, subcatchments, rain gages, connectivity and map geometry; named properties of any object; numeric attributes for thematic maps. |
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

`cargo tauri build` makes the MSI and NSIS installers.

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
- `swmm-cli inp info|check`: sections and object counts, simulation period, external files; lossless round-trip check.
- `swmm-cli rpt report.rpt --blocks`: errors, warnings, continuity, list of report blocks.
- `swmm-cli out info|cache|stats|export|synth`: inspect results, build the cache, whole-run statistics (e.g. max depth of every node), CSV export, synthetic files for benchmarks.

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

## Licence

MIT
