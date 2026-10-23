//! Runs the real engine when `SWMM_ENGINE` points to a `runswmm.exe`; skipped otherwise.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use swmm_engine::{detect_version, history, run, EngineConfig, RunEvent, RunOptions, RunStatus};

fn engine() -> Option<EngineConfig> {
    let path = PathBuf::from(std::env::var_os("SWMM_ENGINE")?);
    let version = detect_version(&path).expect("engine runs");
    Some(EngineConfig { name: "test".into(), path, version })
}

fn copy_model(dir: &Path) -> PathBuf {
    let data = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata");
    for f in ["tiny.inp", "storm.dat"] {
        std::fs::copy(data.join(f), dir.join(f)).unwrap();
    }
    dir.join("tiny.inp")
}

#[test]
fn runs_tiny_model() {
    let Some(engine) = engine() else { return };
    let dir = tempfile::tempdir().unwrap();
    let model = copy_model(dir.path());
    let mut events = Vec::new();
    let outcome = run(
        &model,
        &engine,
        &RunOptions { label: Some("base case".into()), ..Default::default() },
        |e| events.push(e),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(matches!(outcome.status, RunStatus::Success | RunStatus::Warnings), "{outcome:#?}");
    assert!(outcome.out_complete);
    assert!(outcome.run_dir.starts_with(dir.path().join("tiny_runs")));
    assert!(outcome.run_dir.to_string_lossy().ends_with("_base_case"));
    assert!(matches!(events.first(), Some(RunEvent::Started { .. })));
    let progress: Vec<f64> =
        events.iter().filter_map(|e| if let RunEvent::Progress(p) = e { Some(*p) } else { None }).collect();
    assert!(!progress.is_empty(), "no progress parsed: {events:?}");
    assert!(progress.windows(2).all(|w| w[0] < w[1]));
    // The rainfall file path was made absolute in the run copy.
    let copy = std::fs::read_to_string(&outcome.inp).unwrap();
    assert!(copy.contains(&dir.path().join("storm.dat").to_string_lossy().to_string()));
    let report = outcome.report.as_ref().unwrap();
    assert!(report.rdii().is_some());
    let runs = history::list_runs(&model);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].1.label.as_deref(), Some("base case"));
    assert_eq!(runs[0].1.status, outcome.status);
}

#[test]
fn reports_input_errors() {
    let Some(engine) = engine() else { return };
    let dir = tempfile::tempdir().unwrap();
    let model = copy_model(dir.path());
    let text = std::fs::read_to_string(&model).unwrap().replace("C2               J2", "C2               JX");
    std::fs::write(&model, text).unwrap();
    let outcome = run(&model, &engine, &RunOptions::default(), |_| {}, &AtomicBool::new(false)).unwrap();
    assert_eq!(outcome.status, RunStatus::Failed);
    let err = &outcome.report.unwrap().errors[0];
    assert_eq!(err.code, "209");
    assert_eq!(err.object(), Some("JX"));
}
