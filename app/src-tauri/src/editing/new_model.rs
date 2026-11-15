//! A new, empty model with default options.

use std::path::Path;

use crate::session::Res;

/// Writes a new, empty model with default options.
pub fn create_model(path: &Path, flow_units: &str) -> Res<()> {
    let units =
        swmm_inp::FlowUnits::from_name(flow_units).ok_or_else(|| format!("unknown flow units {flow_units:?}"))?;
    let today = chrono::Local::now().format("%m/%d/%Y").to_string();
    let text = TEMPLATE.replace("{units}", units.name()).replace("{today}", &today).replace('\n', "\r\n");
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

const TEMPLATE: &str = "[TITLE]
;;Project Title/Notes

[OPTIONS]
;;Option             Value
FLOW_UNITS           {units}
INFILTRATION         HORTON
FLOW_ROUTING         DYNWAVE
LINK_OFFSETS         DEPTH
MIN_SLOPE            0
ALLOW_PONDING        NO
SKIP_STEADY_STATE    NO

START_DATE           {today}
START_TIME           00:00:00
REPORT_START_DATE    {today}
REPORT_START_TIME    00:00:00
END_DATE             {today}
END_TIME             06:00:00
SWEEP_START          01/01
SWEEP_END            12/31
DRY_DAYS             0
REPORT_STEP          00:05:00
WET_STEP             00:01:00
DRY_STEP             00:05:00
ROUTING_STEP         0:00:10
RULE_STEP            00:00:00

INERTIAL_DAMPING     PARTIAL
NORMAL_FLOW_LIMITED  BOTH
FORCE_MAIN_EQUATION  H-W
VARIABLE_STEP        0.75
LENGTHENING_STEP     0
MIN_SURFAREA         1.167
MAX_TRIALS           8
HEAD_TOLERANCE       0.0015
SYS_FLOW_TOL         5
LAT_FLOW_TOL         5
MINIMUM_STEP         0.5
THREADS              1

[EVAPORATION]
;;Data Source    Parameters
CONSTANT         0.0
DRY_ONLY         NO

[REPORT]
;;Reporting Options
SUBCATCHMENTS ALL
NODES ALL
LINKS ALL
";
