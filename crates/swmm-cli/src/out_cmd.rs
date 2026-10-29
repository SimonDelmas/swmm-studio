//! `swmm-cli out …`: binary results.

use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::AtomicBool;

use anyhow::{bail, Context, Result};
use chrono::{NaiveDate, NaiveDateTime};
use clap::Subcommand;
use swmm_out::cache::{CacheOptions, SeriesStats};
use swmm_out::synth::{self, SynthSpec};
use swmm_out::{format, ElementKind, Results};

use crate::bar;

#[derive(Subcommand)]
pub enum OutCmd {
    /// Objects, variables, period and cache status.
    Info { out: PathBuf },
    /// Build the object-major results cache (<file>.out.swcache).
    Cache {
        out: PathBuf,
        /// Periods per chunk.
        #[arg(long, default_value_t = 4096)]
        chunk: usize,
        /// zstd level (1 = fastest).
        #[arg(long, default_value_t = 1)]
        level: i32,
        /// Memory budget in MB.
        #[arg(long, default_value_t = 768)]
        budget_mb: usize,
    },
    /// Whole-run statistics of one variable for every object (needs the cache).
    Stats {
        out: PathBuf,
        #[arg(long, default_value = "node")]
        kind: String,
        #[arg(long, default_value = "depth")]
        var: String,
        /// Print the N objects with the highest maximum.
        #[arg(long, default_value_t = 20)]
        top: usize,
    },
    /// Events above a threshold (e.g. overflows) per object and per year.
    Events {
        out: PathBuf,
        #[arg(long, default_value = "node")]
        kind: String,
        #[arg(long, default_value = "total_inflow")]
        var: String,
        /// Values strictly above it are in an event.
        #[arg(long, default_value_t = 0.0)]
        threshold: f32,
        /// Minimum inter-event time in hours (closer events are merged).
        #[arg(long, default_value_t = 6.0)]
        gap: f64,
        /// Comma-separated object IDs (default: every object of the kind).
        #[arg(long, value_delimiter = ',')]
        ids: Vec<String>,
    },
    /// Export time series to CSV.
    Export {
        out: PathBuf,
        /// subcatchment | node | link | system
        #[arg(long)]
        kind: String,
        /// Comma-separated object IDs (ignored for system).
        #[arg(long, value_delimiter = ',')]
        ids: Vec<String>,
        /// Comma-separated variable names (see `out info`).
        #[arg(long, value_delimiter = ',', required = true)]
        vars: Vec<String>,
        /// First date (YYYY-MM-DD[ HH:MM[:SS]] or MM/DD/YYYY).
        #[arg(long)]
        from: Option<String>,
        /// Last date (inclusive).
        #[arg(long)]
        to: Option<String>,
        /// Output file (default: stdout).
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    /// Write a synthetic .out file (tests and benchmarks).
    Synth {
        out: PathBuf,
        #[arg(long, default_value_t = 100)]
        subcatchments: usize,
        #[arg(long, default_value_t = 1000)]
        nodes: usize,
        #[arg(long, default_value_t = 1000)]
        links: usize,
        /// Number of reporting periods (or use --years).
        #[arg(long, conflicts_with = "years")]
        periods: Option<usize>,
        /// Simulated years at the report step.
        #[arg(long)]
        years: Option<f64>,
        /// Report step in seconds.
        #[arg(long, default_value_t = 300)]
        step: i32,
        #[arg(long, default_value_t = 1)]
        seed: u64,
        /// Also write a matching model (.inp) with the same IDs, on a grid.
        #[arg(long)]
        inp: Option<PathBuf>,
        /// Grid origin `x,y` of that model (default: Lyon, Lambert 93).
        #[arg(long, default_value = "842000,6519000", value_delimiter = ',', num_args = 2)]
        origin: Vec<f64>,
        /// Grid spacing in model units.
        #[arg(long, default_value_t = 30.0)]
        spacing: f64,
    },
}

fn kind(s: &str) -> Result<ElementKind> {
    ElementKind::from_name(s).with_context(|| format!("unknown kind {s:?} (subcatchment, node, link, system)"))
}

fn parse_date(s: &str) -> Result<NaiveDateTime> {
    let s = s.trim();
    for f in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M"] {
        if let Ok(d) = NaiveDateTime::parse_from_str(s, f) {
            return Ok(d);
        }
    }
    for f in ["%Y-%m-%d", "%m/%d/%Y"] {
        if let Ok(d) = NaiveDate::parse_from_str(s, f) {
            return Ok(d.and_hms_opt(0, 0, 0).unwrap());
        }
    }
    bail!("cannot parse date {s:?}")
}

fn human(bytes: u64) -> String {
    let b = bytes as f64;
    match bytes {
        0..=1023 => format!("{bytes} B"),
        1024..=1_048_575 => format!("{:.1} KB", b / 1024.0),
        1_048_576..=1_073_741_823 => format!("{:.1} MB", b / 1_048_576.0),
        _ => format!("{:.2} GB", b / 1_073_741_824.0),
    }
}

pub fn run(cmd: &OutCmd) -> Result<ExitCode> {
    match cmd {
        OutCmd::Info { out } => info(out),
        OutCmd::Cache { out, chunk, level, budget_mb } => {
            build_cache(out, &CacheOptions { chunk_len: *chunk, level: *level, memory_budget: budget_mb << 20 })?;
            Ok(ExitCode::SUCCESS)
        }
        OutCmd::Stats { out, kind: k, var, top } => stats(out, kind(k)?, var, *top),
        OutCmd::Events { out, kind: k, var, threshold, gap, ids } => events(out, kind(k)?, var, *threshold, *gap, ids),
        OutCmd::Export { out, kind: k, ids, vars, from, to, output } => {
            export(out, kind(k)?, ids, vars, from.as_deref(), to.as_deref(), output.as_deref())
        }
        OutCmd::Synth { out, subcatchments, nodes, links, periods, years, step, seed, inp, origin, spacing } => {
            let periods = match (periods, years) {
                (Some(p), _) => *p,
                (None, Some(y)) => (y * 365.25 * 86_400.0 / *step as f64).round() as usize,
                (None, None) => 105_120,
            };
            let spec = SynthSpec {
                subcatchments: *subcatchments,
                nodes: *nodes,
                links: *links,
                periods,
                report_step_secs: *step,
                start: NaiveDate::from_ymd_opt(2020, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap(),
                seed: *seed,
            };
            if let Some(inp) = inp {
                std::fs::write(inp, synth::model_inp(&spec, [origin[0], origin[1]], *spacing))?;
                println!("model written to {}", inp.display());
            }
            println!("writing {} periods, ~{}", periods, human(spec.file_size()));
            let t0 = std::time::Instant::now();
            let pb = bar(periods as u64, "{spinner} [{bar:40}] {percent:>3}% {binary_bytes_per_sec} eta {eta}");
            synth::generate(out, &spec, |p| pb.set_position(p as u64))?;
            pb.finish_and_clear();
            let size = std::fs::metadata(out)?.len();
            let secs = t0.elapsed().as_secs_f64();
            println!("{} written in {secs:.1}s ({}/s)", human(size), human((size as f64 / secs) as u64));
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn info(path: &Path) -> Result<ExitCode> {
    let t0 = std::time::Instant::now();
    let r = Results::open(path)?;
    let opened = t0.elapsed();
    let m = r.meta();
    println!(
        "{} ({}, opened in {:.1} ms)",
        path.display(),
        human(r.out().bytes().len() as u64),
        opened.as_secs_f64() * 1000.0
    );
    println!("SWMM version code {}, flow units {}", m.version, m.flow_units.name());
    if !m.complete {
        println!("INCOMPLETE file (simulation running or crashed): {} periods readable", m.n_periods);
    }
    if m.error_code != 0 {
        println!("engine error code {}", m.error_code);
    }
    if m.n_periods > 0 {
        println!(
            "{} periods, step {} s: {} -> {}",
            m.n_periods,
            m.report_step_secs,
            m.time(0),
            m.time(m.n_periods - 1)
        );
    }
    for k in ElementKind::ALL {
        let names = m.var_names(k);
        let vars: Vec<String> =
            names.iter().enumerate().map(|(i, n)| format!("{n} [{}]", format::unit(k, i, m.flow_units))).collect();
        let count = if k == ElementKind::System { String::new() } else { format!("{} ", m.count(k)) };
        println!("{count}{}s: {}", k.name(), vars.join(", "));
    }
    match r.cache_status() {
        Ok(()) => {
            let c = r.cache().unwrap();
            let size = std::fs::metadata(c.path()).map(|m| m.len()).unwrap_or(0);
            println!(
                "results cache: {} ({}, {} chunks of {} periods)",
                c.path().display(),
                human(size),
                c.n_chunks(),
                c.chunk_len()
            );
        }
        Err(swmm_out::OutError::Io { .. }) => println!("results cache: none (build with `swmm-cli out cache`)"),
        Err(e) => println!("results cache: unusable ({e})"),
    }
    Ok(ExitCode::SUCCESS)
}

pub fn build_cache(out: &Path, opts: &CacheOptions) -> Result<()> {
    let mut r = Results::open(out)?;
    let total = r.out().bytes().len() as u64;
    let pb = bar(total, "{spinner} caching [{bar:40}] {percent:>3}% {binary_bytes_per_sec} eta {eta}");
    let report = r.build_cache(opts, |p| pb.set_position(p.bytes_done), &AtomicBool::new(false))?;
    pb.finish_and_clear();
    println!(
        "cache built in {:.1}s: {} -> {} (x{:.1}), {} series, {} chunks, {:.0}% constant chunks, {}/s",
        report.seconds,
        human(report.source_bytes),
        human(report.cache_bytes),
        report.ratio(),
        report.n_series,
        report.n_chunks,
        100.0 * report.constant_chunks as f64 / (report.n_series * report.n_chunks).max(1) as f64,
        human((report.source_bytes as f64 / report.seconds.max(1e-9)) as u64)
    );
    println!(
        "  read {:.1}s, transpose+compress {:.1}s, write {:.1}s",
        report.read_seconds, report.encode_seconds, report.write_seconds
    );
    Ok(())
}

fn stats(path: &Path, kind: ElementKind, var: &str, top: usize) -> Result<ExitCode> {
    let r = Results::open(path)?;
    let m = r.meta();
    let v = m.var_index(kind, var).with_context(|| format!("unknown variable {var:?}: {:?}", m.var_names(kind)))?;
    r.cache_status().context("statistics need the results cache (swmm-cli out cache)")?;
    let t0 = std::time::Instant::now();
    let env = r.envelope(kind, v)?;
    let elapsed = t0.elapsed();
    let ids = m.ids(kind);
    let mut order: Vec<(usize, &SeriesStats)> = env.iter().enumerate().collect();
    order.sort_by(|a, b| b.1.max.total_cmp(&a.1.max));
    let unit = format::unit(kind, v, m.flow_units);
    println!("{} {var} [{unit}] over {} periods ({:.1} ms):", kind.name(), m.n_periods, elapsed.as_secs_f64() * 1000.0);
    println!("{:<20} {:>12} {:>20} {:>12} {:>10}", "id", "max", "time of max", "mean", "% nonzero");
    for (i, s) in order.into_iter().take(top) {
        println!(
            "{:<20} {:>12.4} {:>20} {:>12.4} {:>9.1}%",
            ids[i],
            s.max,
            m.time(s.argmax).format("%Y-%m-%d %H:%M").to_string(),
            s.mean,
            100.0 * s.nonzero as f64 / m.n_periods.max(1) as f64
        );
    }
    Ok(ExitCode::SUCCESS)
}

fn events(
    path: &Path,
    kind: ElementKind,
    var: &str,
    threshold: f32,
    gap_hours: f64,
    ids: &[String],
) -> Result<ExitCode> {
    let r = Results::open(path)?;
    let m = r.meta();
    let v = m.var_index(kind, var).with_context(|| format!("unknown variable {var:?}: {:?}", m.var_names(kind)))?;
    if r.cache().is_none() {
        eprintln!("no results cache: reading the .out directly (build it with `swmm-cli out cache` for speed)");
    }
    let objs: Vec<usize> = if ids.is_empty() {
        (0..m.count(kind)).collect()
    } else {
        ids.iter()
            .map(|id| r.out().object_index(kind, id).with_context(|| format!("no {} {id}", kind.name())))
            .collect::<Result<_>>()?
    };
    let step = m.report_step_secs.max(1) as f64;
    let params =
        swmm_analysis::EventParams { threshold, min_gap: ((gap_hours * 3600.0) / step).ceil().max(1.0) as usize };
    let t0 = std::time::Instant::now();
    let sums = swmm_analysis::summarize(&r, kind, &objs, v, 0..m.n_periods, params)?;
    let years = m.n_periods as f64 * step / (365.25 * 86_400.0);
    let unit = format::unit(kind, v, m.flow_units);
    let total_unit = swmm_analysis::integral(unit, m.flow_units).map_or("value·s", |f| f.1);
    println!(
        "{} {var} > {threshold} {unit}, {gap_hours} h apart, over {years:.2} years ({:.0} ms):",
        kind.name(),
        t0.elapsed().as_secs_f64() * 1000.0
    );
    println!(
        "{:<20} {:>8} {:>10} {:>14} {:>12} {:>12}",
        "id",
        "events",
        "per year",
        format!("total ({total_unit})"),
        "hours",
        "max peak"
    );
    let mut sums = sums;
    sums.sort_by_key(|s| std::cmp::Reverse(s.count));
    for s in &sums {
        println!(
            "{:<20} {:>8} {:>10.2} {:>14.1} {:>12.1} {:>12.4}",
            m.ids(kind)[s.obj],
            s.count,
            s.count as f64 / years.max(1e-9),
            s.total,
            s.hours,
            s.peak
        );
    }
    Ok(ExitCode::SUCCESS)
}

fn export(
    path: &Path,
    kind: ElementKind,
    ids: &[String],
    vars: &[String],
    from: Option<&str>,
    to: Option<&str>,
    output: Option<&Path>,
) -> Result<ExitCode> {
    let r = Results::open(path)?;
    let m = r.meta();
    let objects: Vec<(String, usize)> = if kind == ElementKind::System {
        vec![("system".into(), 0)]
    } else {
        if ids.is_empty() {
            bail!("--ids is required for {}s", kind.name());
        }
        ids.iter()
            .map(|id| {
                r.out()
                    .object_index(kind, id)
                    .map(|i| (m.ids(kind)[i].clone(), i))
                    .with_context(|| format!("no {} {id:?}", kind.name()))
            })
            .collect::<Result<_>>()?
    };
    let var_idx: Vec<(String, usize)> = vars
        .iter()
        .map(|v| {
            m.var_index(kind, v)
                .map(|i| (v.clone(), i))
                .with_context(|| format!("unknown variable {v:?}: {:?}", m.var_names(kind)))
        })
        .collect::<Result<_>>()?;
    let p0 = from.map(parse_date).transpose()?.map_or(0, |d| m.period_at(d));
    let p1 = to.map(parse_date).transpose()?.map_or(m.n_periods, |d| m.period_at(d) + 1);
    if p0 >= p1 {
        bail!("empty period range");
    }
    let mut columns = Vec::new();
    let mut header = vec!["datetime".to_string()];
    for (id, o) in &objects {
        for (vn, v) in &var_idx {
            columns.push(r.series(kind, *o, *v, p0..p1)?);
            header.push(format!("{id}:{vn}"));
        }
    }
    let sink: Box<dyn Write> = match output {
        Some(p) => Box::new(std::fs::File::create(p).with_context(|| p.display().to_string())?),
        None => Box::new(std::io::stdout().lock()),
    };
    let mut w = BufWriter::with_capacity(1 << 20, sink);
    writeln!(w, "{}", header.join(","))?;
    let mut line = String::new();
    for (row, p) in (p0..p1).enumerate() {
        line.clear();
        line.push_str(&m.time(p).format("%Y-%m-%d %H:%M:%S").to_string());
        for c in &columns {
            line.push(',');
            line.push_str(&c[row].to_string());
        }
        writeln!(w, "{line}")?;
    }
    w.flush()?;
    if r.cache().is_none() && m.n_periods > 100_000 {
        eprintln!("hint: build the results cache (swmm-cli out cache) for faster exports of long runs");
    }
    Ok(ExitCode::SUCCESS)
}
