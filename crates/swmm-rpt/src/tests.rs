use super::*;

const OK: &str = r"
  EPA STORM WATER MANAGEMENT MODEL - VERSION 5.2 (Build 5.2.4)
  ------------------------------------------------------------

  Test model

  WARNING : No module file found!
  WARNING 04: minimum elevation drop used for Conduit C7

  **********************           Volume        Volume
  Rainfall Dependent I/I        hectare-m      10^6 ltr
  **********************        ---------     ---------
  Sewershed Rainfall ......         0.320         3.198
  RDII Produced ...........         0.010         0.100
  RDII Ratio ..............         0.031


  **************************        Volume         Depth
  Runoff Quantity Continuity     hectare-m            mm
  **************************     ---------       -------
  Total Precipitation ......         0.188         2.650
  Continuity Error (%) .....        -0.142


  **************************        Volume        Volume
  Flow Routing Continuity        hectare-m      10^6 ltr
  **************************     ---------     ---------
  Dry Weather Inflow .......         0.000         0.000
  RDII Inflow ..............         0.010         0.100
  Continuity Error (%) .....        -0.081


  *************************
  Highest Continuity Errors
  *************************
  Node 21 (28.25%)
  Node 20 (-1.08%)


  *************************
  Routing Time Step Summary
  *************************
  Minimum Time Step           :    37.57 sec
  Average Iterations per Step :     2.01


  ******************
  Node Depth Summary
  ******************

  ---------------------------------------------------------------------------------
                                 Average  Maximum  Maximum  Time of Max    Reported
                                   Depth    Depth      HGL   Occurrence   Max Depth
  Node                 Type       Meters   Meters   Meters  days hr:min      Meters
  ---------------------------------------------------------------------------------
  10                   JUNCTION     0.01     0.06   995.06     0  04:01        0.06
  18                   OUTFALL      0.01     0.07   975.07     0  04:13        0.06


  **********************
  Node Surcharge Summary
  **********************

  No nodes were surcharged.


  ***********************
  Outfall Loading Summary
  ***********************

  -----------------------------------------------------------
                         Flow       Avg       Max       Total
                         Freq      Flow      Flow      Volume
  Outfall Node           Pcnt       CMS       CMS    10^6 ltr
  -----------------------------------------------------------
  18                    84.66     0.007     0.053       0.596
  -----------------------------------------------------------
  System                84.66     0.007     0.053       0.596


  Analysis begun on:  Fri Oct 23 13:47:28 2026
  Analysis ended on:  Fri Oct 23 13:47:28 2026
  Total elapsed time: < 1 sec
";

const FAILED: &str = r"
  EPA STORM WATER MANAGEMENT MODEL - VERSION 5.2 (Build 5.2.4)
  ------------------------------------------------------------

  ERROR 209: undefined object XX9 at line 123 of [CONDUIT] section:
  4                XX9               20               200        0.01       0

  ERROR 200: one or more errors found in input file.

  Analysis begun on:  Fri Oct 23 14:07:21 2026
";

#[test]
fn header_and_messages() {
    let r = Report::parse(OK);
    assert_eq!(r.version.as_deref(), Some("5.2 (Build 5.2.4)"));
    assert!(r.is_success());
    assert_eq!(r.warnings.len(), 2);
    assert_eq!(r.warnings[0].code, "");
    assert_eq!(r.warnings[1].code, "04");
    assert_eq!(r.warnings[1].object(), Some("C7"));
    assert_eq!(r.elapsed.as_deref(), Some("< 1 sec"));
}

#[test]
fn continuity_and_rdii() {
    let r = Report::parse(OK);
    let c = r.continuity();
    assert_eq!(c.runoff_quantity, Some(-0.142));
    assert_eq!(c.flow_routing, Some(-0.081));
    assert_eq!(c.groundwater, None);
    let rdii = r.rdii().unwrap();
    assert_eq!(rdii.value_headers, ["Volume (hectare-m)", "Volume (10^6 ltr)"]);
    assert_eq!(rdii.get("RDII Ratio").unwrap().number(0), Some(0.031));
    assert_eq!(r.block("Flow Routing Continuity").unwrap().get("RDII Inflow").unwrap().number(1), Some(0.1));
}

#[test]
fn generic_blocks() {
    let r = Report::parse(OK);
    assert_eq!(r.block("Highest Continuity Errors").unwrap().text(), ["Node 21 (28.25%)", "Node 20 (-1.08%)"]);
    let ts = r.block("Routing Time Step Summary").unwrap();
    assert_eq!(ts.get("Minimum Time Step").unwrap().values, ["37.57", "sec"]);
    assert_eq!(r.block("Node Surcharge Summary").unwrap().text(), ["No nodes were surcharged."]);
}

#[test]
fn tables() {
    let r = Report::parse(OK);
    let t = r.table("Node Depth Summary").unwrap();
    assert_eq!(t.rows.len(), 2);
    assert_eq!(t.columns.len(), 8);
    assert_eq!(t.columns[5], "days");
    assert_eq!(t.columns[6], "Time of Max Occurrence hr:min");
    assert_eq!(t.columns[0], "Node");
    assert_eq!(t.columns[3], "Maximum Depth Meters");
    assert_eq!(t.column("maximum depth"), Some(3));
    assert_eq!(t.column("reported max depth"), Some(7));
    assert_eq!(t.row("18").unwrap()[1], "OUTFALL");
    let o = r.table("Outfall Loading Summary").unwrap();
    assert_eq!(o.rows.len(), 1);
    assert_eq!(o.footer, vec![vec!["System", "84.66", "0.007", "0.053", "0.596"]]);
}

#[test]
fn input_errors() {
    let r = Report::parse(FAILED);
    assert!(!r.is_success());
    assert_eq!(r.errors.len(), 2);
    let e = &r.errors[0];
    assert_eq!((e.code.as_str(), e.line, e.section.as_deref()), ("209", Some(123), Some("CONDUIT")));
    assert_eq!(e.object(), Some("XX9"));
    assert!(e.context.as_deref().unwrap().starts_with("4                XX9"));
    assert_eq!(r.errors[1].code, "200");
    assert!(r.blocks.is_empty());
}
