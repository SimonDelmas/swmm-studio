//! Constants and variable catalogue of the SWMM binary output format (`output.c`).

use chrono::{NaiveDate, NaiveDateTime, TimeDelta};

pub const MAGIC: i32 = 516_114_522;
/// Magic, version, flow units, #subcatchments, #nodes, #links, #pollutants.
pub const HEADER_BYTES: u64 = 7 * 4;
/// ID position, input position, output position, #periods, error code, magic.
pub const EPILOGUE_BYTES: u64 = 6 * 4;

/// Object category of a result series.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ElementKind {
    Subcatchment,
    Node,
    Link,
    System,
}

impl ElementKind {
    pub const ALL: [ElementKind; 4] =
        [ElementKind::Subcatchment, ElementKind::Node, ElementKind::Link, ElementKind::System];

    pub fn name(self) -> &'static str {
        match self {
            ElementKind::Subcatchment => "subcatchment",
            ElementKind::Node => "node",
            ElementKind::Link => "link",
            ElementKind::System => "system",
        }
    }

    pub fn from_name(s: &str) -> Option<ElementKind> {
        Some(match s.to_ascii_lowercase().as_str() {
            "subcatchment" | "subcatch" | "sub" => ElementKind::Subcatchment,
            "node" => ElementKind::Node,
            "link" => ElementKind::Link,
            "system" | "sys" => ElementKind::System,
            _ => return None,
        })
    }

    /// Names of the fixed (non-pollutant) variables, in file order.
    pub fn base_variables(self) -> &'static [&'static str] {
        match self {
            ElementKind::Subcatchment => &[
                "rainfall",
                "snow_depth",
                "evaporation",
                "infiltration",
                "runoff",
                "gw_outflow",
                "gw_elevation",
                "soil_moisture",
            ],
            ElementKind::Node => &["depth", "head", "volume", "lateral_inflow", "total_inflow", "flooding"],
            ElementKind::Link => &["flow", "depth", "velocity", "volume", "capacity"],
            ElementKind::System => &[
                "air_temperature",
                "rainfall",
                "snow_depth",
                "infiltration",
                "runoff",
                "dry_weather_inflow",
                "groundwater_inflow",
                "rdii_inflow",
                "external_inflow",
                "total_lateral_inflow",
                "flooding",
                "outflow",
                "storage",
                "evaporation",
                "potential_evaporation",
            ],
        }
    }
}

/// `FLOW_UNITS` code stored in the file header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowUnits {
    Cfs,
    Gpm,
    Mgd,
    Cms,
    Lps,
    Mld,
}

impl FlowUnits {
    pub fn from_code(code: i32) -> Option<FlowUnits> {
        Some(match code {
            0 => FlowUnits::Cfs,
            1 => FlowUnits::Gpm,
            2 => FlowUnits::Mgd,
            3 => FlowUnits::Cms,
            4 => FlowUnits::Lps,
            5 => FlowUnits::Mld,
            _ => return None,
        })
    }

    pub fn code(self) -> i32 {
        self as i32
    }

    pub fn name(self) -> &'static str {
        ["CFS", "GPM", "MGD", "CMS", "LPS", "MLD"][self as usize]
    }

    pub fn is_metric(self) -> bool {
        self as i32 >= 3
    }
}

/// Unit label of a variable (as SWMM reports it).
pub fn unit(kind: ElementKind, var: usize, flow: FlowUnits) -> &'static str {
    let si = flow.is_metric();
    let pick = |us: &'static str, metric: &'static str| if si { metric } else { us };
    let base = kind.base_variables().len();
    if var >= base {
        return if kind == ElementKind::Subcatchment { "mass/time" } else { "concentration" };
    }
    match (kind, var) {
        (ElementKind::Subcatchment, 0) | (ElementKind::System, 1) => pick("in/hr", "mm/hr"),
        (ElementKind::Subcatchment, 1) | (ElementKind::System, 2) => pick("in", "mm"),
        (ElementKind::Subcatchment, 3) | (ElementKind::System, 3) => pick("in/hr", "mm/hr"),
        (ElementKind::Subcatchment, 2) | (ElementKind::System, 13 | 14) => pick("in/day", "mm/day"),
        (ElementKind::Subcatchment, 6) | (ElementKind::Node, 0 | 1) | (ElementKind::Link, 1) => pick("ft", "m"),
        (ElementKind::Subcatchment, 7) | (ElementKind::Link, 4) => "fraction",
        (ElementKind::Node, 2) | (ElementKind::Link, 3) | (ElementKind::System, 12) => pick("ft3", "m3"),
        (ElementKind::Link, 2) => pick("ft/s", "m/s"),
        (ElementKind::System, 0) => pick("degF", "degC"),
        _ => flow.name(),
    }
}

/// Node type code from the input properties block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeType {
    Junction,
    Outfall,
    Storage,
    Divider,
    Other(i32),
}

impl NodeType {
    pub fn from_code(c: i32) -> NodeType {
        match c {
            0 => NodeType::Junction,
            1 => NodeType::Outfall,
            2 => NodeType::Storage,
            3 => NodeType::Divider,
            x => NodeType::Other(x),
        }
    }

    pub fn code(self) -> i32 {
        match self {
            NodeType::Junction => 0,
            NodeType::Outfall => 1,
            NodeType::Storage => 2,
            NodeType::Divider => 3,
            NodeType::Other(x) => x,
        }
    }
}

/// Link type code from the input properties block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkType {
    Conduit,
    Pump,
    Orifice,
    Weir,
    Outlet,
    Other(i32),
}

impl LinkType {
    pub fn from_code(c: i32) -> LinkType {
        match c {
            0 => LinkType::Conduit,
            1 => LinkType::Pump,
            2 => LinkType::Orifice,
            3 => LinkType::Weir,
            4 => LinkType::Outlet,
            x => LinkType::Other(x),
        }
    }

    pub fn code(self) -> i32 {
        match self {
            LinkType::Conduit => 0,
            LinkType::Pump => 1,
            LinkType::Orifice => 2,
            LinkType::Weir => 3,
            LinkType::Outlet => 4,
            LinkType::Other(x) => x,
        }
    }
}

/// SWMM encodes dates as days since 1899-12-30 (same epoch as Excel).
fn epoch() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(1899, 12, 30).unwrap().and_hms_opt(0, 0, 0).unwrap()
}

/// Converts a SWMM date (fractional days) to a date-time rounded to the second.
pub fn to_datetime(days: f64) -> NaiveDateTime {
    epoch() + TimeDelta::seconds((days * 86_400.0).round() as i64)
}

pub fn from_datetime(dt: NaiveDateTime) -> f64 {
    (dt - epoch()).num_milliseconds() as f64 / 86_400_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_epoch() {
        let d = NaiveDate::from_ymd_opt(1998, 1, 1).unwrap().and_hms_opt(4, 5, 0).unwrap();
        assert_eq!(to_datetime(from_datetime(d)), d);
        assert_eq!(from_datetime(NaiveDate::from_ymd_opt(1900, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap()), 2.0);
    }

    #[test]
    fn units() {
        assert_eq!(unit(ElementKind::Link, 0, FlowUnits::Cms), "CMS");
        assert_eq!(unit(ElementKind::Node, 0, FlowUnits::Cfs), "ft");
        assert_eq!(unit(ElementKind::Subcatchment, 0, FlowUnits::Lps), "mm/hr");
        assert_eq!(unit(ElementKind::Node, 6, FlowUnits::Lps), "concentration");
    }
}
