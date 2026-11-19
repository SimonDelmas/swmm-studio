//! One simulation run in its own folder.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use swmm_inp::InpFile;
use swmm_out::OutFile;
use swmm_rpt::Report;

use crate::history::{self, RunRecord};
use crate::progress::{is_status, parse_progress, Fragments};
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

/// Creates the folder of a new run: `<timestamp>[_label]`, with a number after it when
/// two runs start within the same second. Creating it is what reserves the name.
fn create_run_dir(model: &Path, label: Option<&str>) -> Result<PathBuf, EngineError> {
    let base = history::runs_dir(model);
    std::fs::create_dir_all(&base).map_err(|e| EngineError::io(&base, e))?;
    let mut name = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    if let Some(l) = label.map(sanitize).filter(|l| !l.is_empty()) {
        name = format!("{name}_{l}");
    }
    let mut dir = base.join(&name);
    let mut n = 2;
    loop {
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                dir = base.join(format!("{name}-{n}"));
                n += 1;
            }
            Err(e) => return Err(EngineError::io(&dir, e)),
        }
    }
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
    let total_days = inp.simulation_period().map(|p| p.duration().num_seconds() as f64 / 86_400.0);
    let files = RunFiles::prepare(inp, &model, opts)?;

    let mut child = spawn_engine(engine, &files).inspect_err(|_| {
        // A folder made for this run would stay behind without a record.
        if opts.run_dir.is_none() {
            files.remove_run_dir();
        }
    })?;
    // The engine dies with the application, even if it crashes.
    crate::job::bind_to_parent(&child);
    on_event(RunEvent::Started { run_dir: files.run_dir.clone() });

    let mut console = Console::new(total_days);
    let (exit, cancelled) =
        follow(&mut child, &mut console, &mut on_event, cancel).map_err(|e| EngineError::io(&engine.path, e))?;

    let report = files.rpt.is_file().then(|| Report::read(&files.rpt).ok()).flatten();
    let out_complete = OutFile::open(&files.out).is_ok_and(|o| o.meta().complete && o.meta().error_code == 0);
    let outcome = RunOutcome {
        status: status(cancelled, exit.success() && out_complete, report.as_ref()),
        exit_code: exit.code(),
        run_dir: files.run_dir.clone(),
        inp: files.inp,
        rpt: files.rpt,
        out: files.out,
        report,
        out_complete,
        seconds: t0.elapsed().as_secs_f64(),
        console: console.lines,
    };
    RunRecord::from_outcome(&model, engine, opts.label.clone(), started, &outcome).save(&files.run_dir)?;
    // The console is kept with the run: its errors explain a run that wrote no report.
    // Not being able to write it does not fail the run.
    let _ = crate::history::save_console(&files.run_dir, &outcome.console);
    Ok(outcome)
}

/// The folder of a run and the files the engine reads and writes there.
struct RunFiles {
    /// Folder of the model: the working directory of the engine.
    model_dir: PathBuf,
    run_dir: PathBuf,
    inp: PathBuf,
    rpt: PathBuf,
    out: PathBuf,
}

impl RunFiles {
    /// Makes the run folder and writes the model there. `model` is an absolute path.
    fn prepare(inp: &InpFile, model: &Path, opts: &RunOptions) -> Result<RunFiles, EngineError> {
        let model_dir = model.parent().map(Path::to_path_buf).unwrap_or_default();
        let mut inp = inp.clone();
        absolutize(&mut inp, &model_dir);
        // Absolute: the engine runs in the model folder, not in the current directory.
        let run_dir = match &opts.run_dir {
            Some(d) => {
                let d = std::path::absolute(d).map_err(|e| EngineError::io(d, e))?;
                std::fs::create_dir_all(&d).map_err(|e| EngineError::io(&d, e))?;
                d
            }
            None => create_run_dir(model, opts.label.as_deref())?,
        };
        let stem = model.file_stem().map_or("model".into(), |s| s.to_string_lossy().into_owned());
        let files = RunFiles {
            model_dir,
            inp: run_dir.join(format!("{stem}.inp")),
            rpt: run_dir.join(format!("{stem}.rpt")),
            out: run_dir.join(format!("{stem}.out")),
            run_dir,
        };
        inp.write(&files.inp)?;
        // In a reused folder, files of an earlier run must not pass for this run's.
        for stale in [&files.rpt, &files.out] {
            let _ = std::fs::remove_file(stale);
        }
        Ok(files)
    }

    /// Removes the run folder, and the runs folder itself if this was its first run (it
    /// is then empty).
    fn remove_run_dir(&self) {
        let _ = std::fs::remove_dir_all(&self.run_dir);
        if let Some(runs) = self.run_dir.parent() {
            let _ = std::fs::remove_dir(runs);
        }
    }
}

fn spawn_engine(engine: &EngineConfig, files: &RunFiles) -> Result<Child, EngineError> {
    let mut cmd = Command::new(&engine.path);
    cmd.arg(&files.inp)
        .arg(&files.rpt)
        .arg(&files.out)
        // Paths SWMM resolves against the working directory (e.g. files referenced from
        // an extension's own configuration) keep working.
        .current_dir(&files.model_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut cmd);
    cmd.spawn().map_err(|source| EngineError::Launch { path: engine.path.display().to_string(), source })
}

/// Sends what the engine prints as text, as it comes.
fn pump_text(mut stdout: ChildStdout, tx: mpsc::Sender<String>) {
    let mut buf = [0u8; 4096];
    // Bytes of a character cut by the end of a read wait for the next one.
    let mut pending: Vec<u8> = Vec::new();
    while let Ok(n) = stdout.read(&mut buf) {
        if n == 0 {
            break;
        }
        pending.extend_from_slice(&buf[..n]);
        let whole = match std::str::from_utf8(&pending) {
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            _ => pending.len(),
        };
        let text = String::from_utf8_lossy(&pending[..whole]).into_owned();
        pending.drain(..whole);
        if !text.is_empty() && tx.send(text).is_err() {
            return;
        }
    }
    if !pending.is_empty() {
        let _ = tx.send(String::from_utf8_lossy(&pending).into_owned());
    }
}

/// Follows the engine until it exits, passing its console output to `console` and
/// stopping it when `cancel` is set. Returns its exit status and whether it was stopped.
fn follow(
    child: &mut Child,
    console: &mut Console,
    on_event: &mut impl FnMut(RunEvent),
    cancel: &AtomicBool,
) -> std::io::Result<(ExitStatus, bool)> {
    let tree = crate::job::ProcessTree::of(child);
    // The engine and, when it was started through a wrapper, what the wrapper started.
    let kill = |child: &mut Child| {
        tree.kill();
        let _ = child.kill();
    };
    let (tx, rx) = mpsc::channel::<String>();
    let stdout = child.stdout.take().expect("piped stdout");
    let reader = std::thread::spawn(move || pump_text(stdout, tx));
    let mut stderr = child.stderr.take().expect("piped stderr");
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let mut cancelled = false;
    let exit = loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(text) => console.feed(&text, on_event),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => std::thread::sleep(Duration::from_millis(50)),
        }
        if !cancelled && cancel.load(Ordering::Relaxed) {
            cancelled = true;
            kill(child);
        }
        match child.try_wait() {
            Ok(Some(exit)) => break exit,
            Ok(None) => {}
            Err(e) => {
                kill(child);
                return Err(e);
            }
        }
    };
    let _ = reader.join();
    for text in rx.try_iter() {
        console.feed(&text, on_event);
    }
    console.finish(on_event);
    let stderr_text = err_reader.join().unwrap_or_default();
    console.lines.extend(stderr_text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string));
    Ok((exit, cancelled))
}

/// Status of a finished run. `complete`: the engine exited normally and its results are whole.
fn status(cancelled: bool, complete: bool, report: Option<&Report>) -> RunStatus {
    match report {
        // A run that completed just as it was cancelled keeps its results and its status.
        _ if cancelled && !complete => RunStatus::Cancelled,
        Some(r) if complete && r.is_success() => {
            if r.warnings.is_empty() {
                RunStatus::Success
            } else {
                RunStatus::Warnings
            }
        }
        _ => RunStatus::Failed,
    }
}

/// Turns raw console output into progress events and output lines.
struct Console {
    fragments: Fragments,
    lines: Vec<String>,
    last_progress: f64,
    total_days: Option<f64>,
    /// A day / hour status line was already passed on as output (see `fragment`).
    status_shown: bool,
}

impl Console {
    /// `total_days`: length of the simulation, when the model gives it.
    fn new(total_days: Option<f64>) -> Console {
        Console {
            fragments: Fragments::default(),
            lines: Vec::new(),
            last_progress: -1.0,
            total_days,
            status_shown: false,
        }
    }

    fn fragment(&mut self, f: &str, on_event: &mut impl FnMut(RunEvent)) {
        match parse_progress(f, self.total_days) {
            Some(p) if p > self.last_progress => {
                self.last_progress = p;
                on_event(RunEvent::Progress(p));
            }
            Some(_) => {}
            // Without a known simulation period the day / hour redraws give no fraction:
            // show the first one, not one line per simulated hour.
            None if is_status(f) && std::mem::replace(&mut self.status_shown, true) => {}
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
