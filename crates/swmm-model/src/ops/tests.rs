use swmm_inp::{InpFile, SectionKind};

use super::*;
use crate::edit::{EditResult, History, Tx};
use crate::schema::RefKind;
use crate::{LinkType, Network, NodeType, ObjKind};

const SRC: &str = "\
[OPTIONS]
FLOW_UNITS LPS
INFILTRATION HORTON

[RAINGAGES]
RG1 INTENSITY 0:05 1.0 TIMESERIES TS1

[SUBCATCHMENTS]
S1 RG1 J1 2.5 60 150 1.5 0

[SUBAREAS]
S1 0.013 0.15 1.5 5 25 OUTLET

[JUNCTIONS]
;;Name Elev
J1   100.0   2.5   0 0 0
J2   99.0    2.5   0 0 0

[OUTFALLS]
O1 97 FREE NO

[CONDUITS]
C1 J1 J2 120 0.013 0 0
C2 J2 O1 50 0.013 0 0

[XSECTIONS]
C1 CIRCULAR 0.4 0 0 0 1
C2 CIRCULAR 0.5 0 0 0 1

[DWF]
J1 FLOW 1.5

[RDII]
J2 UH1 10

[REPORT]
NODES J1 J2

[TAGS]
Node J1 main

[COORDINATES]
J1 0 0
J2 10 0
O1 20 0

[VERTICES]
C2 15 1
";

fn run<T>(inp: &mut InpFile, h: &mut History, f: impl FnOnce(&mut Tx) -> EditResult<T>) -> EditResult<T> {
    h.edit(inp, "t", f).map(|a| a.value)
}

#[test]
fn field_edits_keep_spacing() {
    let mut inp = InpFile::parse_str(SRC);
    let mut h = History::default();
    run(&mut inp, &mut h, |tx| set_field(tx, &SectionKind::Junctions, &["j1".into()], 1, "101.5")).unwrap();
    assert!(inp.to_string_lossy().contains("J1   101.5   2.5   0 0 0\n"));
    let e = run(&mut inp, &mut h, |tx| set_field(tx, &SectionKind::Junctions, &["J1".into()], 2, "-1"));
    assert!(e.is_err());
    run(&mut inp, &mut h, |tx| set_field(tx, &SectionKind::Outfalls, &["O1".into()], 2, "fixed")).unwrap();
    assert!(inp.to_string_lossy().contains("O1               97         FIXED      0          NO\n"));
    let n = run(&mut inp, &mut h, |tx| {
        set_field_bulk(tx, &SectionKind::Conduits, &["C1".into(), "C2".into(), "X".into()], "n", "0.015")
    })
    .unwrap();
    assert_eq!(n, 2);
    assert!(inp.to_string_lossy().contains("C2 J2 O1 50 0.015 0 0"));
    run(&mut inp, &mut h, |tx| add_line(tx, &SectionKind::Rdii, &["J1".into()])).unwrap();
    assert!(inp.to_string_lossy().contains("J1               *          0\n"));
    run(&mut inp, &mut h, |tx| remove_line(tx, &SectionKind::Dwf, &["J1".into(), "FLOW".into()])).unwrap();
    assert!(!inp.to_string_lossy().contains("J1 FLOW 1.5"));
    while h.undo(&mut inp).is_some() {}
    assert_eq!(inp.to_string_lossy(), SRC);
}

#[test]
fn rename_updates_references() {
    let mut inp = InpFile::parse_str(SRC);
    let mut h = History::default();
    run(&mut inp, &mut h, |tx| rename(tx, RefKind::Node, "J1", "N1")).unwrap();
    let t = inp.to_string_lossy();
    for s in ["S1 RG1 N1", "N1   100.0", "C1 N1 J2", "N1 FLOW 1.5", "NODES N1 J2", "Node N1 main", "N1 0 0"] {
        assert!(t.contains(s), "{s} in {t}");
    }
    assert!(run(&mut inp, &mut h, |tx| rename(tx, RefKind::Node, "N1", "j2")).unwrap_err().contains("already"));
    assert!(run(&mut inp, &mut h, |tx| rename(tx, RefKind::Node, "N1", "a b")).is_err());
}

#[test]
fn rename_updates_lid_drains_aquifer_patterns_and_adjustments() {
    let src = "[JUNCTIONS]\nJ1 1\n[SUBCATCHMENTS]\nS1 * J1 1 50 100 1 0\nS2 * S1 1 50 100 1 0\n\
                   [LID_USAGE]\nS2 Barrel 1 10 0 0 50 0 * S1\nS1 Barrel 1 10 0 0 50 0 * J1\n\
                   [PATTERNS]\nP1 MONTHLY 1 1 1 1 1 1 1 1 1 1 1 1\n\
                   [AQUIFERS]\nA1 0.5 0.15 0.3 5 10 15 0.35 14 0.002 0 10 0.3 P1\n\
                   [ADJUSTMENTS]\nN-PERV S1 P1\nRAINFALL 1 1 1 1 1 1 1 1 1 1 1 1\n\
                   [CURVES]\nCrv CONTROL 0 1\nCrv 1 0\n\
                   [LID_CONTROLS]\nBarrel DRAIN 0.5 0.5 6 6 0 0 Crv\n[INLETS]\nIn1 CUSTOM Crv\n";
    let mut inp = InpFile::parse_str(src);
    let mut h = History::default();
    run(&mut inp, &mut h, |tx| rename(tx, RefKind::Subcatchment, "S1", "West")).unwrap();
    run(&mut inp, &mut h, |tx| rename(tx, RefKind::Node, "J1", "N1")).unwrap();
    run(&mut inp, &mut h, |tx| rename(tx, RefKind::Pattern, "P1", "Monthly")).unwrap();
    run(&mut inp, &mut h, |tx| rename(tx, RefKind::Curve, "Crv", "Flow")).unwrap();
    let t = inp.to_string_lossy();
    for s in [
        "50 0 * West",
        "50 0 * N1",
        "0.3 Monthly",
        "N-PERV West Monthly",
        "RAINFALL 1 1",
        "6 6 0 0 Flow",
        "CUSTOM Flow",
    ] {
        assert!(t.contains(s), "{s} in {t}");
    }
}

#[test]
fn delete_cascades() {
    let mut inp = InpFile::parse_str(SRC);
    let mut h = History::default();
    let net = Network::from_inp(&inp);
    let j2 = net.find_ref(ObjKind::Node, "J2").unwrap();
    let plan = delete_plan(&inp, &net, &[j2]);
    assert_eq!(plan.nodes, ["J2"]);
    assert_eq!(plan.cascade_links, ["C1", "C2"]);
    assert_eq!(plan.cleared, ["[REPORT] NODES"]);
    run(&mut inp, &mut h, |tx| delete(tx, &net, &[j2])).unwrap();
    let t = inp.to_string_lossy();
    assert!(!t.contains("J2"), "{t}");
    assert!(!t.contains("C1 ") && !t.contains("C2 "), "{t}");
    assert!(t.contains("NODES            J1\n"), "{t}");
    // Deleting the outlet node of a subcatchment clears the reference.
    let net = Network::from_inp(&inp);
    let j1 = net.find_ref(ObjKind::Node, "J1").unwrap();
    run(&mut inp, &mut h, |tx| delete(tx, &net, &[j1])).unwrap();
    let t = inp.to_string_lossy();
    assert!(t.contains("S1               RG1        *          2.5"), "{t}");
    assert!(!t.contains("[REPORT]\nNODES"), "{t}");
    while h.undo(&mut inp).is_some() {}
    assert_eq!(inp.to_string_lossy(), SRC);
}

#[test]
fn add_objects() {
    let mut inp = InpFile::parse_str(SRC);
    let mut h = History::default();
    let net = Network::from_inp(&inp);
    let j = run(&mut inp, &mut h, |tx| add_node(tx, &net, NodeType::Junction, [5.0, 5.0], 3)).unwrap();
    assert_eq!(j, "J3");
    let net = Network::from_inp(&inp);
    let c =
        run(&mut inp, &mut h, |tx| add_link(tx, &net, LinkType::Conduit, ["J3", "O1"], &[[7.0, 6.0]], Some(18.234), 3))
            .unwrap();
    assert_eq!(c, "C3");
    let net = Network::from_inp(&inp);
    let s = run(&mut inp, &mut h, |tx| {
        add_subcatchment(tx, &net, &[[0.0, 10.0], [10.0, 10.0], [10.0, 20.0]], Some("J3"), Some(0.005), 3)
    })
    .unwrap();
    let g = run(&mut inp, &mut h, |tx| add_gage(tx, &net, [1.0, 1.0], 3)).unwrap();
    assert_eq!((s.as_str(), g.as_str()), ("S2", "RG2"));
    let t = inp.to_string_lossy();
    for want in [
        "J3               0          0          0          0          0\n",
        "C3               J3         O1         18.23      0.01       0          0          0          0\n",
        "C3               CIRCULAR   1          0          0          0          1\n",
        "C3               7.000      6.000\n",
        "S2               RG1        J3         0.0050     25         7.1        0.5        0\n",
        "S2               0.01       0.1        0.05       0.05       25         OUTLET     100\n",
        "S2               3          0.5        4          7          0\n",
        "J3               5.000      5.000\n",
        "RG2              INTENSITY  1:00       1.0        TIMESERIES *\n",
        "[SYMBOLS]\nRG2              1.000      1.000\n",
    ] {
        assert!(t.contains(want), "{want:?} not in\n{t}");
    }
    let net = Network::from_inp(&inp);
    assert_eq!(net.nodes.len(), 4);
    assert_eq!(net.links[2].vertices, vec![[7.0, 6.0]]);
    assert!(run(&mut inp, &mut h, |tx| add_link(tx, &net, LinkType::Pump, ["J3", "j3"], &[], None, 3)).is_err());
}

#[test]
fn geometry_options_title_rdii() {
    let mut inp = InpFile::parse_str(SRC);
    let mut h = History::default();
    run(&mut inp, &mut h, |tx| set_geometry(tx, ObjKind::Link, "C2", &[[12.0, 2.0], [16.0, 2.5]], 2)).unwrap();
    assert!(inp
        .to_string_lossy()
        .contains("[VERTICES]\nC2               12.00      2.00\nC2               16.00      2.50\n"));
    run(&mut inp, &mut h, |tx| set_geometry(tx, ObjKind::Link, "C2", &[], 2)).unwrap();
    assert!(!inp.to_string_lossy().contains("C2               12.00"));
    run(&mut inp, &mut h, |tx| {
        set_options(
            tx,
            &[("flow_units".into(), "CMS".into()), ("INFILTRATION".into(), "".into()), ("THREADS".into(), "4".into())],
        )
    })
    .unwrap();
    assert_eq!(inp.option("FLOW_UNITS").as_deref(), Some("CMS"));
    assert_eq!(inp.option("INFILTRATION"), None);
    assert_eq!(inp.option("THREADS").as_deref(), Some("4"));
    run(&mut inp, &mut h, |tx| set_title(tx, "My model\nsecond line\n")).unwrap();
    assert_eq!(title(&inp), "My model\nsecond line");
    assert!(inp.to_string_lossy().starts_with("[TITLE]\nMy model\nsecond line\n\n[OPTIONS]"));
    let n = run(&mut inp, &mut h, |tx| assign_rdii(tx, &["J1".into(), "J2".into()], "UH9", Some("2.5"))).unwrap();
    assert_eq!(n, 2);
    let t = inp.to_string_lossy();
    assert!(t.contains("J2 UH9 2.5\n") && t.contains("J1               UH9        2.5\n"), "{t}");
    assert_eq!(run(&mut inp, &mut h, |tx| Ok(remove_rdii(tx, &["J2".into()]))).unwrap(), 1);
    while h.undo(&mut inp).is_some() {}
    assert_eq!(inp.to_string_lossy(), SRC);
}
