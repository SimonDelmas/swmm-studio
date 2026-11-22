use super::*;
use swmm_out::{ElementKind, OutSpec, OutWriter};

const TINY: &str = include_str!("../../../../testdata/tiny.inp");

const RPT: &str = "
  EPA STORM WATER MANAGEMENT MODEL - VERSION 5.2 (Build 5.2.4)

  WARNING 04: minimum elevation drop used for Conduit C2

  **************************        Volume        Volume
  Flow Routing Continuity        hectare-m      10^6 ltr
  **************************     ---------     ---------
  Continuity Error (%) .....        -0.081


  ******************
  Node Depth Summary
  ******************

  ---------------------------------------------------------------------------------
                                 Average  Maximum  Maximum  Time of Max    Reported
                                   Depth    Depth      HGL   Occurrence   Max Depth
  Node                 Type       Meters   Meters   Meters  days hr:min      Meters
  ---------------------------------------------------------------------------------
  J1                   JUNCTION     0.01     0.06   100.06     0  04:01        0.06
  Out1                 OUTFALL      0.01     0.07    97.87     0  04:13        0.06
";

/// `tiny.inp` with a results file whose node order differs from the model's, and
/// value = 1000 * period + series index.
fn fixture() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let inp = dir.path().join("tiny.inp");
    std::fs::write(&inp, TINY).unwrap();
    let mut spec = OutSpec::simple(2, 4, 3, 45_444.0, 300);
    spec.nodes = ["Out1", "J1", "J2", "J3"].map(String::from).to_vec();
    spec.links = ["C1", "C2", "C3"].map(String::from).to_vec();
    let mut w = OutWriter::create(inp.with_extension("out"), &spec).unwrap();
    let n = w.layout().values_per_period();
    for p in 0..40 {
        let values: Vec<f32> = (0..n).map(|i| (p * 1000 + i) as f32).collect();
        w.write_period(45_444.0 + (p + 1) as f64 * 300.0 / 86_400.0, &values).unwrap();
    }
    w.finish(0).unwrap();
    std::fs::write(inp.with_extension("rpt"), RPT).unwrap();
    (dir, inp)
}

#[test]
fn open_finds_results_and_report() {
    let (_dir, inp) = fixture();
    let s = Session::open(&inp).unwrap();
    let info = s.info();
    assert_eq!((info.counts.nodes, info.counts.links, info.counts.subcatchments, info.counts.gages), (4, 3, 2, 1));
    assert_eq!(info.flow_units, "LPS");
    assert_eq!(info.crs_hint.as_ref().map(|c| c.id.as_str()), Some("EPSG:2154"));
    assert!(matches!(info.space, Space::Cartesian { .. }));
    let r = info.results.unwrap();
    assert_eq!((r.n_periods, r.step_secs), (40, 300));
    assert_eq!(r.matched["node"], 4);
    assert_eq!(r.cache, results::CacheState::Building { progress: 0.0 });
    let rep = info.report.unwrap();
    assert_eq!(rep.warnings[0].object, Some(ObjRef { kind: ObjKind::Link, index: 1 }));
    assert_eq!(rep.continuity, vec![("Flow routing".to_string(), -0.081)]);
    let i = rep.blocks.iter().position(|b| b.title == "Node Depth Summary").unwrap();
    let b = s.report_block(i, None).unwrap();
    assert_eq!((b.kind, b.rows.len(), b.id_kind), ("table", 2, Some(ObjKind::Node)));
}

#[test]
fn frames_follow_network_order() {
    let (_dir, inp) = fixture();
    let s = Session::open(&inp).unwrap();
    let lr = s.results.as_ref().unwrap();
    let layout = *lr.results.out().layout();
    // Network node 0 is J1, which is node 1 in the file.
    let f = s.frame(ElementKind::Node, 0, 3).unwrap();
    assert_eq!(f[0], (3000 + layout.series(ElementKind::Node, 1, 0)) as f32);
    assert_eq!(f[3], (3000 + layout.series(ElementKind::Node, 0, 0)) as f32);
    let mm = s.series(ElementKind::Node, 0, 0, 0, 40, 100, false, None).unwrap();
    assert_eq!(mm.len(), 40);
    assert_eq!(mm.max[5], (5000 + layout.series(ElementKind::Node, 1, 0)) as f32);
    assert_eq!(s.time_of_max(ElementKind::Link, 2, 0).unwrap(), 39);
    assert!(s.envelope_max(ElementKind::Node, 0).is_err());
    assert_eq!(s.next_event(ElementKind::Link, 2, 0, 0, 20_000.0).unwrap(), Some(20));
    let o = s.object(ObjRef { kind: ObjKind::Node, index: 0 }, Some(2)).unwrap();
    let depth = &o.results.unwrap()[0];
    assert_eq!((depth.name.as_str(), depth.unit.as_str(), depth.value), ("depth", "m", f[0] - 1000.0));
    assert_eq!(o.connections[0].id, "C1");
    assert!(!o.groups.iter().any(|g| g.title == "RDII"));
    let j2 = s.object(ObjRef { kind: ObjKind::Node, index: 1 }, None).unwrap();
    assert!(j2.groups.iter().any(|g| g.title == "RDII"));
}

#[test]
fn overlays_and_viewed_reports() {
    let (dir, inp) = fixture();
    let mut s = Session::open(&inp).unwrap();
    let other = dir.path().join("other.out");
    std::fs::copy(inp.with_extension("out"), &other).unwrap();
    s.set_overlays(std::slice::from_ref(&other)).unwrap();
    assert_eq!(s.info().overlays.len(), 1);
    assert!(s.cache_jobs().contains(&other));
    let a = s.series(ElementKind::Node, 0, 0, 0, 40, 100, false, None).unwrap();
    let b = s.series(ElementKind::Node, 0, 0, 0, 40, 100, false, Some(&other)).unwrap();
    assert_eq!(a.max, b.max);
    assert!(s.series(ElementKind::Node, 0, 0, 0, 40, 100, false, Some(&dir.path().join("x.out"))).is_err());
    s.set_overlays(&[]).unwrap();
    assert!(s.info().overlays.is_empty());

    // A report looked at besides the loaded one: its blocks are read by path.
    let rpt = dir.path().join("other.rpt");
    std::fs::write(&rpt, RPT).unwrap();
    let summary = s.view_report(&rpt).unwrap();
    assert_eq!(summary.path, rpt);
    let i = summary.blocks.iter().position(|b| b.title == "Node Depth Summary").unwrap();
    assert_eq!(s.report_block(i, Some(&rpt)).unwrap().rows.len(), 2);
    assert!(s.report_block(i, Some(&dir.path().join("x.rpt"))).is_err());
}

#[test]
fn crs_and_selection() {
    let (_dir, inp) = fixture();
    let mut s = Session::open(&inp).unwrap();
    // Cartesian: J1 is at (651200, 6862100) minus the origin.
    let Space::Cartesian { origin } = s.display.space else { panic!() };
    let j1 = [651_200.0 - origin[0], 6_862_100.0 - origin[1]];
    assert_eq!(s.pick(j1, 1.0), Some(ObjRef { kind: ObjKind::Node, index: 0 }));
    // Every object there, best first: the map skips the hidden ones.
    let all = s.pick_all(j1, 1.0);
    assert_eq!(all.first(), Some(&ObjRef { kind: ObjKind::Node, index: 0 }));
    s.set_crs(Some("EPSG:2154")).unwrap();
    assert!(crate::project::project_path(&inp).exists());
    let info = s.info();
    assert_eq!(info.crs.unwrap().name, "RGF93 / Lambert-93");
    let b = info.bounds.unwrap();
    assert!(b[0] > 2.3 && b[2] < 2.4 && b[1] > 48.8 && b[3] < 48.9, "{b:?}");
    let geom = s.geometry();
    assert_eq!(&geom[0..4], b"SWG2");
    assert_eq!(u32::from_le_bytes(geom[4..8].try_into().unwrap()), 1);
    // J1 in lon/lat, then picked with a 1 m tolerance.
    let lon = f64::from_le_bytes(geom[64..72].try_into().unwrap());
    let lat = f64::from_le_bytes(geom[72..80].try_into().unwrap());
    assert_eq!(s.pick([lon, lat], 1.0), Some(ObjRef { kind: ObjKind::Node, index: 0 }));
    // Box around the whole model.
    let all = s.select_rect([b[0], b[1]], [b[2], b[3]]);
    assert_eq!(all.len(), 4 + 3 + 2 + 1);
    // Reopen: the project keeps the CRS.
    let again = Session::open(&inp).unwrap();
    assert_eq!(again.info().crs.unwrap().id, "EPSG:2154");
    s.set_crs(None).unwrap();
    assert!(matches!(s.info().space, Space::Cartesian { .. }));
}

#[test]
fn empty_model_opens_on_its_projection() {
    let dir = tempfile::tempdir().unwrap();
    let inp = dir.path().join("new.inp");
    crate::editing::create_model(&inp, "LPS").unwrap();
    let mut s = Session::open(&inp).unwrap();
    // Without a coordinate system there is nothing to centre on.
    assert_eq!(s.info().bounds, None);
    s.set_crs(Some("EPSG:2154")).unwrap();
    // Lambert-93 is centred on 3°E, 46.5°N.
    let b = s.info().bounds.unwrap();
    assert!(b[0] < 3.0 && b[2] > 3.0 && b[1] < 46.5 && b[3] > 46.5, "{b:?}");
}

#[test]
fn geometry_layout() {
    let (_dir, inp) = fixture();
    let s = Session::open(&inp).unwrap();
    let g = s.geometry();
    let u = |at: usize| u32::from_le_bytes(g[at..at + 4].try_into().unwrap()) as usize;
    let (nodes, links, link_pts, subs, sub_pts, gages) = (u(24), u(28), u(32), u(36), u(40), u(44));
    assert_eq!((nodes, links, link_pts, subs, sub_pts, gages), (4, 3, 6, 2, 10, 1));
    let floats = 2 * (nodes + link_pts + sub_pts + gages);
    let starts = 64 + 8 * floats;
    assert_eq!(u(starts + 4 * 3), 6);
    let ends = starts + 4 * (links + 1 + subs + 1);
    let types = ends + 8 * links + 8 * subs;
    // C1 goes from J1 (node 0) to J2 (node 1).
    assert_eq!((u(ends), u(ends + 4)), (0, 1));
    // S1 drains to J1, S2 to J2 (nodes).
    let outlets = ends + 8 * links;
    assert_eq!([u(outlets), u(outlets + 4), u(outlets + 8), u(outlets + 12)], [0, 0, 0, 1]);
    assert_eq!(g.len(), types + nodes + links);
    assert_eq!(g[types + 3], 1); // Out1 is an outfall
}

#[test]
fn queries_read_results() {
    let (_dir, inp) = fixture();
    let s = Session::open(&inp).unwrap();
    let layout = *s.results.as_ref().unwrap().results.out().layout();
    let flow = |link, p: usize| (p * 1000 + layout.series(ElementKind::Link, link, 0)) as f32;
    let q = |text: &str, period| s.select_query(ObjKind::Link, text, period);
    // The flow at the time step given.
    let mid = (flow(1, 3) + flow(2, 3)) / 2.0;
    assert_eq!(q(&format!("flow > {mid}"), Some(3)).unwrap(), vec![2]);
    // A statistic over the whole run.
    let mid = (flow(0, 39) + flow(1, 39)) / 2.0;
    assert_eq!(q(&format!("max(flow) < {mid}"), None).unwrap(), vec![0]);
    assert_eq!(q(&format!("MAX(Flow) >= {} and type = conduit", flow(1, 39)), None).unwrap(), vec![1, 2]);
    assert!(q("flow > 0", None).unwrap_err().contains("time step"));
    assert!(q("median(flow) > 0", None).unwrap_err().contains("unknown statistic"));
    assert!(q("max(rainfall) > 0", None).unwrap_err().contains("no rainfall"));
}

#[test]
fn files_changed_by_other_programs() {
    let (_dir, inp) = fixture();
    let mut s = Session::open(&inp).unwrap();
    let poll_twice = |s: &mut Session| {
        // A change is reported once the file stays the same between two looks.
        let first = s.poll_files();
        assert!(first.is_empty());
        s.poll_files()
    };
    assert!(poll_twice(&mut s).is_empty());
    // Saved by the app: not a change.
    s.save(None).unwrap();
    assert!(poll_twice(&mut s).is_empty());
    // Changed by another program.
    std::fs::write(&inp, format!("{TINY}\n; edited elsewhere\n")).unwrap();
    let out = inp.with_extension("out");
    let mut bytes = std::fs::read(&out).unwrap();
    bytes.extend_from_slice(&[0; 4]);
    // The loaded results are memory-mapped: the system may refuse to write over them.
    let out_written = std::fs::write(&out, &bytes).is_ok();
    let changes = poll_twice(&mut s);
    assert!(changes.contains(&FileChange { kind: "model", path: inp.clone(), exists: true }), "{changes:?}");
    let results = FileChange { kind: "results", path: out.clone(), exists: true };
    assert_eq!(changes.contains(&results), out_written, "{changes:?}");
    // Reported once; kept as it is, not reported again.
    assert!(s.poll_files().is_empty());
    s.ignore_file_change("model").unwrap();
    s.ignore_file_change("results").unwrap();
    assert!(poll_twice(&mut s).is_empty());
    assert!(s.ignore_file_change("rpt").is_err());
}
