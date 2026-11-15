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

/// Runs `tiny.inp` with `from` replaced by `to` (and `extra` appended).
fn run_variant(engine: &EngineConfig, from: &str, to: &str, extra: &str) -> swmm_engine::RunOutcome {
    let dir = tempfile::tempdir().unwrap();
    let model = copy_model(dir.path());
    let text = std::fs::read_to_string(&model).unwrap();
    assert!(text.contains(from), "{from:?} not in tiny.inp");
    std::fs::write(&model, text.replacen(from, to, 1) + extra).unwrap();
    let mut outcome = run(&model, engine, &RunOptions::default(), |_| {}, &AtomicBool::new(false)).unwrap();
    // The report is read before the run folder goes away with `dir`.
    outcome.console = vec![std::fs::read_to_string(&outcome.rpt).unwrap_or_default()];
    outcome
}

/// What the editors assume about the way the engine reads its input (field counts, where
/// the barrels of a custom shape are, section names, comments) holds for this engine.
#[test]
fn input_format_assumptions() {
    let Some(engine) = engine() else { return };
    let ok = |o: &swmm_engine::RunOutcome| matches!(o.status, RunStatus::Success | RunStatus::Warnings);
    let errors = |o: &swmm_engine::RunOutcome| o.report.as_ref().map_or(0, |r| r.errors.len());

    // A custom shape: two unused values, then the barrels (7th token).
    let circular = "C1               CIRCULAR     0.4              0          0          0          1";
    let curve = "\n[CURVES]\nSHP SHAPE 0 0\nSHP 0.5 1\nSHP 1 0\n";
    let o = run_variant(&engine, circular, "C1 CUSTOM 0.4 SHP 0 0 2", &format!("{curve}\n[REPORT]\nINPUT YES\n"));
    assert!(ok(&o), "{:?}", o.report);
    let rpt = &o.console[0];
    let summary = &rpt[rpt.find("Cross Section Summary").expect("cross section summary")..];
    let c1: Vec<&str> =
        summary.lines().find(|l| l.trim_start().starts_with("C1 ")).expect("C1 row").split_whitespace().collect();
    assert_eq!(c1[c1.len() - 2], "2", "barrels of C1 in {c1:?}");
    // The short form is refused: the two unused values are required.
    let o = run_variant(&engine, circular, "C1 CUSTOM 0.4 SHP 2", curve);
    assert!(!ok(&o) && errors(&o) > 0);

    // A subcatchment needs its curb length, a subarea its routing keyword.
    let o = run_variant(&engine, "150      1.5      0\n", "150      1.5\n", "");
    assert!(!ok(&o) && errors(&o) > 0);
    let o = run_variant(&engine, "5          25         OUTLET\n", "5          25\n", "");
    assert!(!ok(&o) && errors(&o) > 0);

    // Section names are read by their first letters.
    let o = run_variant(&engine, "[JUNCTIONS]", "[JUNCTION]", "");
    assert!(ok(&o), "{:?}", o.report);

    // A semicolon starts a comment even inside quotes: the line is cut there.
    let o = run_variant(&engine, "[JUNCTIONS]\n", "[JUNCTIONS]\n\"J;9\" 100 2 0 0 0\n", "");
    assert!(!ok(&o) && errors(&o) > 0);

    // Curves named by an underdrain (9th token of a DRAIN line) and by a custom inlet
    // (3rd token): the engine looks them up there, and refuses a name it does not know.
    let names = |o: &swmm_engine::RunOutcome, id: &str| {
        o.report.as_ref().is_some_and(|r| {
            r.errors.iter().any(|m| m.text.contains(id) || m.context.as_deref().is_some_and(|c| c.contains(id)))
        })
    };
    let lid =
        |curve: &str| format!("\n[LID_CONTROLS]\nRB RB\nRB STORAGE 900 0.75 0.5 0\nRB DRAIN 1 0.5 0 6 0 0 {curve}\n");
    let control = "\n[CURVES]\nQC CONTROL 0 1\nQC 1 1\n";
    let o = run_variant(&engine, "[JUNCTIONS]", "[JUNCTIONS]", &format!("{}{control}", lid("NOPE")));
    assert!(!ok(&o) && names(&o, "NOPE"), "{:?}", o.report);
    let o = run_variant(&engine, "[JUNCTIONS]", "[JUNCTIONS]", &format!("{}{control}", lid("QC")));
    assert!(ok(&o), "{:?}", o.report);
    let diversion = "\n[CURVES]\nDC DIVERSION 0 0\nDC 1 1\n";
    let o = run_variant(&engine, "[JUNCTIONS]", "[JUNCTIONS]", &format!("{diversion}\n[INLETS]\nIn1 CUSTOM NOPE\n"));
    assert!(!ok(&o) && names(&o, "NOPE"), "{:?}", o.report);
    let o = run_variant(&engine, "[JUNCTIONS]", "[JUNCTIONS]", &format!("{diversion}\n[INLETS]\nIn1 CUSTOM DC\n"));
    assert!(ok(&o), "{:?}", o.report);

    // A quote inside a name is an ordinary character: the node is known by that name.
    let o = run_variant(&engine, "[JUNCTIONS]\n", "[JUNCTIONS]\nPipe\"9 100 2 0 0 0\n", "");
    assert!(ok(&o), "{:?}", o.report);
    assert!(o.console[0].lines().any(|l| l.trim_start().starts_with("Pipe\"9 ")), "no node Pipe\"9 in the report");
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
