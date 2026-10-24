//! `swmm-cli`: headless front-end of SWMM Studio.

mod out_cmd;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use indicatif::{ProgressBar, ProgressStyle};
use swmm_engine::{detect_version, history, EngineConfig, RunEvent, RunOptions, RunStatus, Settings};
use swmm_inp::InpFile;
use swmm_rpt::Report;

#[derive(Parser)]
#[command(name = "swmm-cli", version, about = "Run EPA SWMM models and explore their results")]
struct Cli {
    /// Settings file (default: %APPDATA%\SwmmStudio\settings.json).
    #[arg(long, global = true)]
    settings: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run a model with a configured engine.
    Run {
        model: PathBuf,
        /// Engine name from the registry (default engine otherwise).
        #[arg(long, conflicts_with = "exe")]
        engine: Option<String>,
        /// Engine executable to use without registering it.
        #[arg(long)]
        exe: Option<PathBuf>,
        /// Label of the run (appended to the run folder name).
        #[arg(long)]
        label: Option<String>,
        /// Run folder (default: <model>_runs/<timestamp>).
        #[arg(long)]
        run_dir: Option<PathBuf>,
        /// Build the results cache after a successful run.
        #[arg(long)]
        cache: bool,
    },
    /// List previous runs of a model.
    Runs { model: PathBuf },
    /// Manage the engine registry.
    #[command(subcommand)]
    Engine(EngineCmd),
    /// Inspect input files.
    #[command(subcommand)]
    Inp(InpCmd),
    /// Summarize a report file.
    Rpt {
        report: PathBuf,
        /// Also print every block title.
        #[arg(long)]
        blocks: bool,
    },
    /// Inspect, cache and export binary results.
    #[command(subcommand)]
    Out(out_cmd::OutCmd),
}

#[derive(Subcommand)]
enum EngineCmd {
    /// List registered engines.
    List,
    /// Register an engine executable (runswmm.exe or equivalent).
    Add {
        name: String,
        path: PathBuf,
        /// Make it the default engine.
        #[arg(long)]
        default: bool,
    },
    /// Remove an engine from the registry.
    Remove { name: String },
    /// Set the default engine.
    Default { name: String },
}

#[derive(Subcommand)]
enum InpCmd {
    /// Sections, object counts, simulation period and external files.
    Info { model: PathBuf },
    /// Check that files are written back byte-for-byte (lossless round-trip).
    Check {
        #[arg(required = true)]
        models: Vec<PathBuf>,
    },
    /// Model checks: duplicate IDs, missing references, adverse slopes, offsets below
    /// inverts, sub-networks without outfall… Exit code 1 when there are errors.
    Validate {
        model: PathBuf,
        /// Also list the warnings.
        #[arg(long)]
        warnings: bool,
    },
}

fn settings_path(cli: &Cli) -> PathBuf {
    cli.settings.clone().unwrap_or_else(Settings::default_path)
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match dispatch(&cli) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(2)
        }
    }
}

fn dispatch(cli: &Cli) -> Result<ExitCode> {
    match &cli.command {
        Command::Run { model, engine, exe, label, run_dir, cache } => {
            run_cmd(cli, model, engine.as_deref(), exe.as_deref(), label.clone(), run_dir.clone(), *cache)
        }
        Command::Runs { model } => {
            let runs = history::list_runs(model);
            if runs.is_empty() {
                println!("no runs in {}", history::runs_dir(model).display());
            }
            for (dir, r) in runs {
                let flow =
                    r.continuity.as_ref().and_then(|c| c.flow_routing).map_or("-".into(), |v| format!("{v:.2}%"));
                println!(
                    "{:<26} {:<9} {:>7.1}s  routing err {:>7}  {}  {}",
                    r.started.get(..19).unwrap_or(&r.started),
                    format!("{:?}", r.status).to_lowercase(),
                    r.seconds,
                    flow,
                    r.label.unwrap_or_default(),
                    dir.display()
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Engine(cmd) => engine_cmd(cli, cmd),
        Command::Inp(cmd) => inp_cmd(cmd),
        Command::Rpt { report, blocks } => rpt_cmd(report, *blocks),
        Command::Out(cmd) => out_cmd::run(cmd),
    }
}

fn engine_cmd(cli: &Cli, cmd: &EngineCmd) -> Result<ExitCode> {
    let path = settings_path(cli);
    let mut settings = Settings::load(&path)?;
    match cmd {
        EngineCmd::List => {
            if settings.engines.is_empty() {
                println!("no engine configured; add one with: swmm-cli engine add <name> <path\\to\\runswmm.exe>");
            }
            let default = settings.default_engine().map(|e| e.name.clone());
            for e in &settings.engines {
                let mark = if Some(&e.name) == default.as_ref() { "*" } else { " " };
                let status = if e.path.is_file() { "" } else { "  (missing!)" };
                println!(
                    "{mark} {:<16} {:<10} {}{status}",
                    e.name,
                    e.version.as_deref().unwrap_or("?"),
                    e.path.display()
                );
            }
        }
        EngineCmd::Add { name, path: exe, default } => {
            let exe = std::path::absolute(exe)?;
            let version = detect_version(&exe).with_context(|| format!("checking {}", exe.display()))?;
            match &version {
                Some(v) => println!("detected SWMM {v}"),
                None => println!("warning: {} runs but prints no SWMM version", exe.display()),
            }
            settings.add_engine(EngineConfig { name: name.clone(), path: exe, version });
            if *default {
                settings.set_default(name)?;
            }
            settings.save(&path)?;
            println!("engine {name:?} saved to {}", path.display());
        }
        EngineCmd::Remove { name } => {
            if !settings.remove_engine(name) {
                bail!("no engine named {name:?}");
            }
            settings.save(&path)?;
        }
        EngineCmd::Default { name } => {
            settings.set_default(name)?;
            settings.save(&path)?;
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn bar(len: u64, template: &str) -> ProgressBar {
    let pb = ProgressBar::new(len);
    pb.set_style(ProgressStyle::with_template(template).unwrap().progress_chars("=> "));
    pb
}

fn run_cmd(
    cli: &Cli,
    model: &Path,
    engine: Option<&str>,
    exe: Option<&Path>,
    label: Option<String>,
    run_dir: Option<PathBuf>,
    cache: bool,
) -> Result<ExitCode> {
    let engine = match exe {
        Some(p) => EngineConfig { name: "cli".into(), path: std::path::absolute(p)?, version: None },
        None => {
            let settings = Settings::load(&settings_path(cli))?;
            match engine {
                Some(n) => settings.engine(n).cloned().with_context(|| format!("no engine named {n:?}"))?,
                None => settings.default_engine().cloned().ok_or(swmm_engine::EngineError::NoEngine)?,
            }
        }
    };
    // The engine runs without a console window, so Ctrl+C does not reach it: stop it ourselves.
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let _ = ctrlc::set_handler(move || flag.store(true, std::sync::atomic::Ordering::Relaxed));
    let pb = bar(1000, "{spinner} {msg:<12} [{bar:40}] {percent:>3}% {elapsed_precise} (eta {eta})");
    pb.set_message("starting");
    let outcome = swmm_engine::run(
        model,
        &engine,
        &RunOptions { label, run_dir },
        |e| match e {
            RunEvent::Started { .. } => pb.set_message("simulating"),
            RunEvent::Progress(p) => pb.set_position((p * 1000.0) as u64),
            RunEvent::Output(line) => pb.println(format!("  {line}")),
        },
        &cancel,
    )?;
    pb.finish_and_clear();

    println!("run folder: {}", outcome.run_dir.display());
    if let Some(r) = &outcome.report {
        print_messages(r);
        print_continuity(r);
    }
    let code = match outcome.status {
        RunStatus::Success => {
            println!("success in {:.1}s", outcome.seconds);
            ExitCode::SUCCESS
        }
        RunStatus::Warnings => {
            println!("finished with warnings in {:.1}s", outcome.seconds);
            ExitCode::SUCCESS
        }
        RunStatus::Failed => {
            println!("FAILED (exit code {:?}, results complete: {})", outcome.exit_code, outcome.out_complete);
            ExitCode::from(1)
        }
        RunStatus::Cancelled => ExitCode::from(130),
    };
    if cache && matches!(outcome.status, RunStatus::Success | RunStatus::Warnings) {
        out_cmd::build_cache(&outcome.out, &swmm_out::cache::CacheOptions::default())?;
    }
    Ok(code)
}

fn print_messages(r: &Report) {
    for e in &r.errors {
        let at = e.line.map(|l| format!(" (line {l})")).unwrap_or_default();
        println!("ERROR {}{at}: {}", e.code, e.text);
        if let Some(c) = &e.context {
            println!("    {c}");
        }
    }
    for w in r.warnings.iter().take(20) {
        println!("WARNING {}: {}", w.code, w.text);
    }
    if r.warnings.len() > 20 {
        println!("... {} more warnings", r.warnings.len() - 20);
    }
}

fn print_continuity(r: &Report) {
    let c = r.continuity();
    let f = |v: Option<f64>| v.map_or("-".to_string(), |v| format!("{v:.3} %"));
    println!(
        "continuity errors: runoff {}  groundwater {}  flow routing {}",
        f(c.runoff_quantity),
        f(c.groundwater),
        f(c.flow_routing)
    );
    if let Some(b) = r.rdii() {
        if let Some(ratio) = b.get("RDII Ratio").and_then(|kv| kv.number(0)) {
            println!("RDII ratio: {ratio:.3}");
        }
    }
}

fn inp_cmd(cmd: &InpCmd) -> Result<ExitCode> {
    match cmd {
        InpCmd::Info { model } => {
            let t0 = std::time::Instant::now();
            let inp = InpFile::read(model)?;
            println!(
                "{} ({:?}, read in {:.0} ms)",
                model.display(),
                inp.encoding(),
                t0.elapsed().as_secs_f64() * 1000.0
            );
            println!("flow units: {}", inp.flow_units().name());
            if let Some(p) = inp.simulation_period() {
                println!(
                    "simulation: {} -> {} ({:.1} days), report step {} s",
                    p.start,
                    p.end,
                    p.duration().num_seconds() as f64 / 86_400.0,
                    p.report_step.num_seconds()
                );
            }
            for (kind, n) in inp.summary() {
                println!("  [{}] {n}", kind.name());
            }
            let refs = inp.file_refs();
            if !refs.is_empty() {
                println!("external files:");
                let dir = model.parent().unwrap_or(Path::new("."));
                for r in refs {
                    let exists = dir.join(&r.path).exists();
                    println!("  {:?}: {}{}", r.kind, r.path, if exists { "" } else { "  (not found)" });
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        InpCmd::Validate { model, warnings } => {
            let inp = InpFile::read(model)?;
            let net = swmm_model::Network::from_inp(&inp);
            let issues = swmm_model::validate::validate(&inp, &net);
            let errors = issues.iter().filter(|i| i.severity == swmm_model::validate::Severity::Error).count();
            for i in issues.iter().filter(|i| *warnings || i.severity == swmm_model::validate::Severity::Error) {
                let sev = if i.severity == swmm_model::validate::Severity::Error { "ERROR  " } else { "WARNING" };
                println!("{sev} {:<20} {}", i.code, i.message);
            }
            println!("{errors} error(s), {} warning(s)", issues.len() - errors);
            Ok(if errors == 0 { ExitCode::SUCCESS } else { ExitCode::from(1) })
        }
        InpCmd::Check { models } => {
            let mut failed = 0;
            for m in models {
                let bytes = std::fs::read(m).with_context(|| m.display().to_string())?;
                let ok = InpFile::parse_bytes(&bytes).to_bytes().is_ok_and(|b| b == bytes);
                if !ok {
                    failed += 1;
                }
                println!("{} {}", if ok { "ok  " } else { "FAIL" }, m.display());
            }
            Ok(if failed == 0 { ExitCode::SUCCESS } else { ExitCode::from(1) })
        }
    }
}

fn rpt_cmd(path: &Path, blocks: bool) -> Result<ExitCode> {
    let r = Report::read(path)?;
    println!("SWMM {}", r.version.as_deref().unwrap_or("?"));
    print_messages(&r);
    print_continuity(&r);
    if blocks {
        for b in &r.blocks {
            let what = match &b.body {
                swmm_rpt::Body::Table(t) => format!("table, {} rows", t.rows.len()),
                swmm_rpt::Body::KeyValues(kv) => format!("{} values", kv.len()),
                swmm_rpt::Body::Text(t) => format!("{} lines", t.len()),
            };
            println!("  {:<40} {what}", b.title);
        }
    }
    Ok(if r.is_success() { ExitCode::SUCCESS } else { ExitCode::from(1) })
}
