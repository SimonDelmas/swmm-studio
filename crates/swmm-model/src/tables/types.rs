//! The tables as the editors see them: values kept as text.

use serde::{Deserialize, Serialize};

use crate::schema::{table_fields, RefKind};

/// Default values of the parameters of an aquifer or of a snow pack surface.
pub(crate) fn defaults(kind: RefKind, surface: &str) -> Vec<String> {
    table_fields(kind, surface).iter().map(|d| d.default.to_string()).collect()
}

pub const CURVE_TYPES: &[&str] = &[
    "STORAGE",
    "SHAPE",
    "DIVERSION",
    "TIDAL",
    "PUMP1",
    "PUMP2",
    "PUMP3",
    "PUMP4",
    "PUMP5",
    "RATING",
    "CONTROL",
    "WEIR",
];
pub const PATTERN_TYPES: &[&str] = &["MONTHLY", "DAILY", "HOURLY", "WEEKEND"];
pub const MONTHS: &[&str] =
    &["All", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
pub const RESPONSES: &[&str] = &["Short", "Medium", "Long"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Curve {
    pub name: String,
    /// `STORAGE`, `SHAPE`, `PUMP1`…
    pub curve_type: String,
    pub points: Vec<[String; 2]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TsRow {
    /// Empty: same date as the previous row (or no dates at all).
    pub date: String,
    pub time: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Timeseries {
    pub name: String,
    /// External data file (`TS FILE path`); `rows` is then empty.
    pub file: Option<String>,
    pub rows: Vec<TsRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pattern {
    pub name: String,
    pub pattern_type: String,
    pub factors: Vec<String>,
}

/// One triangular unit hydrograph of an RDII group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UhRow {
    /// `All` or a month abbreviation.
    pub month: String,
    /// `Short`, `Medium` or `Long`.
    pub response: String,
    pub r: String,
    pub t: String,
    pub k: String,
    /// Initial abstraction: max depth, recovery rate, initial depth (optional, may be empty).
    pub dmax: String,
    pub drecov: String,
    pub dinit: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hydrograph {
    pub name: String,
    pub gage: String,
    pub rows: Vec<UhRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transect {
    pub name: String,
    pub n_left: String,
    pub n_right: String,
    pub n_channel: String,
    pub x_left: String,
    pub x_right: String,
    /// Meander modifier.
    pub lfactor: String,
    /// Stations scale factor.
    pub wfactor: String,
    /// Elevation offset.
    pub eoffset: String,
    /// `[station, elevation]`.
    pub points: Vec<[String; 2]>,
}

/// An aquifer (`[AQUIFERS]`): its twelve parameters in file order (porosity, wilting
/// point, field capacity, conductivity, conductivity slope, tension slope, upper
/// evaporation fraction, lower evaporation depth, loss rate, bottom elevation, water
/// table elevation, unsaturated zone moisture) and an optional evaporation pattern.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Aquifer {
    pub name: String,
    pub values: Vec<String>,
    pub pattern: String,
}

/// A snow pack (`[SNOWPACKS]`): the seven parameters of each surface (melt coefficients,
/// base temperature, free water capacity, initial depths, then the plowable fraction or
/// the depth for full cover), and the snow removal parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snowpack {
    pub name: String,
    pub plowable: Vec<String>,
    pub impervious: Vec<String>,
    pub pervious: Vec<String>,
    /// Depth at which removal begins, then the fractions moved out of the watershed, to the
    /// impervious area, to the pervious area, converted to melt, moved to a subcatchment.
    pub removal: Vec<String>,
    /// Subcatchment receiving plowed snow (may be empty).
    pub subcatchment: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Table {
    Curve(Curve),
    Timeseries(Timeseries),
    Pattern(Pattern),
    Hydrograph(Hydrograph),
    Transect(Transect),
    Aquifer(Aquifer),
    Snowpack(Snowpack),
}

impl Table {
    pub fn name(&self) -> &str {
        match self {
            Table::Curve(c) => &c.name,
            Table::Timeseries(t) => &t.name,
            Table::Pattern(p) => &p.name,
            Table::Hydrograph(h) => &h.name,
            Table::Transect(t) => &t.name,
            Table::Aquifer(a) => &a.name,
            Table::Snowpack(s) => &s.name,
        }
    }

    pub fn ref_kind(&self) -> RefKind {
        match self {
            Table::Curve(_) => RefKind::Curve,
            Table::Timeseries(_) => RefKind::Timeseries,
            Table::Pattern(_) => RefKind::Pattern,
            Table::Hydrograph(_) => RefKind::Hydrograph,
            Table::Transect(_) => RefKind::Transect,
            Table::Aquifer(_) => RefKind::Aquifer,
            Table::Snowpack(_) => RefKind::Snowpack,
        }
    }

    /// An empty object of a kind.
    pub fn empty(kind: RefKind, name: &str) -> Option<Table> {
        let n = name.to_string();
        Some(match kind {
            RefKind::Curve => Table::Curve(Curve { name: n, curve_type: "STORAGE".into(), points: Vec::new() }),
            RefKind::Timeseries => Table::Timeseries(Timeseries { name: n, file: None, rows: Vec::new() }),
            RefKind::Pattern => {
                Table::Pattern(Pattern { name: n, pattern_type: "HOURLY".into(), factors: vec!["1.0".to_string(); 24] })
            }
            RefKind::Hydrograph => Table::Hydrograph(Hydrograph {
                name: n,
                gage: "*".into(),
                rows: RESPONSES
                    .iter()
                    .map(|r| UhRow {
                        month: "All".into(),
                        response: r.to_string(),
                        r: "0".into(),
                        t: "1".into(),
                        k: "2".into(),
                        dmax: String::new(),
                        drecov: String::new(),
                        dinit: String::new(),
                    })
                    .collect(),
            }),
            RefKind::Transect => Table::Transect(Transect {
                name: n,
                n_left: "0.03".into(),
                n_right: "0.03".into(),
                n_channel: "0.03".into(),
                x_left: "0".into(),
                x_right: "0".into(),
                lfactor: "0".into(),
                wfactor: "0".into(),
                eoffset: "0".into(),
                points: Vec::new(),
            }),
            RefKind::Aquifer => Table::Aquifer(Aquifer {
                name: n,
                values: defaults(RefKind::Aquifer, "").into_iter().take(12).collect(),
                pattern: String::new(),
            }),
            RefKind::Snowpack => Table::Snowpack(Snowpack {
                name: n,
                plowable: defaults(RefKind::Snowpack, "PLOWABLE"),
                impervious: defaults(RefKind::Snowpack, "IMPERVIOUS"),
                pervious: defaults(RefKind::Snowpack, "PERVIOUS"),
                removal: defaults(RefKind::Snowpack, "REMOVAL").into_iter().take(6).collect(),
                subcatchment: String::new(),
            }),
            _ => return None,
        })
    }
}
