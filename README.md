# SWMM Studio

Visualize, edit, simulate and analyse EPA SWMM 5 models, built for large networks
(100k+ objects) and long continuous simulations (multi-year runs, `.out` files up to 10 GB).

See [SPEC.md](SPEC.md) for the functional and technical specification and the roadmap.

**Status: M0 (core libraries + CLI).** The desktop app (Tauri + React) starts in M1.

## Crates

| Crate | Purpose |
|---|---|
| [`swmm-inp`](crates/swmm-inp) | Lossless `.inp` reader/writer: untouched lines are written back byte-for-byte (comments, alignment, line endings, unknown sections, UTF-8/Windows-1252). Options, simulation period, external file references. |
| [`swmm-out`](crates/swmm-out) | Memory-mapped `.out` reader (any size, partial files of running simulations), writer, synthetic generator, and the **results cache**: an object-major, losslessly compressed copy built in one pass, with per-chunk min/max/time-of-max/sum, for fast multi-year series and whole-run envelopes. |
| [`swmm-rpt`](crates/swmm-rpt) | `.rpt` parser: errors/warnings (with input line and object), continuity errors, RDII, every summary block as a table / key-values / text. |
| [`swmm-engine`](crates/swmm-engine) | Engine registry (`%APPDATA%\SwmmStudio\settings.json`), version detection, runs in `<model>_runs/<timestamp>_<label>/` with progress, cancel and a `run.json` record. |
| [`swmm-cli`](crates/swmm-cli) | Command-line front-end. |

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

## Licence

MIT
