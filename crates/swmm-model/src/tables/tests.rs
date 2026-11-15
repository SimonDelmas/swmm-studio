use super::*;
use crate::edit::History;

const SRC: &str = "\
[CURVES]
;;Name Type X Y
SC1 STORAGE 0 10 1 20
SC1 2 30
PC1 PUMP2 0 1

[TIMESERIES]
TS1 01/01/2000 0:00 0 1:00 2.5
TS1 2:00 1
TS2 FILE \"rain.dat\"

[PATTERNS]
P1 DAILY 1 1 1 1 1 1
P1 0.5

[HYDROGRAPHS]
UH1 RG1
UH1 All Short 0.01 1 2
UH1 All Medium 0.02 3 2 1 0.1 0

[TRANSECTS]
NC 0.03 0.03 0.015
X1 T1 3 10 20 0.0 0.0 0.0 0 0 0
GR 5 0 1 10 5 20
X1 T2 2 0 1 0.0 0.0 0.0 0 0 0
GR 3 0 3 1
";

#[test]
fn reads_tables() {
    let inp = InpFile::parse_str(SRC);
    let Some(Table::Curve(c)) = read(&inp, RefKind::Curve, "sc1") else { panic!() };
    assert_eq!(c.curve_type, "STORAGE");
    assert_eq!(c.points.len(), 3);
    let Some(Table::Timeseries(ts)) = read(&inp, RefKind::Timeseries, "TS1") else { panic!() };
    assert_eq!(ts.rows.len(), 3);
    assert_eq!(ts.rows[0].date, "01/01/2000");
    assert_eq!((ts.rows[1].date.as_str(), ts.rows[1].time.as_str(), ts.rows[1].value.as_str()), ("", "1:00", "2.5"));
    let Some(Table::Timeseries(f)) = read(&inp, RefKind::Timeseries, "TS2") else { panic!() };
    assert_eq!(f.file.as_deref(), Some("rain.dat"));
    let Some(Table::Pattern(p)) = read(&inp, RefKind::Pattern, "P1") else { panic!() };
    assert_eq!((p.pattern_type.as_str(), p.factors.len()), ("DAILY", 7));
    let Some(Table::Hydrograph(h)) = read(&inp, RefKind::Hydrograph, "UH1") else { panic!() };
    assert_eq!(h.gage, "RG1");
    assert_eq!(h.rows[1].dmax, "1");
    let Some(Table::Transect(t)) = read(&inp, RefKind::Transect, "T2") else { panic!() };
    assert_eq!(t.n_channel, "0.015");
    assert_eq!(t.points, vec![["0".to_string(), "3".to_string()], ["1".to_string(), "3".to_string()]]);
    assert!(read(&inp, RefKind::Curve, "nope").is_none());
}

#[test]
fn writes_with_minimal_changes() {
    let mut inp = InpFile::parse_str(SRC);
    let mut h = History::default();
    let Some(Table::Curve(mut c)) = read(&inp, RefKind::Curve, "SC1") else { panic!() };
    // Same content: nothing changes.
    h.edit(&mut inp, "same", |tx| write(tx, &Table::Curve(c.clone()))).unwrap();
    assert!(h.undo_label().is_none());
    c.points.push(["3".into(), "45".into()]);
    h.edit(&mut inp, "curve", |tx| write(tx, &Table::Curve(c.clone()))).unwrap();
    let text = inp.to_string_lossy();
    assert!(text.contains(";;Name Type X Y\nSC1              STORAGE    0          10\nSC1              1          20\nSC1              2          30\nSC1              3          45\nPC1 PUMP2 0 1\n"), "{text}");
    // New pattern appended; invalid one refused.
    let mut p = Table::empty(RefKind::Pattern, "P2").unwrap();
    h.edit(&mut inp, "p", |tx| write(tx, &p)).unwrap();
    assert!(inp.to_string_lossy().contains("P2               HOURLY     1.0"));
    if let Table::Pattern(pp) = &mut p {
        pp.factors.pop();
    }
    assert!(h.edit(&mut inp, "p", |tx| write(tx, &p)).is_err());
    h.undo(&mut inp);
    h.undo(&mut inp);
    assert_eq!(inp.to_string_lossy(), SRC);
}

#[test]
fn transect_roughness_stays_with_the_next_one() {
    let mut inp = InpFile::parse_str(SRC);
    let mut h = History::default();
    let Some(Table::Transect(mut t1)) = read(&inp, RefKind::Transect, "T1") else { panic!() };
    t1.n_channel = "0.02".into();
    t1.points.push(["30".into(), "6".into()]);
    h.edit(&mut inp, "t1", |tx| write(tx, &Table::Transect(t1.clone()))).unwrap();
    let Some(Table::Transect(t2)) = read(&inp, RefKind::Transect, "T2") else { panic!() };
    assert_eq!(t2.n_channel, "0.015");
    let Some(Table::Transect(again)) = read(&inp, RefKind::Transect, "T1") else { panic!() };
    assert_eq!(again, t1);
    let text = inp.to_string_lossy();
    assert!(text.contains("X1               T1         4"), "{text}");
    // Deleting T1 keeps T2's roughness too.
    h.undo(&mut inp);
    h.edit(&mut inp, "del", |tx| delete(tx, RefKind::Transect, "T1")).unwrap();
    let Some(Table::Transect(t2)) = read(&inp, RefKind::Transect, "T2") else { panic!() };
    assert_eq!(t2.n_channel, "0.015");
    assert!(read(&inp, RefKind::Transect, "T1").is_none());
    h.undo(&mut inp);
    assert_eq!(inp.to_string_lossy(), SRC);
}

#[test]
fn delete_refuses_used_objects() {
    let src = format!("{SRC}\n[STORAGE]\nST1 0 5 0 TABULAR SC1 0 0\n");
    let mut inp = InpFile::parse_str(&src);
    let mut h = History::default();
    let e = h.edit(&mut inp, "d", |tx| delete(tx, RefKind::Curve, "SC1")).unwrap_err();
    assert!(e.contains("ST1 [STORAGE]"), "{e}");
    h.edit(&mut inp, "d", |tx| delete(tx, RefKind::Curve, "PC1")).unwrap();
    assert!(read(&inp, RefKind::Curve, "PC1").is_none());
}
