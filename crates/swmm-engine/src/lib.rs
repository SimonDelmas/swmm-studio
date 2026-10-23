//! Runs EPA SWMM engines (any `runswmm.exe`-style executable) as child processes.
//!
//! - [`Settings`]: the user's engine registry (no engine is bundled).
//! - [`detect_version`]: validates an executable and reads its SWMM version.
//! - [`run`]: copies the model into a run folder (external file paths made absolute),
//!   launches `<exe> model.inp model.rpt model.out`, reports progress, supports cancel,
//!   and classifies the outcome from the report (engines may exit with code 0 on errors).
//! - [`history`]: lists previous runs of a model.

pub mod history;
mod progress;
mod run;
mod settings;

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub use progress::{parse_progress, Fragments};
pub use run::{run, run_inp, RunEvent, RunOptions, RunOutcome, RunStatus};
pub use settings::{EngineConfig, Settings};

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("{path}: {source}")]
    Io { path: String, source: std::io::Error },
    #[error("invalid settings: {0}")]
    Settings(String),
    #[error("no engine named {0:?}")]
    UnknownEngine(String),
    #[error("no SWMM engine configured: add one with the path to runswmm.exe")]
    NoEngine,
    #[error("{0} is not a file")]
    NotAFile(String),
    #[error("cannot start {path}: {source}")]
    Launch { path: String, source: std::io::Error },
    #[error("{0} did not answer within {1:?}")]
    Timeout(String, Duration),
    #[error(transparent)]
    Inp(#[from] swmm_inp::InpError),
}

impl EngineError {
    pub(crate) fn io(path: &Path, source: std::io::Error) -> EngineError {
        EngineError::Io { path: path.display().to_string(), source }
    }
}

pub(crate) fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Runs `exe args…` and returns stdout + stderr, killing it after `timeout`.
fn capture(exe: &Path, args: &[&str], timeout: Duration) -> Result<String, EngineError> {
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|source| EngineError::Launch { path: exe.display().to_string(), source })?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let out = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = stdout.read_to_end(&mut s);
        s
    });
    let err = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = stderr.read_to_end(&mut s);
        s
    });
    let t0 = Instant::now();
    loop {
        if child.try_wait().map_err(|e| EngineError::io(exe, e))?.is_some() {
            break;
        }
        if t0.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(EngineError::Timeout(exe.display().to_string(), timeout));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut bytes = out.join().unwrap_or_default();
    bytes.extend(err.join().unwrap_or_default());
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Most specific `5.x[.y]` version number in an engine banner.
pub fn parse_version(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || matches!(c, '(' | ')' | ',' | ';'))
        .map(|t| t.trim_start_matches(['v', 'V']))
        .filter(|t| t.starts_with("5.") && t.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
        .max_by_key(|t| t.split('.').count())
        .map(str::to_string)
}

/// Checks that `exe` is a SWMM command-line engine and returns its version
/// (`None` when it runs but prints no recognizable version).
pub fn detect_version(exe: &Path) -> Result<Option<String>, EngineError> {
    if !exe.is_file() {
        return Err(EngineError::NotAFile(exe.display().to_string()));
    }
    let timeout = Duration::from_secs(10);
    let text = capture(exe, &["--version"], timeout)?;
    if let Some(v) = parse_version(&text) {
        return Ok(Some(v));
    }
    Ok(parse_version(&capture(exe, &[], timeout)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(
            parse_version("\nVersion:\n\tSWMM v5.2.4 (Build 2026-02-02)\n\tSUEZ-MODULES v0.4.0").as_deref(),
            Some("5.2.4")
        );
        assert_eq!(parse_version("\nSWMM 5.1.15 - TSS 0.1.4\n").as_deref(), Some("5.1.15"));
        assert_eq!(parse_version("... EPA SWMM 5.2 (Build 5.2.4)").as_deref(), Some("5.2.4"));
        assert_eq!(parse_version("hello 1.2.3"), None);
    }

    #[test]
    fn missing_exe() {
        assert!(matches!(detect_version(Path::new("Z:/nope/runswmm.exe")), Err(EngineError::NotAFile(_))));
    }
}
