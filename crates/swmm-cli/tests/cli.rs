use std::path::Path;
use std::process::{Command, Output};

fn cli(args: &[&str], settings: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_swmm-cli"))
        .args(args)
        .env("SWMM_STUDIO_SETTINGS", settings)
        .output()
        .expect("run swmm-cli")
}

fn text(o: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
}

#[test]
fn inp_commands() {
    let dir = tempfile::tempdir().unwrap();
    let settings = dir.path().join("settings.json");
    let model = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata/tiny.inp");
    let o = cli(&["inp", "check", model.to_str().unwrap()], &settings);
    assert!(o.status.success(), "{}", text(&o));
    let o = cli(&["inp", "info", model.to_str().unwrap()], &settings);
    let t = text(&o);
    assert!(t.contains("flow units: LPS") && t.contains("[RDII] 1") && t.contains("storm.dat"), "{t}");
    let o = cli(&["inp", "validate", model.to_str().unwrap()], &settings);
    assert!(o.status.success() && text(&o).contains("0 error(s)"), "{}", text(&o));
    // A conduit to a missing node is an error.
    let broken = dir.path().join("broken.inp");
    let src = std::fs::read_to_string(&model)
        .unwrap()
        .replace("C3               J3               Out1", "C3               J3               Nowhere");
    std::fs::write(&broken, src).unwrap();
    let o = cli(&["inp", "validate", broken.to_str().unwrap()], &settings);
    let t = text(&o);
    assert_eq!(o.status.code(), Some(1), "{t}");
    assert!(t.contains("unknown_reference") && t.contains("Nowhere"), "{t}");
}

#[test]
fn out_pipeline() {
    let dir = tempfile::tempdir().unwrap();
    let settings = dir.path().join("settings.json");
    let out = dir.path().join("s.out");
    let out_s = out.to_str().unwrap();
    let o = cli(
        &["out", "synth", out_s, "--subcatchments", "2", "--nodes", "5", "--links", "4", "--periods", "3000"],
        &settings,
    );
    assert!(o.status.success(), "{}", text(&o));
    let t = text(&cli(&["out", "info", out_s], &settings));
    assert!(t.contains("3000 periods") && t.contains("results cache: none"), "{t}");
    let o = cli(&["out", "stats", out_s], &settings);
    assert!(!o.status.success(), "stats need the cache");
    assert!(cli(&["out", "cache", out_s], &settings).status.success());
    let t = text(&cli(&["out", "stats", out_s, "--kind", "link", "--var", "flow", "--top", "2"], &settings));
    assert_eq!(t.lines().filter(|l| l.starts_with('L')).count(), 2, "{t}");
    let o = cli(
        &["out", "events", out_s, "--kind", "link", "--var", "flow", "--threshold", "0.1", "--ids", "L1,L2"],
        &settings,
    );
    let t = text(&o);
    assert!(
        o.status.success() && t.contains("per year") && t.lines().filter(|l| l.starts_with('L')).count() == 2,
        "{t}"
    );
    let csv = dir.path().join("x.csv");
    let o = cli(
        &[
            "out",
            "export",
            out_s,
            "--kind",
            "node",
            "--ids",
            "N1,N3",
            "--vars",
            "depth,flooding",
            "--from",
            "2020-01-02",
            "--to",
            "2020-01-02 01:00",
            "-o",
            csv.to_str().unwrap(),
        ],
        &settings,
    );
    assert!(o.status.success(), "{}", text(&o));
    let body = std::fs::read_to_string(&csv).unwrap();
    let lines: Vec<&str> = body.lines().collect();
    assert_eq!(lines[0], "datetime,N1:depth,N1:flooding,N3:depth,N3:flooding");
    assert!(lines[1].starts_with("2020-01-02 00:00:00,"), "{}", lines[1]);
    assert_eq!(lines.len(), 1 + 13);
}

#[test]
fn run_without_engine_is_a_clear_error() {
    let dir = tempfile::tempdir().unwrap();
    let settings = dir.path().join("settings.json");
    let model = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata/tiny.inp");
    let o = cli(&["run", model.to_str().unwrap()], &settings);
    assert_eq!(o.status.code(), Some(2));
    assert!(text(&o).contains("no SWMM engine configured"), "{}", text(&o));
    let t = text(&cli(&["engine", "list"], &settings));
    assert!(t.contains("no engine configured"), "{t}");
}
