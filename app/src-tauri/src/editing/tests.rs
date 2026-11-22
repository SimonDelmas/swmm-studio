use super::*;

const TINY: &str = include_str!("../../../../testdata/tiny.inp");

fn open() -> (tempfile::TempDir, Session) {
    let dir = tempfile::tempdir().unwrap();
    let inp = dir.path().join("tiny.inp");
    std::fs::write(&inp, TINY).unwrap();
    let s = Session::open(&inp).unwrap();
    (dir, s)
}

fn node(s: &Session, id: &str) -> ObjRef {
    s.net.find_ref(ObjKind::Node, id).unwrap()
}

#[test]
fn field_edit_undo_redo_save() {
    let (dir, mut s) = open();
    let j1 = node(&s, "J1");
    let o = s
        .edit(
            EditRequest::SetField {
                section: "JUNCTIONS".into(),
                key: vec!["J1".into()],
                field: 1,
                value: "100.5".into(),
            },
            &[j1],
        )
        .unwrap();
    assert!(!o.geometry && !o.rebuilt);
    assert_eq!(o.selection, vec![j1]);
    assert!(o.info.dirty);
    assert_eq!(o.info.undo.as_deref(), Some("Edit J1"));
    assert!(s.inp.to_string_lossy().contains("J1               100.5      2.5"));
    let bad = s.edit(
        EditRequest::SetField { section: "JUNCTIONS".into(), key: vec!["J1".into()], field: 2, value: "x".into() },
        &[],
    );
    assert!(bad.is_err());
    s.undo(&[]).unwrap();
    assert_eq!(s.inp.to_string_lossy(), TINY);
    assert!(!s.info().dirty);
    s.redo(&[]).unwrap();
    // Save as: new file and project, clean state.
    let copy = dir.path().join("copy.inp");
    s.save(Some(&copy)).unwrap();
    assert!(!s.info().dirty);
    assert!(std::fs::read_to_string(&copy).unwrap().contains("100.5"));
    assert!(crate::project::project_path(&copy).exists());
    assert_eq!(s.inp_path, copy);
}

#[test]
fn add_move_reconnect_delete() {
    let (_dir, mut s) = open();
    s.set_crs(Some("EPSG:2154")).unwrap();
    // Add a junction next to J3 (display coordinates are lon/lat).
    let j3 = node(&s, "J3");
    let p = s.display.node_point(j3.index as usize).unwrap();
    let at = [p[0] + 0.0005, p[1] + 0.0003];
    let o = s.edit(EditRequest::AddNode { node_type: NodeType::Junction, xy: at }, &[]).unwrap();
    assert!(o.rebuilt && o.geometry);
    let j4 = o.selection[0];
    assert_eq!(s.net.id(j4), "J4");
    let xy = s.net.nodes[j4.index as usize].xy.unwrap();
    assert!((xy[0] - 651_457.0).abs() < 2.0 && (xy[1] - 6_862_014.0).abs() < 2.0, "{xy:?}");
    // A conduit J3 → J4: length from geometry (~49.5 m: 36.6 m east, 33.4 m north).
    let o = s
        .edit(
            EditRequest::AddLink { link_type: LinkType::Conduit, from: j3.index, to: j4.index, vertices: vec![] },
            &[],
        )
        .unwrap();
    let c4 = o.selection[0];
    let len: f64 = s.inp.rows(&SectionKind::Conduits).last().unwrap().token(3).unwrap().parse().unwrap();
    assert!((len - 49.5).abs() < 1.0, "{len}");
    // Move J4: incremental, the conduit follows.
    let o = s.edit(EditRequest::SetGeometry { object: j4, points: vec![[at[0] + 0.001, at[1]]] }, &[j4]).unwrap();
    assert!(!o.geometry && !o.rebuilt);
    // Patch: the node and its conduit.
    let p = o.patch.unwrap();
    assert_eq!((p.nodes.len(), p.links.len()), (1, 1));
    assert_eq!(p.links[0].1, [j3.index, j4.index]);
    assert_eq!(p.links[0].2.last(), Some(&p.nodes[0].1));
    assert_eq!(o.selection, vec![j4]);
    let picked = s.pick([at[0] + 0.001, at[1]], 1.0);
    assert_eq!(picked, Some(j4));
    assert_eq!(s.geometry(), fresh_geometry(&mut s));
    // Reconnect C4 to Out1, then delete J4.
    let out1 = node(&s, "Out1");
    s.edit(EditRequest::Reconnect { link: c4.index, end: LinkEnd::To, node: out1.index }, &[]).unwrap();
    assert_eq!(s.net.links[c4.index as usize].to, Some(out1.index));
    let plan = s.delete_plan(&[j4]);
    assert!(plan.cascade_links.is_empty());
    let o = s.edit(EditRequest::Delete { objects: vec![j4] }, &[j4]).unwrap();
    assert!(o.selection.is_empty() && o.rebuilt);
    assert_eq!(s.net.nodes.len(), 4);
    // Undo the delete: J4 comes back selected.
    let o = s.undo(&[]).unwrap();
    assert_eq!(o.selection.len(), 1);
    assert_eq!(s.net.id(o.selection[0]), "J4");
    while s.history.undo_label().is_some() {
        s.undo(&[]).unwrap();
    }
    assert_eq!(s.inp.to_string_lossy(), TINY);
    assert_eq!(s.geometry(), fresh_geometry(&mut s));
}

/// Geometry buffer with the display rebuilt from scratch.
fn fresh_geometry(s: &mut Session) -> Vec<u8> {
    let fresh = crate::session::Display::build(&s.net, s.crs.as_ref(), None);
    let saved = std::mem::replace(&mut s.display, fresh);
    let g = s.geometry();
    s.display = saved;
    g
}

#[test]
fn subcatchment_tables_options_rdii() {
    let (_dir, mut s) = open();
    // Cartesian display: offsets from the origin.
    let Space::Cartesian { origin } = s.display.space else { panic!() };
    let ring: Vec<[f64; 2]> =
        [[651_420.0, 6_861_900.0], [651_520.0, 6_861_900.0], [651_520.0, 6_861_800.0], [651_420.0, 6_861_800.0]]
            .iter()
            .map(|p| [p[0] - origin[0], p[1] - origin[1]])
            .collect();
    let o = s.edit(EditRequest::AddSubcatchment { polygon: ring }, &[]).unwrap();
    let line = s.inp.rows(&SectionKind::Subcatchments).last().unwrap().to_vec();
    // 1 ha, outlet = nearest node (Out1), gage RG1.
    assert_eq!(
        (line[0].as_str(), line[1].as_str(), line[2].as_str(), line[3].as_str()),
        ("S3", "RG1", "Out1", "1.0000")
    );
    assert_eq!(o.selection.len(), 1);
    // Tables.
    let o = s.edit(EditRequest::AddTable { kind: RefKind::Curve }, &[]).unwrap();
    assert_eq!(o.created.as_deref(), Some("Curve1"));
    let Table::Curve(mut c) = s.table(RefKind::Curve, "Curve1").unwrap() else { panic!() };
    c.name = "SC".into();
    c.points = vec![["0".into(), "10".into()], ["2".into(), "50".into()]];
    s.edit(EditRequest::SetTable { table: Table::Curve(c), old_name: Some("Curve1".into()) }, &[]).unwrap();
    assert!(s.names(RefKind::Curve) == ["SC"]);
    let e = s.edit(EditRequest::DeleteTable { kind: RefKind::Hydrograph, name: "UH1".into() }, &[]).unwrap_err();
    assert!(e.contains("J2 [RDII]"), "{e}");
    // Options and title.
    s.edit(EditRequest::SetOptions { values: vec![("ROUTING_STEP".into(), "0:00:05".into())] }, &[]).unwrap();
    assert!(s.options().values.contains(&("ROUTING_STEP".into(), "0:00:05".into())));
    s.edit(EditRequest::SetTitle { text: "New title".into() }, &[]).unwrap();
    assert_eq!(s.options().title, "New title");
    // RDII on J1 and J3.
    let (j1, j3) = (node(&s, "J1"), node(&s, "J3"));
    let o = s
        .edit(
            EditRequest::AssignRdii {
                nodes: vec![j1.index, j3.index],
                hydrograph: "UH1".into(),
                area: Some("5".into()),
            },
            &[],
        )
        .unwrap();
    assert_eq!(o.message.as_deref(), Some("2 node(s) assigned to UH1"));
    assert_eq!(s.inp.rows(&SectionKind::Rdii).count(), 3);
    // Bulk edit of the conduits' roughness.
    let links: Vec<ObjRef> = (0..3).map(|index| ObjRef { kind: ObjKind::Link, index }).collect();
    let o = s
        .edit(
            EditRequest::SetFieldBulk {
                objects: links,
                section: "CONDUITS".into(),
                field: "n".into(),
                value: "0.015".into(),
            },
            &[],
        )
        .unwrap();
    assert_eq!(o.message.as_deref(), Some("3 of 3 objects changed"));
}

#[test]
fn new_model_from_template() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("new.inp");
    create_model(&p, "cms").unwrap();
    let mut s = Session::open(&p).unwrap();
    assert_eq!(s.info().flow_units, "CMS");
    let o = s.edit(EditRequest::AddNode { node_type: NodeType::Outfall, xy: [10.0, 20.0] }, &[]).unwrap();
    assert_eq!(s.net.id(o.selection[0]), "Out1");
    assert_eq!(s.net.nodes[0].xy, Some([10.0, 20.0]));
    s.save(None).unwrap();
    let again = Session::open(&p).unwrap();
    assert_eq!(again.net.nodes.len(), 1);
}

#[test]
fn autosave_restore_and_save() {
    let (dir, mut s) = open();
    let rec = dir.path().join("recovery");
    s.start_autosave(&rec);
    let file = s.autosave.as_ref().unwrap().file();
    // Clean: nothing written.
    s.autosave().unwrap();
    assert!(!file.exists());
    let j1 = node(&s, "J1");
    let edit =
        EditRequest::SetField { section: "JUNCTIONS".into(), key: vec!["J1".into()], field: 1, value: "100.5".into() };
    s.edit(edit, &[j1]).unwrap();
    s.autosave().unwrap();
    assert!(std::fs::read_to_string(&file).unwrap().contains("100.5"));
    // Back to the saved state: the recovery file goes.
    s.undo(&[]).unwrap();
    s.autosave().unwrap();
    assert!(!file.exists());
    s.redo(&[]).unwrap();
    s.autosave().unwrap();
    let left = std::fs::read(&file).unwrap();
    let json = file.with_extension("json");
    let info = std::fs::read(&json).unwrap();
    let inp = s.inp_path.clone();
    drop(s);
    assert!(!file.exists(), "closing gives the changes up");

    // As a crash leaves them: the next session offers them.
    std::fs::write(&file, &left).unwrap();
    std::fs::write(&json, &info).unwrap();
    let mut s = Session::open(&inp).unwrap();
    s.start_autosave(&rec);
    assert!(s.info().recovery.is_some());
    assert!(!s.info().dirty);
    s.restore_recovery().unwrap();
    let i = s.info();
    assert!(i.recovery.is_none() && i.dirty);
    assert!(s.inp.to_string_lossy().contains("100.5"));
    // Undo cannot make it match the file on disk.
    assert!(i.undo.is_none());
    s.save(None).unwrap();
    assert!(!s.info().dirty);
    assert!(!file.exists());
    assert!(std::fs::read_to_string(&inp).unwrap().contains("100.5"));
}

#[test]
fn snow_packs_and_aquifers() {
    let (_dir, mut s) = open();
    let o = s.edit(EditRequest::AddTable { kind: RefKind::Snowpack }, &[]).unwrap();
    assert_eq!(o.created.as_deref(), Some("Snow1"));
    // A metric model: snow melts from 0 degrees C.
    let Table::Snowpack(p) = s.table(RefKind::Snowpack, "Snow1").unwrap() else { panic!() };
    assert_eq!(p.pervious[2], "0.0");
    let o = s.edit(EditRequest::AddTable { kind: RefKind::Aquifer }, &[]).unwrap();
    assert_eq!(o.created.as_deref(), Some("Aquifer1"));
    assert_eq!(s.names(RefKind::Aquifer), ["Aquifer1"]);
    s.edit(EditRequest::AddLine { section: "GROUNDWATER".into(), key: vec!["S1".into()] }, &[]).unwrap();
    s.edit(
        EditRequest::SetField {
            section: "GROUNDWATER".into(),
            key: vec!["S1".into()],
            field: 1,
            value: "Aquifer1".into(),
        },
        &[],
    )
    .unwrap();
    let e = s.edit(EditRequest::DeleteTable { kind: RefKind::Aquifer, name: "Aquifer1".into() }, &[]).unwrap_err();
    assert!(e.contains("S1 [GROUNDWATER]"), "{e}");
}
