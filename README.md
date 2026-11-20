# SWMM Studio

A desktop application to **view, edit, run and analyse EPA SWMM 5 models**.

SWMM Studio stays fast where other tools slow down: networks with more than 100,000 objects, and
continuous simulations over many years whose results files reach several gigabytes.

## Highlights

- **Your network on a real map**: see the model over OpenStreetMap in its own coordinate system
  (Lambert 93, CC zones, any EPSG code).
- **Edit everything, safely**: properties, objects drawn on the map, curves, time series and more,
  with unlimited undo / redo and checks as you type.
- **Minimal changes**: when you save, only what you changed is rewritten. Comments, layout
  and anything SWMM Studio doesn't know are kept exactly as they were.
- **Run with your own SWMM engine**: EPA SWMM 5.1 or 5.2, OWA, or a custom build.
- **Analyse long simulations in seconds**: animated maps, multi-year time series, longitudinal
  profiles, event statistics and comparisons between runs.

## Features

### Explore the network

- Open a model and its results in one step; the map, its styles and your view are remembered.
- Pick the coordinate system by code or name (`2154`, `Lambert-93`, `CC44`…) to place the network
  on the basemap. The model file itself is never changed.
- Select objects with a click, a box or a lasso, by a query (`diameter < 0.3`, `type = outfall`,
  `max(flow) > 2`), find them by name, and see labels as you zoom in.
- Colour nodes, links and subcatchments by type, by any input value (diameter, slope, area…) or
  by a simulation result.

### Edit the model

- **Properties panel**: every field of the selected object, with its unit and an immediate check.
  Change a type (e.g. a cross-section shape) and the other values are kept; rename an object and
  every reference to it follows.
- **Draw on the map**: add junctions, outfalls, storage units, rain gages, conduits and
  subcatchments; move nodes, edit vertices, reconnect links.
- **Edit many objects at once**: set a value on the whole selection, or work on a full section
  (junctions, conduits, subareas…) in a spreadsheet-like table, with copy and paste to and from Excel.
- **Data editors**: curves, time series, time patterns, unit hydrographs and RDII, transects,
  climatology, simulation options. Any other section (water quality, LID, groundwater…) can be
  edited as text.
- **Model checks** after every edit: missing references, links without a cross-section, adverse
  slopes, unconnected nodes, parts of the network that reach no outfall… Click an issue to go to
  the object.
- Undo with Ctrl+Z, redo with Ctrl+Y, save with Ctrl+S.

### Run simulations

- Press **F5** to run the model as it is, without saving it first. Follow the progress and cancel
  at any time.
- Every run is kept in a history with its label, engine and continuity errors, so you can reload,
  compare or overlay past runs on the time series graphs.
- The report opens with errors and warnings linked to the objects they name, continuity errors
  highlighted, and every summary table sortable and linked to the map.

### Analyse the results

- **Animated map**: play the simulation, zoom the timeline from years down to single time steps,
  jump to a date, to an object's peak or to its next event.
- **Statistics maps**: maximum, minimum, mean, time of maximum, total volume or time above a
  threshold, over the whole run or per day, month or year.
- **Time series** of any length for any objects and variables, instantly, even over many years;
  also as daily, monthly or yearly statistics.
- **X-Y plots**: one variable against another (depth vs flow, rainfall vs runoff), for an object
  or across objects, with the current time marked.
- **Longitudinal profiles** between nodes, with the ground, the conduits and the water line moving
  with the timeline, plus the maximum water line of the run.
- **Event statistics** for long-term studies: how often and how long an outfall overflows, with
  volume and peak per event and per year.
- **Compare runs**: side-by-side statistics and difference maps in a comparison tab, and the
  series of any number of runs on the same graphs.
- **Observed data**: link a file of measurements (CSV, Excel, OpenDocument, Parquet) to a node,
  link or subcatchment, map its columns to the object's variables (proposed from the column
  titles), and see the measured values on the plots of the results.

### Share your work

- Export any table to CSV or Excel, and any plot or profile to PNG or SVG.

## Getting started

1. Download the Windows installer from the
   [releases page](https://github.com/SimonDelmas/swmm-studio/releases) and install it.
2. In **Engines**, register a SWMM engine (`runswmm.exe`). No engine is bundled with SWMM Studio.
3. Open a model (`.inp`), set its coordinate system, and press **F5** to run it.

A command-line tool (`swmm-cli`) is also available to run models, check them and extract results
in scripts.

## For developers

Building from source, project layout, the command-line tool, tests and releases are described in
[DEVELOPMENT.md](DEVELOPMENT.md). The full specification and roadmap are in [SPEC.md](SPEC.md).

Basemap © OpenStreetMap contributors.

## Licence

MIT
