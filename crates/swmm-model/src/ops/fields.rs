//! Fields and lines of the sections: set a field (on one line or many), add or remove an optional line.

use std::collections::HashMap;

use swmm_inp::{InpFile, SectionKind};

use crate::edit::{EditResult, Tx};
use crate::schema::{self, Context};

/// First data line of a section kind whose first tokens equal `key` (case-insensitive):
/// `(section index, line index)`.
pub fn find_line(inp: &InpFile, kind: &SectionKind, key: &[&str]) -> Option<(usize, usize)> {
    inp.sections().iter().enumerate().filter(|(_, s)| s.kind() == kind).find_map(|(si, s)| {
        s.data()
            .find(|(_, l)| key.iter().enumerate().all(|(i, k)| l.token(i).is_some_and(|t| t.eq_ignore_ascii_case(k))))
            .map(|(li, _)| (si, li))
    })
}

/// Index of the first line of each object of a section kind: upper-case first token →
/// `(section, line)`.
pub(super) fn line_index(inp: &InpFile, kind: &SectionKind) -> HashMap<String, (usize, usize)> {
    let mut m = HashMap::new();
    for (si, s) in inp.sections().iter().enumerate().filter(|(_, s)| s.kind() == kind) {
        for (li, l) in s.data() {
            if let Some(t) = l.token(0) {
                m.entry(t.to_ascii_uppercase()).or_insert((si, li));
            }
        }
    }
    m
}

fn tokens_of(inp: &InpFile, at: (usize, usize)) -> Vec<String> {
    inp.sections()[at.0].lines()[at.1].to_vec()
}

/// Sets one field of the line at `at`, keeping the rest of the line's text when the
/// layout does not change.
pub(crate) fn set_field_at(
    tx: &mut Tx,
    kind: &SectionKind,
    at: (usize, usize),
    field: usize,
    value: &str,
) -> EditResult<()> {
    let ctx = Context::of(tx.inp());
    let old = tokens_of(tx.inp(), at);
    let t: Vec<&str> = old.iter().map(String::as_str).collect();
    let defs = schema::layout(kind, &t, &ctx).ok_or_else(|| format!("[{}] cannot be edited here", kind.name()))?;
    let def = defs.get(field).ok_or_else(|| format!("no field #{field} in [{}]", kind.name()))?;
    if field == 0 {
        return Err("rename the object instead".into());
    }
    let value = schema::validate(def, value)?;
    let new = schema::set_field(kind, &t, field, &value, &ctx).expect("layout exists");
    let mut line = tx.inp().sections()[at.0].lines()[at.1].clone();
    if new.len() == old.len() && new.iter().zip(&old).enumerate().all(|(i, (a, b))| i == field || a == b) {
        line.set_token(field, &new[field]);
    } else {
        line.set_tokens(&new);
    }
    tx.replace_line(at.0, at.1, line);
    Ok(())
}

/// Sets field `field` of the line identified by `key` in a section.
pub fn set_field(tx: &mut Tx, kind: &SectionKind, key: &[String], field: usize, value: &str) -> EditResult<()> {
    let k: Vec<&str> = key.iter().map(String::as_str).collect();
    let at = find_line(tx.inp(), kind, &k).ok_or_else(|| format!("no line {} in [{}]", key.join(" "), kind.name()))?;
    set_field_at(tx, kind, at, field, value)
}

/// Sets a field (by key) on the lines of many objects; objects without such a line are
/// skipped. Returns how many lines were edited.
pub fn set_field_bulk(
    tx: &mut Tx,
    kind: &SectionKind,
    ids: &[String],
    field_key: &str,
    value: &str,
) -> EditResult<usize> {
    let index = line_index(tx.inp(), kind);
    let ctx = Context::of(tx.inp());
    let mut n = 0;
    for id in ids {
        let Some(&at) = index.get(&id.to_ascii_uppercase()) else { continue };
        let old = tokens_of(tx.inp(), at);
        let t: Vec<&str> = old.iter().map(String::as_str).collect();
        let Some(field) = schema::layout(kind, &t, &ctx).and_then(|d| d.iter().position(|d| d.key == field_key)) else {
            continue;
        };
        set_field_at(tx, kind, at, field, value).map_err(|e| format!("{id}: {e}"))?;
        n += 1;
    }
    Ok(n)
}

/// Adds the line of a section for an object (e.g. its `[RDII]` line) with defaults.
pub fn add_line(tx: &mut Tx, kind: &SectionKind, key: &[String]) -> EditResult<()> {
    let k: Vec<&str> = key.iter().map(String::as_str).collect();
    if find_line(tx.inp(), kind, &k).is_some() {
        return Err(format!("{} already has a [{}] line", k.first().copied().unwrap_or(""), kind.name()));
    }
    let ctx = Context::of(tx.inp());
    let tokens =
        schema::new_line_tokens(kind, &k, &ctx).ok_or_else(|| format!("[{}] cannot be added here", kind.name()))?;
    tx.append(kind, &tokens);
    Ok(())
}

pub fn remove_line(tx: &mut Tx, kind: &SectionKind, key: &[String]) -> EditResult<()> {
    let k: Vec<&str> = key.iter().map(String::as_str).collect();
    let (s, l) =
        find_line(tx.inp(), kind, &k).ok_or_else(|| format!("no line {} in [{}]", key.join(" "), kind.name()))?;
    tx.remove_line(s, l);
    Ok(())
}
