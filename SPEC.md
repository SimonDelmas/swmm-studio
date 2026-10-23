# SWMM Studio — Functional & Technical Specification (Draft v0.3)

A Windows desktop application with a Rust core and a web front-end (Tauri) to **visualize, edit, simulate and analyse EPA SWMM 5 models**. It targets large models (100k+ objects, `.out` files up to 10 GB) and stays 100% compatible with the standard `.inp` / `.rpt` / `.out` files.

### Decisions log
| # | Decision | Date |
|---|---|---|
| D1 | Platform: **Windows only** (Windows 10/11 x64) for now | 2026-10-23 |
| D2 | UI: **web front-end** in a Tauri 2 shell (WebView2), Rust backend | 2026-10-23 |
| D3 | Scale: **> 100,000 objects**, **`.out` up to 10 GB** | 2026-10-23 |
| D4 | Background maps required; **user defines the model CRS** | 2026-10-23 |
| D5 | Modules in scope: **hydraulics, hydrology, RDII** (others preserved on save but not edited) | 2026-10-23 |
| D6 | Engine: **external SWMM executable, configurable path** | 2026-10-23 |
| D7 | Front-end: **React + TypeScript** | 2026-10-23 |
| D8 | LID: **out of scope** for now (sections preserved on save) | 2026-10-23 |
| D9 | Snowmelt, aquifers/groundwater: **editors later**; preserved on save until then | 2026-10-23 |
| D10 | Basemap: **OSM** (tile URL configurable) | 2026-10-23 |
| D11 | Typical results: **5-min report step, multi-year continuous simulations** (~105k periods/year) | 2026-10-23 |
| D12 | **No bundled engine**: the user must configure one before running | 2026-10-23 |
| D13 | Licence: **MIT** | 2026-10-23 |

---

## 1. Goals and non-goals

### Goals
- Open any valid SWMM 5.1/5.2 `.inp` file and save it back **without loss** (untouched lines byte-identical, comments preserved).
- Smooth map interaction (60 fps pan/zoom, animated results) on 100k+ objects.
- Results exploration on `.out` files up to 10 GB without loading them in RAM.
- Simulation through a user-configured SWMM executable (EPA `runswmm.exe`, custom builds).
- Headless CLI sharing the same Rust core.

### Non-goals (v1)
- Reimplementing the SWMM solver.
- Editors for water quality (pollutants, land uses, buildup/washoff, treatment), LID, snowmelt and groundwater. These sections are **preserved** on save and visible as raw text. Snowmelt and groundwater editors are planned after v1.
- Full GIS application, 3D, multi-user, macOS/Linux.

---

## 2. Use cases
1. **UC1 – Inspect**: open `.inp`, set CRS, see the network over a basemap, click an object, read its properties.
2. **UC2 – Edit**: move/add/delete objects, edit attributes (single or bulk), edit curves / time series / patterns / unit hydrographs, save.
3. **UC3 – Simulate**: pick an engine, configure options, run, follow progress, read errors/warnings and continuity errors.
4. **UC4 – Analyse**: animated map coloured by a result variable, time-series plots, longitudinal profiles, summary tables, max envelopes.
5. **UC5 – Compare**: compare two runs (difference maps, overlaid hydrographs, delta tables).

---

## 3. Functional features

Priority: **P0** = MVP, **P1** = v1.0, **P2** = later.

### 3.1 Project & files
| ID | Feature | Prio |
|---|---|---|
| F-FILE-1 | Open / save / save-as `.inp` (SWMM 5.1 & 5.2 syntax) | P0 |
| F-FILE-2 | Lossless round-trip: comments, section order, unknown/unsupported sections, formatting of untouched lines | P0 |
| F-FILE-3 | Load `.out` (any size, lazy) and `.rpt`, including results produced outside the app | P0 |
| F-FILE-4 | Project file (`<model>.swproj`, JSON) next to the `.inp`: CRS, basemap, map styles, view, linked runs, engine choice | P0 |
| F-FILE-5 | Recent files, autosave / crash recovery | P1 |
| F-FILE-6 | Detect external modification of `.inp`/`.out` and offer reload | P2 |

### 3.2 Coordinate system & background maps
| ID | Feature | Prio |
|---|---|---|
| F-GEO-1 | User sets the model CRS (EPSG code search by code/name, e.g. `EPSG:2154` Lambert 93, `EPSG:3942–3950` CC zones) or "None / local coordinates" | P0 |
| F-GEO-2 | Reprojection of model coordinates to Web Mercator for display; edits are reprojected back so the `.inp` always stays in the model CRS | P0 |
| F-GEO-3 | OSM raster tile basemap (default `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, URL configurable, attribution shown, OSM tile usage policy respected: identifying User-Agent, HTTP caching, no bulk prefetch) | P0 |
| F-GEO-4 | Basemap opacity, on/off, greyscale | P1 |
| F-GEO-4b | Additional providers (XYZ templates, WMTS/WMS, e.g. IGN Géoplateforme) | P2 |
| F-GEO-5 | Georeferenced raster image as background (PNG/JPG + world file, GeoTIFF) | P1 |
| F-GEO-6 | Local tile cache (offline use of previously viewed areas) | P2 |
| F-GEO-7 | Vector overlays (GeoJSON / shapefile / GeoPackage), read-only | P2 |
| F-GEO-8 | CRS = None → map shown in plain cartesian view, basemaps disabled; EPA `[BACKDROP]` image supported | P1 |

### 3.3 Map visualization
| ID | Feature | Prio |
|---|---|---|
| F-MAP-1 | Draw nodes (junction, outfall, storage, divider), links (conduit, pump, orifice, weir, outlet) with vertices, subcatchments (polygons), rain gages, labels (LOD-dependent) | P0 |
| F-MAP-2 | Pan / zoom / zoom-to-extent / zoom-to-selection at 60 fps with 100k+ objects | P0 |
| F-MAP-3 | Selection: click, box, lasso, by attribute query; highlight; sync with tables & property panel | P0 |
| F-MAP-4 | Thematic styling: colour/width/size by attribute or result, classes (equal interval, quantile, custom breaks), legend editor | P0 |
| F-MAP-5 | Flow direction arrows (from results sign), subcatchment → outlet connectors | P1 |
| F-MAP-6 | Find object by ID, measure distance/area, tooltips | P1 |

### 3.4 Editing
| ID | Feature | Prio |
|---|---|---|
| F-EDIT-1 | Property panel for all in-scope object types, with units (from `FLOW_UNITS`) and validation | P0 |
| F-EDIT-2 | Graphical editing: add node/link/subcatchment, move, add/remove vertices, reconnect link ends, delete with cascade warning | P0 |
| F-EDIT-3 | Undo / redo for every edit | P0 |
| F-EDIT-4 | Editors: curves, time series, patterns, simulation options, rain gages, transects | P0 |
| F-EDIT-5 | Hydrology editors: subcatchments, subareas, infiltration (Horton, modified Horton, Green-Ampt, modified Green-Ampt, CN), evaporation, climatology | P1 |
| F-EDIT-5b | Aquifers / groundwater, snowpacks editors | P2 |
| F-EDIT-6 | **RDII editors**: unit hydrographs (`[HYDROGRAPHS]`, 3 triangles × short/medium/long, monthly), node assignment (`[RDII]`: UH group + sewershed area), bulk assignment on selection | P0 |
| F-EDIT-7 | Control rules editor (text with syntax highlight + validation) | P1 |
| F-EDIT-9 | Tabular editor (virtualized grid per object type, 100k rows), sort/filter, copy/paste with Excel | P1 |
| F-EDIT-10 | Bulk edit with expressions on selection (`diameter = diameter * 1.2 where slope < 0.005`) | P1 |
| F-EDIT-11 | Model validation: duplicate IDs, orphan nodes, missing curves/time series, adverse slopes, offsets below invert, disconnected sub-networks, RDII on non-existent UH; issue list with jump-to-object | P1 |
| F-EDIT-12 | Auto-compute: conduit length from geometry, subcatchment area from polygon (in model CRS units) | P1 |
| F-EDIT-13 | Raw text view of any section (incl. water-quality sections, which are otherwise read-only) | P1 |
| F-EDIT-14 | GIS import (GeoJSON/shapefile/GPKG/CSV) with field mapping; export network to GeoJSON/GPKG | P2 |
| F-EDIT-15 | Scenarios: named override sets on a base model | P2 |

### 3.5 Simulation
| ID | Feature | Prio |
|---|---|---|
| F-SIM-1 | **Engine registry** in app settings: list of engines `{name, exe path, detected version}`; one default; per-project override. No engine is bundled: "Run" is disabled with a link to settings until one is configured | P0 |
| F-SIM-2 | Run = write model to a temp `.inp`, launch `<exe> model.inp model.rpt model.out` as a child process; UI stays responsive | P0 |
| F-SIM-3 | Progress from engine stdout (parsed, tolerant of unknown formats → indeterminate bar), elapsed time, cancel (kill process) | P0 |
| F-SIM-4 | Errors/warnings from `.rpt` mapped to objects (clickable); continuity errors (runoff, flow routing, **RDII**) highlighted against thresholds | P0 |
| F-SIM-5 | Run history: each run in `<model>_runs/<timestamp>_<label>/` with `.inp` snapshot, `.rpt`, `.out`, metadata; re-open, label, delete | P1 |
| F-SIM-6 | Batch runs / parameter sweeps, several processes in parallel | P2 |
| F-SIM-7 | Live results during a run (requires a DLL-based runner; not possible with a plain exe) | P2 |

### 3.6 Results visualization & analysis
| ID | Feature | Prio |
|---|---|---|
| F-RES-1 | `.rpt` summary tables: node depth/flooding/surcharge, link flow/surcharge, outfall loading, subcatchment runoff, **RDII**, continuity | P0 |
| F-RES-2 | Time-series plots for any object/variable (incl. node lateral inflow = RDII contribution), multi-series, multi-axis, export PNG/SVG/CSV. **Multi-resolution**: a multi-year series (500k+ points) is shown as min/max per pixel, with more detail loaded as you zoom in | P0 |
| F-RES-3 | Animated map: zoomable timeline (year → day → step), play/pause, speed and step stride (every N periods), jump to date, jump to an object's time of max or to the next event | P0 |
| F-RES-3b | Time aggregation over the timeline: daily/monthly/yearly max, mean, volume per object (maps and plots) | P1 |
| F-RES-3c | **Long-term event statistics** (continuous simulation): event detection on a variable with threshold + minimum inter-event time; per object/year: count of events, total volume, duration, peak (e.g. overflow frequency at outfalls / CSOs, flooding events at nodes); event table with jump-to-time | P1 |
| F-RES-4 | Longitudinal profile along a path (auto shortest path between 2 nodes): ground, inverts, crowns, animated HGL, max HGL envelope | P0 |
| F-RES-5 | Envelope maps: max/min/mean/time-of-max/duration over threshold per object (computed by background scan, cached) | P1 |
| F-RES-6 | Run comparison: difference maps, overlaid series, delta tables | P1 |
| F-RES-7 | X-Y / scatter plots (depth vs flow, etc.) | P1 |
| F-RES-8 | Observed data import (CSV) and goodness-of-fit (NSE, KGE, RMSE, peak/volume error) — useful for RDII calibration | P2 |
| F-RES-9 | Export figures (PNG/SVG) and any table (CSV/XLSX) | P1 |

### 3.7 CLI
| ID | Feature | Prio |
|---|---|---|
| F-CLI-1 | `swmm-cli run model.inp [--engine name]` → summary, non-zero exit on error | P1 |
| F-CLI-2 | `swmm-cli out export model.out --objects ... --vars ... --format csv\|parquet` | P1 |
| F-CLI-3 | `swmm-cli inp validate`, `inp to-geojson` | P2 |

### 3.8 UX general
- Dockable panels: map, model browser tree, properties, tables, plots, profile, log.
- Light/dark theme; UI in **English and French**.
- Units follow the model (`FLOW_UNITS` → US or SI).
- Keyboard shortcuts, command palette (Ctrl+K).

---

## 4. Architecture

### 4.1 Overview

```
┌────────────────────────── WebView2 (front-end, TypeScript) ──────────────────────────┐
│  Map (MapLibre basemap + deck.gl network layers)   Plots (uPlot)   Grid (virtualized) │
│  Panels / docking   Property forms   State store (view state only)                    │
└───────────────▲──────────────────────────────────────────────┬───────────────────────┘
                │ binary buffers (geometry, result frames)     │ commands (JSON)
┌───────────────┴──────────────── Tauri 2 / Rust backend ──────▼───────────────────────┐
│  App state: Model (source of truth) · Undo stack · ResultsStore(s) · Engine runner    │
└───────────────────────────────────────────────────────────────────────────────────────┘
       swmm-inp   swmm-model   swmm-out   swmm-rpt   swmm-geo   swmm-engine   swmm-analysis
```

**The Rust backend is the single source of truth** for the model and results. The front-end sends commands (`edit`, `undo`, `query`, `get_frame`…) and receives patches or binary buffers. It never parses SWMM files itself.

### 4.2 Repository layout

```
swmm_studio/
├── crates/
│   ├── swmm-inp/        # lossless .inp parser/writer (CST) + typed views
│   ├── swmm-model/      # domain model, graph, validation, edit commands, undo/redo
│   ├── swmm-out/        # .out reader: mmap, lazy, frame & series extraction, stats cache
│   ├── swmm-rpt/        # .rpt parser (tables, continuity, errors/warnings)
│   ├── swmm-geo/        # CRS registry, reprojection, spatial index, geometry utils
│   ├── swmm-engine/     # engine registry, child-process runner, progress parsing, run history
│   ├── swmm-analysis/   # profiles, envelopes, comparisons, statistics
│   └── swmm-cli/        # headless binary
├── app/
│   ├── src-tauri/       # Tauri commands, app state, settings
│   └── ui/              # TypeScript front-end (Vite)
└── testdata/            # EPA example models + anonymised real models
```

Rule: **no Tauri dependency in `crates/`**. The core is testable headless and reused by the CLI.

### 4.3 Technical choices

| Concern | Choice | Rationale |
|---|---|---|
| Shell | **Tauri 2** (WebView2, preinstalled on Win 10/11) | Small binary, Rust backend, binary IPC |
| Front-end framework | **React + TypeScript + Vite** (alt: Svelte) | Ecosystem: deck.gl bindings, docking (`dockview`), grids |
| Basemap | **MapLibre GL JS** (raster XYZ/WMTS/WMS sources) | Free, WebGL, works with any tile provider |
| Network layers | **deck.gl** (`ScatterplotLayer`, `PathLayer`, `SolidPolygonLayer`) with **binary attributes**, interleaved into MapLibre | Handles millions of features; colour update = replace one typed array → animation at 60 fps |
| Cartesian mode (no CRS) | deck.gl `OrthographicView` without basemap | Same layers |
| Plots | **uPlot** (time series, 1M+ points), profile on custom canvas/deck.gl | Speed; Plotly too slow for long series |
| Tables | Virtualized grid (TanStack Table + virtualizer, or AG Grid Community) | 100k rows |
| IPC | Tauri commands; large data returned as **raw `ArrayBuffer`** (`tauri::ipc::Response`), not JSON | 100k floats/frame = 400 KB, < 5 ms |
| Reprojection | **`proj4rs`** (pure Rust) + EPSG definitions bundled (`crs-definitions`) | No PROJ/C dependency on Windows; reprojection done once in Rust, sent as Float32 Web-Mercator offsets around a local origin (precision) |
| Spatial index | `rstar` (picking, box/lasso selection in Rust for exactness) | — |
| `.out` access | `memmap2`, offsets computed from header; never read whole file | 10 GB files |
| Data model | `slotmap` arenas with stable keys, ID↔key hash map, `petgraph` for connectivity | Fast edits, stable references for undo |
| Undo/redo | Command pattern (apply/revert), commands also produce UI patches | — |
| Settings | `%APPDATA%\SwmmStudio\settings.json` (engines, basemaps, proxy, language) | — |
| Logging/errors | `tracing` (file log in `%LOCALAPPDATA%`), `thiserror` / `anyhow` | — |

### 4.4 Large `.out` strategy (10 GB, multi-year, 5-min step)

The `.out` file stores, for each reporting period, a timestamp followed by all subcatchment, node, link and system values. With a 5-min step a year is ~105,120 periods, so a 5-year run has ~525,000. The two common access patterns behave very differently:

| Access | Layout in `.out` | Cost on a 10 GB file |
|---|---|---|
| Map frame at time *t* (all objects) | one contiguous block | < 1 ms, always fast |
| Time series of one object | one value per period, 525k values spread over the whole file | the disk reads almost the **entire file** (each period is only a few KB, so every page is touched): ~3–5 s on NVMe, minutes on HDD / network share |

Reading time series straight from the `.out` is too slow for multi-year runs, so the reader works in two tiers:

1. **Direct access (immediately on open)**: header, IDs, time index and map frames read through `memmap2` with 64-bit offsets (files > 4 GB). Map animation works right away.
2. **Results cache, built in the background (one sequential pass)**:
   - The `.out` is read once, in order, at full disk speed. Blocks of periods are transposed in RAM (block size adapted to a memory budget, default 1 GB) and written **object-major**.
   - The cache file `<model>.out.swcache` stores, for each object and variable, chunks of *N* periods (default 4,096) compressed with byte-shuffle + `zstd` (expected 3–10× smaller, since many series are mostly zero), plus per-chunk **min / max / sum / count over thresholds**.
   - The per-chunk summaries are a ready-made multi-resolution pyramid: plots, envelopes (max, time of max), daily/monthly/yearly aggregates and the first pass of event detection are computed from them without decompressing raw values.
   - The same pass computes global envelopes per object (max, min, mean, time of max), so envelope maps are ready as soon as the pass finishes.
   - Multi-threaded (`rayon`) compression; progress and ETA shown in the status bar; the app stays fully usable meanwhile (series requests fall back to direct strided reads with a warning).
   - Cache validity is keyed by `.out` size + mtime + header hash. Stored next to the `.out` by default, or in a configurable cache folder. It can be deleted and rebuilt at any time.
3. **Plot requests** always go through Rust: `get_series(object, var, t0, t1, pixels)` returns at most ~2 × `pixels` points (min/max per bucket) from the right level of the pyramid, so a 5-year series never sends 525k points to the UI.

Memory: mmap plus bounded buffers only; no full load into RAM.

Note on consistency: a 100k-object model has ~2–3 MB per period, so 10 GB is only ~4,000 periods; a multi-year 5-min run of that size would be ~1 TB. The design therefore covers both extremes — **many objects with few periods** (frame-heavy) and **fewer objects with very many periods** (series-heavy) — and the cache block size adapts to the period size.

### 4.5 Engine integration
- Engine = executable called with `exe input.inp report.rpt output.out` (EPA `runswmm.exe` / `swmm5.exe` convention).
- Version detection: run once with no arguments / `--version` and parse output; otherwise read the version from the `.out` header after the first run.
- Working directory = the run folder; external files referenced by the model (rainfall files, hotstart, inflows) are resolved relative to the original `.inp` folder → rewritten as absolute paths in the temp `.inp`.
- Cancel = kill the process tree (Windows Job Object so child processes are killed too).
- No engine is bundled. A first-run check guides the user to configure one; the path is validated (file exists, runs, produces a recognizable version).

### 4.6 Performance targets
| Metric | Target |
|---|---|
| Open 100k-object `.inp` (parse + model + geometry sent to UI) | < 2 s |
| Map pan/zoom at 100k objects + basemap | 60 fps |
| Change displayed time step (frame read + colour update) | < 30 ms |
| Open 10 GB `.out` (header, IDs, time index), map usable | < 1 s |
| Build results cache + envelopes, 10 GB, NVMe SSD | < 60 s, background (bounded by disk read speed) |
| Multi-year series plot (any zoom), cache built | < 50 ms |
| Multi-year series plot, cache not built yet | < 5 s on NVMe (direct strided read) |
| Event statistics on one variable for all outfalls, cache built | < 2 s |
| Single edit + undo round-trip to UI | < 20 ms |

---

## 5. Quality & testing
- **Round-trip**: every model in `testdata/` → `parse → write → diff == ∅`.
- **`.out` reader**: cross-check against the EPA output API (`swmm-output` C library) on example files. A **synthetic `.out` generator** (in Rust) produces test files for both extremes: 100k objects × 4k periods, and 2k objects × 525k periods, ~10 GB each.
- **Results cache**: values read through the cache must match direct reads exactly (lossless compression); summaries must match full recomputation.
- **Undo/redo**: property-based tests (`proptest`), apply + revert = identity.
- **Reprojection**: reference points for Lambert 93 / CC zones vs PROJ results.
- Benchmarks (`criterion`): parsing, frame extraction, series extraction, envelope scan.
- Front-end: Playwright smoke tests on the Tauri app.
- CI: GitHub Actions `windows-latest`; MSI/NSIS installer built by Tauri.

---

## 6. Roadmap

| Milestone | Content | Outcome |
|---|---|---|
| **M0 – Core** | Workspace, `swmm-inp` lossless round-trip, `swmm-out` direct reader + synthetic generator, **results cache** (transpose + summaries), `swmm-rpt` basics, `swmm-engine` exe runner, `swmm-cli run` / `out export` | Headless open / run / read, benchmarked on 10 GB files |
| **M1 – Viewer** | Tauri shell, CRS setting + OSM basemap, deck.gl network map, selection, read-only properties, animated map with zoomable timeline, multi-resolution plots, `.rpt` tables | Large-model results viewer |
| **M2 – Editor** | Property editing, graphical editing, undo/redo, curves/TS/patterns/options, **RDII editors**, engine registry UI, save | Daily modelling without EPA GUI |
| **M3 – Analysis** | Profiles, envelope maps, time aggregation, **long-term event statistics**, run history & comparison, hydrology editors, tabular editor, validation, exports | v1.0 |
| **M4 – Advanced** | Other basemap providers, raster backgrounds, tile cache, snow/groundwater editors, GIS import/export, bulk expressions, scenarios, batch runs, observed data & calibration | v1.x |

### 6.1 M0 status (done, 2026-10-23)

Delivered: `swmm-inp`, `swmm-out` (reader, writer, synthetic generator, results cache), `swmm-rpt`, `swmm-engine`, `swmm-cli` (`run`, `runs`, `engine`, `inp info|check`, `rpt`, `out info|cache|stats|export|synth`), CI.

Verification:
- `.inp` round-trip byte-exact on 147 real models (up to 82 MB / ~220k objects).
- `.out` values identical to the EPA output library (`swmm.toolkit.output`) on files from SWMM 5.1.15 and 5.2.4 engines, read directly and through the cache.
- 83 real `.rpt` files parsed (largest 48 MB, 77k-node tables).
- Engine runs tested with an OWA 5.2.4 build and a 5.1.15 build.

Measured on a 15 W laptop (Core Ultra 5 135U, NVMe at ~750 MB/s sequential read):

| Metric | Many periods: 800 objects × 525,960 periods (5 y at 5 min), 9.9 GB | Many objects: 100k objects × 4,150 periods, 10 GB | Target |
|---|---|---|---|
| Open `.out` | 1–2 ms | 16–50 ms | < 1 s |
| Map frame (all links, one step) | 0.02 ms | 0.1–0.7 ms | < 30 ms |
| Full series, no cache | 20–58 s | 0.9–1.7 s | < 5 s (missed for multi-year: cache needed) |
| Build cache | 18–27 s (14× smaller) | 26–32 s (26× smaller) | < 60 s |
| Full series, cached | 6–70 ms | 0.2 ms | < 50 ms |
| Envelope of all nodes, cached | 3–5 ms | 26 ms | — |
| Parse 82 MB `.inp` (~220k objects) | 1.25 s | | < 2 s |

Findings that change the spec:
- Reading a multi-year series directly from the `.out` is far slower than estimated in §4.4 (it is bound by page faults over the whole file). **M1 must build the cache automatically in the background when a large `.out` is opened**, and show direct-read results only for short ranges until it is ready.
- Engines may exit with code 0 when the model has input errors: the run status comes from the report's `ERROR` lines and from the `.out` epilogue, not from the exit code.
- Engines can be run without a console window, so the runner stops them itself on cancel (Ctrl+C in the CLI). `runswmm` starts no child processes, so a Windows Job Object is not needed.
- Not done in M0: Parquet export (CSV only; Parquet stays in F-CLI-2, P1).

### 6.2 M1 status (done, 2026-10-23)

Delivered:
- `swmm-geo`: EPSG registry with search by code or name, `EPSG:xxxx` or PROJ strings, reprojection to WGS 84 with `proj4rs` (datum shifts by `towgs84`), Web Mercator, R-tree (box, lasso, nearest).
- `swmm-model`: read-only network (nodes, links, subcatchments, rain gages, connectivity, geometry), named properties of every in-scope section, numeric input attributes for thematic maps.
- `swmm-out`: multi-resolution min/max from the cache's chunk summaries (no decompression for coarse zooms), whole-run statistics with or without cache, next-event search that skips chunks below the threshold.
- Tauri 2 app (`app/src-tauri`, `app/ui`): F-FILE-1 (open), F-FILE-3, F-FILE-4 (`.swproj`: CRS, basemap, view, styles, linked results), F-GEO-1/2/3, F-GEO-8 (cartesian view without CRS; `[BACKDROP]` not drawn yet), F-MAP-1/2/3/4, F-SIM-4 (report messages linked to objects, continuity thresholds), F-RES-1, F-RES-2 (PNG/CSV; no SVG), F-RES-3, find object by ID (F-MAP-6, partly).
- Results cache built automatically in the background when a `.out` without a valid cache is opened (§6.1 finding).
- `swmm-cli out synth --inp` writes a model matching a synthetic `.out` (same IDs, grid in Lambert 93) for tests at scale.

Verification: Rust unit tests for every crate and for the app session (synthetic `.out` with shuffled object order, report, CRS, selection, geometry buffer); UI smoke test (`app/ui/e2e/smoke.mjs`, Playwright over the WebView2 DevTools protocol, real mouse events) on the release build with: `tiny.inp` (EPA 5.2.4 run), a real 2,905-node / 3,118-link model in NTF Lambert Sud (EPSG:27563, 68 MB `.out` from EPA 5.2.4; pipes line up with the streets of the OSM basemap), a 112,001-object synthetic model, and a one-year 5-min run (105,192 periods, 1 GB).

Measured on the same 15 W laptop as §6.1 (release build, 1400×900 window):

| Metric | 112k objects (50k nodes, 52k links, 10k subcatchments) | 1 year at 5 min (105k periods, 450 objects) | Target |
|---|---|---|---|
| Open `.inp` + results + geometry to the UI | 0.8–1.2 s | 0.2–0.3 s | < 2 s |
| Set CRS (reproject + index + geometry to the UI) | 0.2–0.45 s | 0.16 s | — |
| Pan / zoom, all layers + basemap | 41–61 fps (lower while new tiles load) / 57–61 fps | 61 / 60 fps | 60 fps |
| Change time step (2 frames + colours + draw), median / p90 over 30 steps | 18–33 / 32–37 ms (varies between runs) | 21 / 40 ms | < 30 ms (met on median in most runs, not always) |
| Click pick / box select of everything | 50–70 ms / 60–115 ms | < 50 ms | — |
| Full-run series plot, cache built (≤ 1 min/max pair per pixel) | — | 5–7 ms | < 50 ms |
| Full-run series before the cache is built | — | refused, cache built in ~1 s (file in OS cache) | < 5 s |

Findings that change the spec:
- deck.gl only uploads typed arrays directly for instanced layers; accessor-based colour updates of 100k paths took ~40 ms per time step. Links are therefore drawn as one instance per segment (`LineLayer`, no round joins) with per-instance colour and width arrays, nodes as instanced points; only subcatchment polygons use accessors. Geometry is sent once as `Float64` lon/lat (deck.gl splits it for 64-bit precision), not as `Float32` offsets.
- The cost of a time step is now dominated by IPC (~3 ms fixed per call, ~10 ms for two 50k-value frames).
- OSM tile policy: the WebView's User-Agent is set to identify SWMM Studio; HTTP caching is the WebView's. No bulk prefetch.
- A series over a long range is not read directly from the `.out` when that would touch more than 256 MB; the request waits for the cache (the UI says so and refreshes when it is ready).
- Not done in M1: hover tooltips, measure tool, subcatchment→outlet connectors, flow arrows (P1); SVG plot export; `[BACKDROP]` image; i18n (English only); dockable panels (fixed layout with resizable panels).

---

## 7. Licence
MIT. Third-party front-end and Rust dependencies must be MIT/Apache-2.0/BSD-compatible (MapLibre GL JS: BSD-3, deck.gl: MIT, uPlot: MIT). OSM tiles: data © OpenStreetMap contributors (ODbL), attribution displayed on the map.

## 8. Open questions
1. Where do the big `.out` files usually live: local SSD, HDD, or network share? This decides whether building the cache automatically on open is the right default.
2. For multi-year runs, how many objects are typically reported (all, or a `[REPORT]` subset)?
3. Event statistics: which definitions do you use (thresholds, minimum inter-event time, reference such as overflow frequency per year)?
