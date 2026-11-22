//! Bulk edits with expressions: one field of many objects, read and written by the field's
//! key (`geom1`, `n`, `elev`…) wherever the object keeps it (its own section, or
//! `[XSECTIONS]`, `[LOSSES]`, `[SUBAREAS]`, `[INFILTRATION]`).

use std::collections::HashMap;

use swmm_inp::{InpFile, SectionKind};

use super::fields::{line_index, set_field_at};
use crate::edit::{EditResult, Tx};
use crate::expr::Column;
use crate::schema::{self, Context, FieldDef, FieldType};
use crate::{Network, ObjKind, ObjRef};

const NODE_SECTIONS: &[SectionKind] =
    &[SectionKind::Junctions, SectionKind::Outfalls, SectionKind::Dividers, SectionKind::Storage];
const LINK_SECTIONS: &[SectionKind] = &[
    SectionKind::Conduits,
    SectionKind::Pumps,
    SectionKind::Orifices,
    SectionKind::Weirs,
    SectionKind::Outlets,
    SectionKind::Xsections,
    SectionKind::Losses,
];
const SUBCATCHMENT_SECTIONS: &[SectionKind] =
    &[SectionKind::Subcatchments, SectionKind::Subareas, SectionKind::Infiltration];
const GAGE_SECTIONS: &[SectionKind] = &[SectionKind::Raingages];

/// Sections holding the fields of a kind of object, the defining sections first.
pub fn field_sections(kind: ObjKind) -> &'static [SectionKind] {
    match kind {
        ObjKind::Node => NODE_SECTIONS,
        ObjKind::Link => LINK_SECTIONS,
        ObjKind::Subcatchment => SUBCATCHMENT_SECTIONS,
        ObjKind::Gage => GAGE_SECTIONS,
    }
}

/// Key of the field a name stands for: the field keys themselves, and the attribute names
/// of thematic maps and queries (`diameter`, `roughness`, `invert_elevation`…).
pub fn field_key(kind: ObjKind, name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    let key = match (kind, lower.as_str()) {
        (ObjKind::Node, "invert_elevation" | "invert" | "elevation") => "elev",
        (ObjKind::Node, "max_depth") => "ymax",
        (ObjKind::Link, "diameter" | "height") => "geom1",
        (ObjKind::Link, "roughness") => "n",
        (ObjKind::Subcatchment, "imperviousness") => "imperv",
        _ => return lower,
    };
    key.to_string()
}

/// Where an object keeps a field.
struct Located {
    section: SectionKind,
    at: (usize, usize),
    field: usize,
    def: FieldDef,
    /// Current token (`None`: omitted at the end of the line).
    token: Option<String>,
}

/// First line of each object of a section: upper-case ID → `(section, line)`.
type LineIndex = HashMap<String, (usize, usize)>;

/// The lines of the objects of a kind, by upper-case ID, in each of their sections.
struct Lines<'a> {
    inp: &'a InpFile,
    ctx: Context,
    sections: Vec<(SectionKind, LineIndex)>,
}

impl<'a> Lines<'a> {
    fn new(inp: &'a InpFile, kind: ObjKind) -> Lines<'a> {
        let sections = field_sections(kind).iter().map(|s| (s.clone(), line_index(inp, s))).collect();
        Lines { inp, ctx: Context::of(inp), sections }
    }

    /// Fields of each line of object `id`.
    fn layouts(&self, id: &str) -> impl Iterator<Item = (&SectionKind, (usize, usize), Vec<String>, Vec<FieldDef>)> {
        let upper = id.to_ascii_uppercase();
        self.sections.iter().filter_map(move |(kind, index)| {
            let at = *index.get(&upper)?;
            let tokens = self.inp.sections()[at.0].lines()[at.1].to_vec();
            let t: Vec<&str> = tokens.iter().map(String::as_str).collect();
            let defs = schema::layout(kind, &t, &self.ctx)?;
            Some((kind, at, tokens, defs))
        })
    }

    fn locate(&self, id: &str, key: &str) -> Option<Located> {
        self.layouts(id).find_map(|(section, at, tokens, defs)| {
            let field = defs.iter().position(|d| d.key == key)?;
            Some(Located {
                section: section.clone(),
                at,
                field,
                token: tokens.get(field).cloned(),
                def: defs.into_iter().nth(field).expect("found above"),
            })
        })
    }
}

/// Keys of the fields the objects have (but their names), in order of first appearance.
pub fn field_keys(inp: &InpFile, kind: ObjKind, ids: &[String]) -> Vec<&'static str> {
    let lines = Lines::new(inp, kind);
    let mut out: Vec<&'static str> = Vec::new();
    for id in ids {
        for (_, _, _, defs) in lines.layouts(id) {
            for d in defs.iter().filter(|d| d.ty != FieldType::Id && d.key != "id") {
                if !out.contains(&d.key) {
                    out.push(d.key);
                }
            }
        }
    }
    out
}

/// Values of a field (by key) for every object of a kind: numbers for a numeric field
/// (NaN where the object has none), texts otherwise. `None` when no object has the field.
pub fn field_column(inp: &InpFile, net: &Network, kind: ObjKind, key: &str) -> Option<Column> {
    let lines = Lines::new(inp, kind);
    let n = net.len(kind);
    let found: Vec<Option<Located>> =
        (0..n).map(|i| lines.locate(net.id(ObjRef { kind, index: i as u32 }), key)).collect();
    let first = found.iter().flatten().next()?;
    // An omitted optional field has its default value.
    let text = |l: &Located| l.token.clone().unwrap_or_else(|| l.def.default.to_string());
    Some(if first.def.ty == FieldType::Real {
        Column::Num(
            found.iter().map(|l| l.as_ref().and_then(|l| text(l).parse::<f32>().ok()).unwrap_or(f32::NAN)).collect(),
        )
    } else {
        Column::Text(found.iter().map(|l| l.as_ref().map(text).unwrap_or_default()).collect())
    })
}

/// What [`set_field_values`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BulkCount {
    pub changed: usize,
    /// Objects whose field already had the value.
    pub unchanged: usize,
    /// Objects without the field (e.g. a pump has no cross-section).
    pub without_field: usize,
}

/// Same value: equal numbers, or equal texts ignoring case.
fn same(a: &str, b: &str) -> bool {
    match (a.parse::<f64>(), b.parse::<f64>()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.eq_ignore_ascii_case(b),
    }
}

/// Sets a field (by key) of many objects, each to its own value: `(id, value)`. Values are
/// checked as in the property panel; the first invalid one fails the whole edit.
pub fn set_field_values(tx: &mut Tx, kind: ObjKind, key: &str, values: &[(String, String)]) -> EditResult<BulkCount> {
    let mut count = BulkCount::default();
    let mut todo = Vec::new();
    {
        let lines = Lines::new(tx.inp(), kind);
        for (id, value) in values {
            let Some(l) = lines.locate(id, key) else {
                count.without_field += 1;
                continue;
            };
            if l.field == 0 {
                return Err("an object's name is changed by renaming it".into());
            }
            let value = schema::validate(&l.def, value).map_err(|e| format!("{id}: {e}"))?;
            let old = l.token.clone().unwrap_or_else(|| l.def.default.to_string());
            if same(&old, &value) {
                count.unchanged += 1;
            } else {
                todo.push((id, l, value));
            }
        }
    }
    for (id, l, value) in todo {
        set_field_at(tx, &l.section, l.at, l.field, &value).map_err(|e| format!("{id}: {e}"))?;
        count.changed += 1;
    }
    Ok(count)
}

/// A computed number as written to the file: rounded to the precision values are read
/// with (7 significant digits, so `0.013 + 0.002` is `0.015`), without trailing zeros.
pub fn format_number(x: f64) -> String {
    let rounded: f64 = format!("{x:.6e}").parse().unwrap_or(x);
    if rounded == 0.0 {
        return "0".into();
    }
    format!("{rounded}")
}
