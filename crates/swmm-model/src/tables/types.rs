//! The tables as the editors see them: values kept as text.

use serde::{Deserialize, Serialize};

use crate::schema::RefKind;

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Table {
    Curve(Curve),
    Timeseries(Timeseries),
    Pattern(Pattern),
    Hydrograph(Hydrograph),
    Transect(Transect),
}

impl Table {
    pub fn name(&self) -> &str {
        match self {
            Table::Curve(c) => &c.name,
            Table::Timeseries(t) => &t.name,
            Table::Pattern(p) => &p.name,
            Table::Hydrograph(h) => &h.name,
            Table::Transect(t) => &t.name,
        }
    }

    pub fn ref_kind(&self) -> RefKind {
        match self {
            Table::Curve(_) => RefKind::Curve,
            Table::Timeseries(_) => RefKind::Timeseries,
            Table::Pattern(_) => RefKind::Pattern,
            Table::Hydrograph(_) => RefKind::Hydrograph,
            Table::Transect(_) => RefKind::Transect,
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
            _ => return None,
        })
    }
}
