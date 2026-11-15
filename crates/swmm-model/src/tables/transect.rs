//! Transects: `NC` / `X1` / `GR` line blocks of `[TRANSECTS]`.

use swmm_inp::{InpFile, Line, SectionKind};

use super::{pairs, Transect};
use crate::edit::{EditResult, Tx};

/// A transect and the lines it spans.
pub(super) struct TransectBlock {
    pub(super) t: Transect,
    pub(super) section: usize,
    /// First line of the block (its own `NC` line, or `X1`).
    pub(super) start: usize,
    /// One past its last `GR` line.
    pub(super) end: usize,
    /// Has an `NC` line right before its `X1`.
    pub(super) own_nc: bool,
}

pub(super) fn parse_transects(inp: &InpFile) -> Vec<TransectBlock> {
    let mut out: Vec<TransectBlock> = Vec::new();
    for (si, s) in inp.sections().iter().enumerate().filter(|(_, s)| *s.kind() == SectionKind::Transects) {
        let mut nc = ["0.03".to_string(), "0.03".to_string(), "0.03".to_string()];
        let mut nc_line: Option<usize> = None;
        let mut current: Option<TransectBlock> = None;
        for (li, l) in s.data() {
            let key = l.token(0).unwrap_or("").to_ascii_uppercase();
            let g = |i: usize| l.token(i).unwrap_or("0").to_string();
            match key.as_str() {
                "NC" => {
                    out.extend(current.take());
                    nc = [g(1), g(2), g(3)];
                    nc_line = Some(li);
                }
                "X1" => {
                    out.extend(current.take());
                    let own_nc = nc_line.is_some();
                    current = Some(TransectBlock {
                        t: Transect {
                            name: g(1),
                            n_left: nc[0].clone(),
                            n_right: nc[1].clone(),
                            n_channel: nc[2].clone(),
                            x_left: g(3),
                            x_right: g(4),
                            lfactor: g(8),
                            wfactor: g(9),
                            eoffset: g(10),
                            points: Vec::new(),
                        },
                        section: si,
                        start: nc_line.unwrap_or(li),
                        end: li + 1,
                        own_nc,
                    });
                    nc_line = None;
                }
                "GR" => {
                    if let Some(c) = current.as_mut() {
                        let t: Vec<&str> = l.tokens().skip(1).collect();
                        // GR lists elevation then station.
                        c.t.points.extend(pairs(&t).into_iter().map(|[e, st]| [st, e]));
                        c.end = li + 1;
                    }
                }
                _ => {}
            }
        }
        out.extend(current.take());
    }
    out
}

fn transect_lines(t: &Transect, ending: swmm_inp::LineEnding) -> Vec<Line> {
    let mut lines = vec![
        Line::from_tokens(&["NC", &t.n_left, &t.n_right, &t.n_channel], None, ending),
        Line::from_tokens(
            &[
                "X1",
                &t.name,
                &t.points.len().to_string(),
                &t.x_left,
                &t.x_right,
                "0.0",
                "0.0",
                "0.0",
                &t.lfactor,
                &t.wfactor,
                &t.eoffset,
            ],
            None,
            ending,
        ),
    ];
    for chunk in t.points.chunks(5) {
        let mut r = vec!["GR".to_string()];
        for [st, e] in chunk {
            r.push(e.clone());
            r.push(st.clone());
        }
        lines.push(Line::from_tokens(&r, None, ending));
    }
    lines
}

/// Before transect `i` changes its roughness (or goes away), gives the next transect
/// its own `NC` line if it relied on the one of transect `i`.
pub(super) fn fix_next_roughness(tx: &mut Tx, all: &[TransectBlock], i: usize, new_nc: Option<[&str; 3]>) {
    let Some(next) = all.get(i + 1).filter(|n| n.section == all[i].section && !n.own_nc) else {
        return;
    };
    let keep = [next.t.n_left.as_str(), next.t.n_right.as_str(), next.t.n_channel.as_str()];
    if new_nc == Some(keep) {
        return;
    }
    let ending = tx.inp().line_ending();
    tx.insert_line(next.section, next.start, Line::from_tokens(&["NC", keep[0], keep[1], keep[2]], None, ending));
}

pub(super) fn write_transect(tx: &mut Tx, t: &Transect) -> EditResult<()> {
    let ending = tx.inp().line_ending();
    let all = parse_transects(tx.inp());
    let lines = transect_lines(t, ending);
    match all.iter().position(|b| b.t.name.eq_ignore_ascii_case(&t.name)) {
        Some(i) => {
            if all[i].t == *t {
                return Ok(());
            }
            fix_next_roughness(tx, &all, i, Some([&t.n_left, &t.n_right, &t.n_channel]));
            let b = &all[i];
            let data: Vec<usize> =
                (b.start..b.end).filter(|&li| tx.inp().sections()[b.section].lines()[li].is_data()).collect();
            let (section, start) = (b.section, b.start);
            for &li in data.iter().rev() {
                tx.remove_line(section, li);
            }
            tx.splice(section, start, 0, lines);
        }
        None => {
            let s = tx.ensure_section(&SectionKind::Transects);
            let at = tx.inp().sections()[s].append_index();
            tx.splice(s, at, 0, lines);
        }
    }
    Ok(())
}
