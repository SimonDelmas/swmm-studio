//! Options, title and RDII assignments.

use std::collections::HashSet;

use swmm_inp::{InpFile, Line, LineKind, SectionKind};

use super::fields::{line_index, set_field_at};
use crate::edit::{EditResult, Tx};
use crate::schema::check_id;

/// Sets `[OPTIONS]` values; an empty value removes the option.
pub fn set_options(tx: &mut Tx, values: &[(String, String)]) -> EditResult<()> {
    for (key, value) in values {
        let key = key.trim().to_ascii_uppercase();
        let value = value.trim();
        if key.is_empty() || key.contains(char::is_whitespace) {
            return Err(format!("invalid option name {key:?}"));
        }
        crate::schema::check_text(value).map_err(|e| format!("{key}: {e}"))?;
        // The last line wins, as in InpFile::option.
        let at = tx.inp().sections().iter().enumerate().filter(|(_, s)| *s.kind() == SectionKind::Options).fold(
            None,
            |acc, (si, s)| {
                s.data()
                    .filter(|(_, l)| l.token(0).is_some_and(|k| k.eq_ignore_ascii_case(&key)))
                    .last()
                    .map(|(li, _)| (si, li))
                    .or(acc)
            },
        );
        match (at, value.is_empty()) {
            (Some((s, l)), true) => tx.remove_line(s, l),
            (Some((s, l)), false) => {
                let mut line = tx.inp().sections()[s].lines()[l].clone();
                if line.to_vec()[1..].join(" ") == value {
                    continue;
                }
                if line.len() == 2 && !value.contains(' ') {
                    line.set_token(1, value);
                } else {
                    let k = line.token(0).unwrap_or(&key).to_string();
                    let mut t = vec![k];
                    t.extend(value.split_whitespace().map(str::to_string));
                    line.set_tokens(&t);
                }
                tx.replace_line(s, l, line);
            }
            (None, true) => {}
            (None, false) => {
                let mut t = vec![key.clone()];
                t.extend(value.split_whitespace().map(str::to_string));
                tx.append(&SectionKind::Options, &t);
            }
        }
    }
    Ok(())
}

/// Text of the `[TITLE]` section (comment lines excluded).
pub fn title(inp: &InpFile) -> String {
    inp.section(&SectionKind::Title)
        .map(|s| s.data().map(|(_, l)| l.text().to_string()).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default()
}

/// Replaces the text lines of `[TITLE]`, keeping its comment lines.
pub fn set_title(tx: &mut Tx, text: &str) -> EditResult<()> {
    // `[` would start a section and `;` a comment, which is kept apart from the title.
    if let Some(c) = text.lines().find_map(|l| l.trim_start().chars().next().filter(|c| matches!(c, '[' | ';'))) {
        return Err(format!("a title line cannot start with '{c}'"));
    }
    let s = tx.ensure_section(&SectionKind::Title);
    let ending = tx.inp().line_ending();
    let old: Vec<usize> = tx.inp().sections()[s].data().map(|(i, _)| i).collect();
    let at = old.first().copied().unwrap_or_else(|| {
        // After the leading comments.
        let lines = tx.inp().sections()[s].lines();
        lines.iter().position(|l| l.kind() != LineKind::Comment).unwrap_or(lines.len())
    });
    for &i in old.iter().rev() {
        tx.remove_line(s, i);
    }
    let lines: Vec<Line> =
        text.lines().filter(|l| !l.trim().is_empty()).map(|l| Line::from_text(l.trim_end(), ending, true)).collect();
    tx.splice(s, at, 0, lines);
    Ok(())
}

/// Assigns a unit hydrograph (and optionally a sewershed area) to nodes, adding their
/// `[RDII]` line where missing. Returns the number of nodes changed.
pub fn assign_rdii(tx: &mut Tx, nodes: &[String], hydrograph: &str, area: Option<&str>) -> EditResult<usize> {
    check_id(hydrograph).map_err(|e| format!("unit hydrograph: {e}"))?;
    if let Some(a) = area {
        let x: f64 = a.trim().parse().map_err(|_| format!("sewershed area: {a:?} is not a number"))?;
        if x.is_nan() || x < 0.0 {
            return Err("the sewershed area must be positive".into());
        }
    }
    let index = line_index(tx.inp(), &SectionKind::Rdii);
    let mut n = 0;
    for node in nodes {
        match index.get(&node.to_ascii_uppercase()) {
            Some(&at) => {
                set_field_at(tx, &SectionKind::Rdii, at, 1, hydrograph)?;
                if let Some(a) = area {
                    set_field_at(tx, &SectionKind::Rdii, at, 2, a)?;
                }
            }
            None => {
                tx.append(&SectionKind::Rdii, &[node.as_str(), hydrograph, area.unwrap_or("0").trim()]);
            }
        }
        n += 1;
    }
    Ok(n)
}

/// Removes the `[RDII]` lines of nodes. Returns how many were removed.
pub fn remove_rdii(tx: &mut Tx, nodes: &[String]) -> usize {
    let set: HashSet<String> = nodes.iter().map(|n| n.to_ascii_uppercase()).collect();
    let mut at = Vec::new();
    for (si, s) in tx.inp().sections().iter().enumerate().filter(|(_, s)| *s.kind() == SectionKind::Rdii) {
        for (li, l) in s.data() {
            if l.token(0).is_some_and(|t| set.contains(&t.to_ascii_uppercase())) {
                at.push((si, li));
            }
        }
    }
    for &(s, l) in at.iter().rev() {
        tx.remove_line(s, l);
    }
    at.len()
}
