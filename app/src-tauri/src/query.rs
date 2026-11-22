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
//!
//! Bulk edits (`diameter = diameter * 1.2 where slope < 0.005`) also name the fields of
//! the objects by key (`n`, `off1`, `geom2`, `shape`…), see [`swmm_model::ops::field_key`].

use swmm_analysis::Stat;
use swmm_model::expr::{self, Column, Columns};
use swmm_model::{ops, LinkType, NodeType, ObjKind, ObjRef};

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

/// Names of a bulk edit: the fields of the objects by key (`n`, `off1`, `shape`…) and their
/// aliases (`diameter`, `roughness`…), then everything a query names.
struct EditColumns<'s> {
    query: SessionColumns<'s>,
}

impl Columns for EditColumns<'_> {
    fn column(&mut self, func: Option<&str>, name: &str) -> Result<Option<Column>, String> {
        let (s, kind) = (self.query.s, self.query.kind);
        // `id` and `type` are the object's name and type, as in queries.
        if func.is_none() && !["id", "type"].iter().any(|n| n.eq_ignore_ascii_case(name)) {
            if let Some(c) = ops::field_column(&s.inp, &s.net, kind, &ops::field_key(kind, name)) {
                return Ok(Some(c));
            }
        }
        self.query.column(func, name)
    }
}

/// The values a bulk edit writes.
pub struct BulkPlan {
    pub kind: ObjKind,
    /// The name set, as written, and its field key.
    pub target: String,
    pub key: String,
    /// `(id, value)` of the objects that change.
    pub values: Vec<(String, String)>,
    /// Objects of the selection.
    pub objects: usize,
    /// Objects left out by `where`.
    pub filtered: usize,
    /// Objects for which the value cannot be computed (a value they do not have, a division by zero).
    pub missing: usize,
}

impl Session {
    /// What `target = value [where condition]` writes on the objects (all of one kind);
    /// result variables are read at `period`.
    pub fn bulk_plan(&self, objects: &[ObjRef], statement: &str, period: Option<usize>) -> Res<BulkPlan> {
        let kind = objects.first().ok_or("select the objects to edit first")?.kind;
        if objects.iter().any(|o| o.kind != kind) {
            return Err("the objects to edit must all be of one kind".into());
        }
        let n = self.net.len(kind);
        let indices: Vec<usize> = objects.iter().map(|o| o.index as usize).filter(|&i| i < n).collect();
        let ids: Vec<String> =
            indices.iter().map(|&i| self.net.id(ObjRef { kind, index: i as u32 }).to_string()).collect();

        let a = expr::parse_assignment(statement).map_err(|e| e.to_string())?;
        let key = ops::field_key(kind, &a.target);
        let keys = ops::field_keys(&self.inp, kind, &ids);
        if !keys.contains(&key.as_str()) {
            let what = if key == "id" {
                "rename an object to change its name".to_string()
            } else {
                format!("the selected {}s have no field {}; they have: {}", kind.name(), a.target, keys.join(", "))
            };
            return Err(what);
        }

        let mut cols = EditColumns { query: SessionColumns { s: self, kind, period } };
        // A text (`'CIRCULAR'`, or a bare word that names no value: `shape = CIRCULAR`) is
        // written as it is.
        let text = match &a.value {
            expr::Expr::Text(t) => Some(t.clone()),
            expr::Expr::Name(w) if cols.column(None, w)?.is_none() => Some(w.clone()),
            _ => None,
        };
        let program = match &text {
            Some(_) => None,
            None => {
                let p = expr::compile(&a.value, &mut cols, n).map_err(|e| e.to_string())?;
                if p.ty() != expr::Type::Num {
                    return Err(format!(
                        "the new value of {} must be a number (like {} * 1.2) or a text",
                        a.target, a.target
                    ));
                }
                Some(p)
            }
        };
        let filter = match &a.filter {
            Some(f) => {
                let p = expr::compile(f, &mut cols, n).map_err(|e| e.to_string())?;
                if p.ty() != expr::Type::Bool {
                    return Err("where takes a condition, like slope < 0.005".into());
                }
                Some(p)
            }
            None => None,
        };

        let mut plan = BulkPlan {
            kind,
            target: a.target.clone(),
            key,
            values: Vec::new(),
            objects: indices.len(),
            filtered: 0,
            missing: 0,
        };
        for (&i, id) in indices.iter().zip(ids) {
            if filter.as_ref().is_some_and(|f| !f.matches(i)) {
                plan.filtered += 1;
                continue;
            }
            let value = match (&text, &program) {
                (Some(t), _) => t.clone(),
                (None, Some(p)) => match p.value(i) {
                    x if x.is_finite() => ops::format_number(x),
                    _ => {
                        plan.missing += 1;
                        continue;
                    }
                },
                (None, None) => unreachable!("a text or a program"),
            };
            plan.values.push((id, value));
        }
        Ok(plan)
    }

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

    #[test]
    fn bulk_expressions() {
        use crate::editing::EditRequest;
        let (_d, mut s) = session(TINY);
        let links: Vec<ObjRef> = (0..3).map(|index| ObjRef { kind: ObjKind::Link, index }).collect();
        let run = |s: &mut Session, objects: &[ObjRef], statement: &str| {
            let req =
                EditRequest::BulkExpression { objects: objects.to_vec(), statement: statement.into(), period: None };
            s.edit(req, objects)
        };
        let text = |s: &Session| s.inp.to_string_lossy();
        // Slopes: C1 0.0067, C2 0.0047, C3 0.0078.
        let o = run(&mut s, &links, "diameter = diameter * 1.2 where slope < 0.005").unwrap();
        assert_eq!(o.message.as_deref(), Some("1 of 3 links changed; 2 not matching where"));
        assert_eq!(o.label, "Set diameter on 1 links");
        assert!(text(&s).contains("C2               CIRCULAR     0.6 "), "{}", text(&s));
        assert!(text(&s).contains("C1               CIRCULAR     0.4 "));
        // Fields by key, a text, a condition on a field of another section.
        let o = run(&mut s, &links, "n = n + 0.002 where shape = circular and geom1 >= 0.6").unwrap();
        assert_eq!(o.message.as_deref(), Some("2 of 3 links changed; 1 not matching where"));
        assert!(
            text(&s).contains("C3               J3               Out1             90         0.015 "),
            "{}",
            text(&s)
        );
        run(&mut s, &links[..1], "shape = RECT_CLOSED").unwrap();
        assert!(text(&s).contains("C1               RECT_CLOSED "));
        let o = run(&mut s, &links[1..], "barrels = 1").unwrap();
        assert_eq!(o.message.as_deref(), Some("0 of 2 links changed; 2 already at that value"));

        // Undone as one edit each.
        for _ in 0..3 {
            s.undo(&links).unwrap();
        }
        assert_eq!(text(&s), TINY);

        let nodes = [ObjRef { kind: ObjKind::Node, index: 0 }];
        let err = |s: &mut Session, objects: &[ObjRef], q: &str| {
            let req = EditRequest::BulkExpression { objects: objects.to_vec(), statement: q.into(), period: None };
            match s.edit(req, objects) {
                Ok(_) => panic!("{q} should fail"),
                Err(e) => e,
            }
        };
        assert!(err(&mut s, &links, "diametre = 1").contains("no field diametre"));
        assert!(err(&mut s, &links, "diameter = 0 - 1").starts_with("C1:"));
        assert!(err(&mut s, &links, "diameter = slope > 1").contains("must be a number"));
        assert!(err(&mut s, &links, "diameter = 1 where length").contains("condition"));
        assert!(err(&mut s, &links, "id = X").contains("rename"));
        assert!(err(&mut s, &[], "diameter = 1").contains("select"));
        assert!(err(&mut s, &[links[0], nodes[0]], "diameter = 1").contains("one kind"));
        let o = run(&mut s, &nodes, "max_depth = max_depth / 0").unwrap();
        assert_eq!(o.message.as_deref(), Some("0 of 1 nodes changed; 1 without a value to compute"));
        run(&mut s, &nodes, "invert_elevation = invert_elevation - 0.25").unwrap();
        assert!(text(&s).contains("J1               99.75 "));
        assert_eq!(text(&s).matches("99.75").count(), 1);
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
