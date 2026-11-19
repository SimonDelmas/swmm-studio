//! Selection by attribute query on a [`Session`]: `diameter < 0.3`, `type = outfall`,
//! `max(flow) > 2`. The expression ([`swmm_model::expr`]) names the values of the objects
//! of one layer:
//!
//! - `id`, `type`;
//! - the numeric attributes of the layer ([`swmm_model::attribute_names`]), and `diameter`
//!   for `geom1` (the diameter or height of a link's cross-section);
//! - a result variable of the loaded results (`flow`, `depth`…) at the current period;
//! - a statistic of a result variable over the whole run: `max(flow)`, `min(…)`, `mean(…)`,
//!   `total(…)`.

use swmm_analysis::Stat;
use swmm_model::expr::{self, Column, Columns};
use swmm_model::{LinkType, NodeType, ObjKind};

use crate::session::{element, Res, Session};

/// Statistics a query can take of a result variable.
pub const STATS: [&str; 4] = ["max", "min", "mean", "total"];

fn type_name(s: &Session, kind: ObjKind, i: usize) -> &'static str {
    match kind {
        ObjKind::Node => match s.net.nodes[i].kind {
            NodeType::Junction => "junction",
            NodeType::Outfall => "outfall",
            NodeType::Divider => "divider",
            NodeType::Storage => "storage",
        },
        ObjKind::Link => match s.net.links[i].kind {
            LinkType::Conduit => "conduit",
            LinkType::Pump => "pump",
            LinkType::Orifice => "orifice",
            LinkType::Weir => "weir",
            LinkType::Outlet => "outlet",
        },
        ObjKind::Subcatchment => "subcatchment",
        ObjKind::Gage => "gage",
    }
}

struct SessionColumns<'s> {
    s: &'s Session,
    kind: ObjKind,
    period: Option<usize>,
}

impl SessionColumns<'_> {
    /// Index of a result variable of the layer, if results are loaded and have it.
    fn variable(&self, name: &str) -> Option<usize> {
        let ek = element(self.kind)?;
        self.s.results.as_ref()?.results.meta().var_index(ek, name)
    }
}

impl Columns for SessionColumns<'_> {
    fn column(&mut self, func: Option<&str>, name: &str) -> Result<Option<Column>, String> {
        let (s, kind) = (self.s, self.kind);
        let n = s.net.len(kind);
        let lower = name.to_ascii_lowercase();
        let Some(func) = func else {
            match lower.as_str() {
                "id" => return Ok(Some(Column::Text(s.ids(kind).into_iter().map(str::to_string).collect()))),
                "type" => {
                    return Ok(Some(Column::Text((0..n).map(|i| type_name(s, kind, i).to_string()).collect())));
                }
                _ => {}
            }
            let attr = if lower == "diameter" && kind == ObjKind::Link { "geom1" } else { lower.as_str() };
            if swmm_model::attribute_names(kind).contains(&attr) {
                return s.attribute(kind, attr).map(|v| Some(Column::Num(v)));
            }
            let (Some(var), Some(ek)) = (self.variable(name), element(kind)) else { return Ok(None) };
            let period = self.period.ok_or_else(|| format!("{name} is a result: choose a time step first"))?;
            return s.frame(ek, var, period).map(|v| Some(Column::Num(v)));
        };
        let stat = match func.to_ascii_lowercase().as_str() {
            "max" => Stat::Max,
            "min" => Stat::Min,
            "mean" => Stat::Mean,
            "total" => Stat::Total,
            _ => return Err(format!("unknown statistic {func}: use {}", STATS.join(", "))),
        };
        let ek = element(kind).ok_or_else(|| format!("{}s have no results", kind.name()))?;
        if s.results.is_none() {
            return Err(format!("{func}({name}) needs results: none are loaded"));
        }
        let var = self.variable(name).ok_or_else(|| format!("the results have no {name} for {}s", kind.name()))?;
        s.stat_values(ek, var, stat, 0, usize::MAX, false).map(|v| Some(Column::Num(v)))
    }
}

impl Session {
    /// Objects of a layer matching a query; `period` is the time step result variables are
    /// read at.
    pub fn select_query(&self, kind: ObjKind, query: &str, period: Option<usize>) -> Res<Vec<u32>> {
        let e = expr::parse(query).map_err(|e| e.to_string())?;
        let mut cols = SessionColumns { s: self, kind, period };
        let program = expr::compile(&e, &mut cols, self.net.len(kind)).map_err(|e| e.to_string())?;
        program.select().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::Write;
    use std::time::Instant;

    use swmm_model::ObjRef;

    use super::*;

    const TINY: &str = include_str!("../../../testdata/tiny.inp");

    fn session(src: &str) -> (tempfile::TempDir, Session) {
        let dir = tempfile::tempdir().unwrap();
        let inp = dir.path().join("m.inp");
        std::fs::write(&inp, src).unwrap();
        let s = Session::open(&inp).unwrap();
        (dir, s)
    }

    #[test]
    fn queries() {
        let (_d, s) = session(TINY);
        let ids = |kind, q: &str| -> Vec<String> {
            s.select_query(kind, q, None)
                .unwrap()
                .iter()
                .map(|&i| s.net.id(ObjRef { kind, index: i }).to_string())
                .collect()
        };
        assert_eq!(ids(ObjKind::Node, "type = outfall"), vec!["Out1"]);
        assert_eq!(ids(ObjKind::Node, "type = junction and id != 'J1'"), vec!["J2", "J3"]);
        assert!(!ids(ObjKind::Link, "diameter > 0").is_empty());
        assert_eq!(ids(ObjKind::Link, "diameter > 0"), ids(ObjKind::Link, "geom1 > 0"));
        let err = s.select_query(ObjKind::Link, "max(flow) > 1", None).unwrap_err();
        assert!(err.contains("needs results"), "{err}");
        let err = s.select_query(ObjKind::Link, "flow > 1", None).unwrap_err();
        assert!(err.contains("unknown name"), "{err}");
    }

    /// A model of `n` conduits in a line, every tenth one of diameter 0.2.
    fn big_model(n: usize) -> String {
        let mut s = String::from("[JUNCTIONS]\n");
        for i in 0..=n {
            writeln!(s, "J{i} {} 2", 100.0 - i as f64 * 0.01).unwrap();
        }
        s.push_str("[CONDUITS]\n");
        for i in 0..n {
            writeln!(s, "C{i} J{i} J{} 50 0.013", i + 1).unwrap();
        }
        s.push_str("[XSECTIONS]\n");
        for i in 0..n {
            writeln!(s, "C{i} CIRCULAR {} 0 0 0", if i % 10 == 0 { 0.2 } else { 0.5 }).unwrap();
        }
        s
    }

    /// The target of the issue: `diameter < 0.3` on 100k conduits in under 100 ms
    /// (release build; a debug build is several times slower, so only correctness is
    /// asserted here and the time printed).
    #[test]
    fn large_model() {
        let n = 100_000;
        let (_d, s) = session(&big_model(n));
        let t = Instant::now();
        let hits = s.select_query(ObjKind::Link, "diameter < 0.3", None).unwrap();
        eprintln!("diameter < 0.3 on {n} conduits: {:?}", t.elapsed());
        assert_eq!(hits.len(), n / 10);
        assert!(hits.iter().all(|i| i % 10 == 0));
    }
}
