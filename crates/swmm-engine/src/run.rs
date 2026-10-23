//! One simulation run in its own folder.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use swmm_inp::InpFile;
use swmm_out::OutFile;
use swmm_rpt::Report;

use crate::history::{self, RunRecord};
use crate::progress::{parse_progress, Fragments};
use crate::{hide_window, EngineConfig, EngineError};

#[derive(Debug, Clone, Default)]
pub struct RunOptions {
    /// Appended to the run folder name and stored in the run record.
    pub label: Option<String>,
    /// Run folder; defaults to `<model dir>/<model>_runs/<timestamp>[_<label>]`.
    pub run_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    /// The engine process started.
    Started { run_dir: PathBuf },
    /// Simulated fraction in [0, 1].
    Progress(f64),
    /// A console line that is not a progress update.
    Output(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Success,
    /// Results produced, with warnings in the report.
    Warnings,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub status: RunStatus,
    pub exit_code: Option<i32>,
    pub run_dir: PathBuf,
    pub inp: PathBuf,
    pub rpt: PathBuf,
    pub out: PathBuf,
    /// Parsed report, when the engine wrote one.
    pub report: Option<Report>,
    /// The `.out` file is complete and valid.
    pub out_complete: bool,
    pub seconds: f64,
    /// Console output that was not progress, plus stderr.
    pub console: Vec<String>,
}

fn sanitize(label: &str) -> String {
    label
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn unique_run_dir(model: &Path, label: Option<&str>) -> PathBuf {
    let base = history::runs_dir(model);
    let mut name = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    if let Some(l) = label.map(sanitize).filter(|l| !l.is_empty()) {
        name = format!("{name}_{l}");
    }
    let mut dir = base.join(&name);
    let mut n = 2;
    while dir.exists() {
        dir = base.join(format!("{name}-{n}"));
        n += 1;
    }
    dir
}

/// Makes relative external file paths absolute (relative to the model folder), so the
/// copy in the run folder finds them.
fn absolutize(inp: &mut InpFile, model_dir: &Path) -> usize {
    let mut n = 0;
    for r in inp.file_refs() {
        let p = Path::new(&r.path);
        if !r.path.is_empty() && p.is_relative() {
            let abs = model_dir.join(p);
            inp.set_file_ref(&r, &abs.to_string_lossy());
            n += 1;
        }
    }
    n
}

/// Runs `model` with `engine`. Blocks until the engine exits; call it from a worker
/// thread and set `cancel` to stop the engine.
pub fn run(
    model: &Path,
    engine: &EngineConfig,
    opts: &RunOptions,
    on_event: impl FnMut(RunEvent),
    cancel: &AtomicBool,
) -> Result<RunOutcome, EngineError> {
    let inp = InpFile::read(model)?;
    run_inp(&inp, model, engine, opts, on_event, cancel)
}

/// Runs a model held in memory (possibly with unsaved edits). `model` is its file path:
/// it names the run folder and relative external files are resolved from its folder.
pub fn run_inp(
    inp: &InpFile,
    model: &Path,
    engine: &EngineConfig,
    opts: &RunOptions,
    mut on_event: impl FnMut(RunEvent),
    cancel: &AtomicBool,
) -> Result<RunOutcome, EngineError> {
    let t0 = Instant::now();
    let started = chrono::Local::now();
    if !engine.path.is_file() {
        return Err(EngineError::NotAFile(engine.path.display().to_string()));
    }
    let model = std::path::absolute(model).map_err(|e| EngineError::io(model, e))?;
    let model_dir = model.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut inp = inp.clone();
    absolutize(&mut inp, &model_dir);
    let total_days = inp.simulation_period().map(|p| p.duration().num_seconds() as f64 / 86_400.0);

    let run_dir = opts.run_dir.clone().unwrap_or_else(|| unique_run_dir(&model, opts.label.as_deref()));
    std::fs::create_dir_all(&run_dir).map_err(|e| EngineError::io(&run_dir, e))?;
    let stem = model.file_stem().map_or("model".into(), |s| s.to_string_lossy().into_owned());
    let inp_path = run_dir.join(format!("{stem}.inp"));
    let rpt_path = run_dir.join(format!("{stem}.rpt"));
    let out_path = run_dir.join(format!("{stem}.out"));
    inp.write(&inp_path)?;

    let mut cmd = Command::new(&engine.path);
    cmd.arg(&inp_path)
        .arg(&rpt_path)
        .arg(&out_path)
        // Paths SWMM resolves against the working directory (e.g. files referenced from
        // an extension's own configuration) keep working.
        .current_dir(&model_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child =
        cmd.spawn().map_err(|source| EngineError::Launch { path: engine.path.display().to_string(), source })?;
    on_event(RunEvent::Started { run_dir: run_dir.clone() });

    let (tx, rx) = mpsc::channel::<String>();
    let mut stdout = child.stdout.take().expect("piped stdout");
    let reader = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = stdout.read(&mut buf) {
            if n == 0 || tx.send(String::from_utf8_lossy(&buf[..n]).into_owned()).is_err() {
                break;
            }
        }
    });
    let mut stderr = child.stderr.take().expect("piped stderr");
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let mut console = Console { fragments: Fragments::default(), lines: Vec::new(), last_progress: -1.0, total_days };
    let mut cancelled = false;
    let exit = loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(text) => console.feed(&text, &mut on_event),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => std::thread::sleep(Duration::from_millis(50)),
        }
        if !cancelled && cancel.load(Ordering::Relaxed) {
            cancelled = true;
            // runswmm runs the simulation in-process, so killing it stops everything.
            let _ = child.kill();
        }
        if let Some(exit) = child.try_wait().map_err(|e| EngineError::io(&engine.path, e))? {
            break exit;
        }
    };
    let _ = reader.join();
    for text in rx.try_iter() {
        console.feed(&text, &mut on_event);
    }
    console.finish(&mut on_event);
    let stderr_text = err_reader.join().unwrap_or_default();
    let mut lines = console.lines;
    lines.extend(stderr_text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string));

    let report = rpt_path.is_file().then(|| Report::read(&rpt_path).ok()).flatten();
    let out_complete = OutFile::open(&out_path).is_ok_and(|o| o.meta().complete && o.meta().error_code == 0);
    let status = if cancelled {
        RunStatus::Cancelled
    } else {
        match &report {
            Some(r) if r.is_success() && out_complete && exit.success() => {
                if r.warnings.is_empty() {
                    RunStatus::Success
                } else {
                    RunStatus::Warnings
                }
            }
            _ => RunStatus::Failed,
        }
    };
    let outcome = RunOutcome {
        status,
        exit_code: exit.code(),
        run_dir: run_dir.clone(),
        inp: inp_path,
        rpt: rpt_path,
        out: out_path,
        report,
        out_complete,
        seconds: t0.elapsed().as_secs_f64(),
        console: lines,
    };
    RunRecord::from_outcome(&model, engine, opts.label.clone(), started, &outcome).save(&run_dir)?;
    Ok(outcome)
}

/// Turns raw console output into progress events and output lines.
struct Console {
    fragments: Fragments,
    lines: Vec<String>,
    last_progress: f64,
    total_days: Option<f64>,
}

impl Console {
    fn fragment(&mut self, f: &str, on_event: &mut impl FnMut(RunEvent)) {
        match parse_progress(f, self.total_days) {
            Some(p) if p > self.last_progress => {
                self.last_progress = p;
                on_event(RunEvent::Progress(p));
            }
            Some(_) => {}
            None => {
                let line = f.trim().to_string();
                if self.lines.last() != Some(&line) {
                    on_event(RunEvent::Output(line.clone()));
                    self.lines.push(line);
                }
            }
        }
    }

    fn feed(&mut self, text: &str, on_event: &mut impl FnMut(RunEvent)) {
        for f in self.fragments.push(text) {
            self.fragment(&f, on_event);
        }
    }

    fn finish(&mut self, on_event: &mut impl FnMut(RunEvent)) {
        if let Some(rest) = self.fragments.finish() {
            self.fragment(&rest, on_event);
        }
    }
}
