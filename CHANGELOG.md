# Changelog

All notable changes to SWMM Studio are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Map style: show or hide each node and link type, whatever the layer is coloured by; hidden
  objects are not labelled or selectable on the map.
- One symbol per node type on the map (junction: circle, outfall: triangle, divider: diamond,
  storage: square) and, mid-link, per link type (pump: arrow, orifice: bar, weir: bow tie, outlet:
  chevron, pointing downstream); the legend uses the same symbols.
- Profile: click a conduit or a node in the profile to select it; the map highlights it and pans
  to it when it is out of view (Ctrl+click adds to the selection, double-click zooms to it). The
  selection is highlighted in the profile too.

### Changed

- Map labels are off by default.

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
