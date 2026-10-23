//! Where object names appear in a model, for renaming, deleting with cascade and
//! "used by" checks.

use std::collections::HashSet;

use serde::Serialize;
use swmm_inp::{InpFile, Line, SectionKind};

use crate::schema::RefKind;

/// What the token means for the line it is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Defines the object.
    Def,
    /// The line belongs to the object (its coordinates, cross-section, inflows…) and
    /// goes away with it.
    Owned,
    /// A reference from another object.
    Ref,
    /// One item of a list (`[REPORT] NODES a b c`): removed from the list on delete.
    List,
    /// A name inside a control rule (left as is on delete, reported to the user).
    Rule,
}

/// One occurrence of a name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefLoc {
    pub section: usize,
    pub line: usize,
    pub token: usize,
    pub role: Role,
}

type Picker = fn(&Line) -> Vec<usize>;

struct Site {
    section: SectionKind,
    role: Role,
    pick: Picker,
}

fn up(l: &Line, i: usize) -> String {
    l.token(i).map(|s| s.to_ascii_uppercase()).unwrap_or_default()
}

fn t0(_: &Line) -> Vec<usize> {
    vec![0]
}
fn t1(_: &Line) -> Vec<usize> {
    vec![1]
}
fn t2(_: &Line) -> Vec<usize> {
    vec![2]
}
fn t12(_: &Line) -> Vec<usize> {
    vec![1, 2]
}
fn t3(_: &Line) -> Vec<usize> {
    vec![3]
}
fn t7(_: &Line) -> Vec<usize> {
    vec![7]
}
fn t12th(_: &Line) -> Vec<usize> {
    vec![12]
}
fn from1(l: &Line) -> Vec<usize> {
    (1..l.len()).collect()
}
fn dwf_patterns(l: &Line) -> Vec<usize> {
    (3..l.len().min(7)).collect()
}

fn site(section: SectionKind, role: Role, pick: Picker) -> Site {
    Site { section, role, pick }
}

/// `[REPORT] <keyword> id id …` lists.
fn report_list(keyword: &'static str) -> Picker {
    match keyword {
        "NODES" => |l| if up(l, 0) == "NODES" { from1(l) } else { vec![] },
        "LINKS" => |l| if up(l, 0) == "LINKS" { from1(l) } else { vec![] },
        _ => |l| if up(l, 0) == "SUBCATCHMENTS" { from1(l) } else { vec![] },
    }
}

/// Tokens of a control rule line that follow one of the given object keywords.
fn rule_tokens(l: &Line, keywords: &[&str]) -> Vec<usize> {
    (1..l.len()).filter(|&i| keywords.iter().any(|k| up(l, i - 1) == *k)).collect()
}

fn sites(kind: RefKind) -> Vec<Site> {
    use Role::*;
    use SectionKind as S;
    match kind {
        RefKind::Node => vec![
            site(S::Junctions, Def, t0),
            site(S::Outfalls, Def, t0),
            site(S::Dividers, Def, t0),
            site(S::Storage, Def, t0),
            site(S::Conduits, Ref, t12),
            site(S::Pumps, Ref, t12),
            site(S::Orifices, Ref, t12),
            site(S::Weirs, Ref, t12),
            site(S::Outlets, Ref, t12),
            site(S::Subcatchments, Ref, t2),
            site(S::Coordinates, Owned, t0),
            site(S::Inflows, Owned, t0),
            site(S::Dwf, Owned, t0),
            site(S::Rdii, Owned, t0),
            site(S::Treatment, Owned, t0),
            site(S::InletUsage, Ref, t2),
            site(S::Groundwater, Ref, |l| if l.len() > 2 { vec![2] } else { vec![] }),
            site(S::Labels, Ref, |l| if l.len() > 3 { vec![3] } else { vec![] }),
            site(S::Tags, Owned, |l| if up(l, 0) == "NODE" { vec![1] } else { vec![] }),
            site(S::Report, List, report_list("NODES")),
            site(S::Controls, Rule, |l| rule_tokens(l, &["NODE"])),
        ],
        RefKind::Link => vec![
            site(S::Conduits, Def, t0),
            site(S::Pumps, Def, t0),
            site(S::Orifices, Def, t0),
            site(S::Weirs, Def, t0),
            site(S::Outlets, Def, t0),
            site(S::Xsections, Owned, t0),
            site(S::Losses, Owned, t0),
            site(S::Vertices, Owned, t0),
            site(S::InletUsage, Owned, t0),
            site(S::Dividers, Ref, t2),
            site(S::Tags, Owned, |l| if up(l, 0) == "LINK" { vec![1] } else { vec![] }),
            site(S::Report, List, report_list("LINKS")),
            site(S::Profiles, List, from1),
            site(S::Controls, Rule, |l| rule_tokens(l, &["LINK", "CONDUIT", "PUMP", "ORIFICE", "WEIR", "OUTLET"])),
        ],
        RefKind::Subcatchment => vec![
            site(S::Subcatchments, Def, t0),
            site(S::Subcatchments, Ref, t2),
            site(S::Subareas, Owned, t0),
            site(S::Infiltration, Owned, t0),
            site(S::Polygons, Owned, t0),
            site(S::LidUsage, Owned, t0),
            site(S::Groundwater, Owned, t0),
            site(S::Gwf, Owned, t0),
            site(S::Coverages, Owned, t0),
            site(S::Loadings, Owned, t0),
            site(S::Outfalls, Ref, |l| {
                let at = if matches!(up(l, 2).as_str(), "FIXED" | "TIDAL" | "TIMESERIES") { 5 } else { 4 };
                if l.len() > at {
                    vec![at]
                } else {
                    vec![]
                }
            }),
            site(S::Tags, Owned, |l| if up(l, 0) == "SUBCATCH" { vec![1] } else { vec![] }),
            site(S::Report, List, report_list("SUBCATCHMENTS")),
        ],
        RefKind::Gage => vec![
            site(S::Raingages, Def, t0),
            site(S::Subcatchments, Ref, t1),
            site(S::Symbols, Owned, t0),
            site(S::Hydrographs, Ref, |l| if l.len() == 2 { vec![1] } else { vec![] }),
            site(S::Controls, Rule, |l| rule_tokens(l, &["GAGE"])),
        ],
        RefKind::Curve => vec![
            site(S::Curves, Def, t0),
            site(S::Storage, Ref, |l| if up(l, 4) == "TABULAR" { vec![5] } else { vec![] }),
            site(S::Dividers, Ref, |l| if up(l, 3) == "TABULAR" { vec![4] } else { vec![] }),
            site(S::Outfalls, Ref, |l| if up(l, 2) == "TIDAL" { vec![3] } else { vec![] }),
            site(S::Pumps, Ref, t3),
            site(S::Outlets, Ref, |l| if up(l, 4).starts_with("TABULAR") { vec![5] } else { vec![] }),
            site(S::Xsections, Ref, |l| if up(l, 1) == "CUSTOM" { vec![3] } else { vec![] }),
            site(S::Weirs, Ref, t12th),
            site(S::Controls, Rule, |l| rule_tokens(l, &["CURVE"])),
        ],
        RefKind::Timeseries => vec![
            site(S::Timeseries, Def, t0),
            site(S::Raingages, Ref, |l| if up(l, 4) == "TIMESERIES" { vec![5] } else { vec![] }),
            site(S::Outfalls, Ref, |l| if up(l, 2) == "TIMESERIES" { vec![3] } else { vec![] }),
            site(S::Inflows, Ref, t2),
            site(S::Evaporation, Ref, |l| if up(l, 0) == "TIMESERIES" { vec![1] } else { vec![] }),
            site(S::Temperature, Ref, |l| if up(l, 0) == "TIMESERIES" { vec![1] } else { vec![] }),
            site(S::Controls, Rule, |l| rule_tokens(l, &["TIMESERIES"])),
        ],
        RefKind::Pattern => vec![
            site(S::Patterns, Def, t0),
            site(S::Inflows, Ref, t7),
            site(S::Dwf, Ref, dwf_patterns),
            site(S::Evaporation, Ref, |l| if up(l, 0) == "RECOVERY" { vec![1] } else { vec![] }),
        ],
        RefKind::Hydrograph => vec![site(S::Hydrographs, Def, t0), site(S::Rdii, Ref, t1)],
        RefKind::Transect => vec![
            site(S::Transects, Def, |l| if up(l, 0) == "X1" { vec![1] } else { vec![] }),
            site(S::Xsections, Ref, |l| if up(l, 1) == "IRREGULAR" { vec![2] } else { vec![] }),
        ],
        RefKind::Street => vec![
            site(S::Streets, Def, t0),
            site(S::Xsections, Ref, |l| if up(l, 1) == "STREET" { vec![2] } else { vec![] }),
        ],
        RefKind::Snowpack => vec![
            site(S::Snowpacks, Def, t0),
            site(S::Subcatchments, Ref, |l| if l.len() > 8 { vec![8] } else { vec![] }),
        ],
        RefKind::Outlet => {
            let mut v = sites(RefKind::Node);
            v.extend(sites(RefKind::Subcatchment));
            v
        }
    }
}

/// Every occurrence of the given names (upper case) of a kind of object, in file order.
pub fn find_refs(inp: &InpFile, kind: RefKind, ids: &HashSet<String>) -> Vec<RefLoc> {
    let mut out = Vec::new();
    if ids.is_empty() {
        return out;
    }
    let sites = sites(kind);
    for (si, s) in inp.sections().iter().enumerate() {
        let mine: Vec<&Site> = sites.iter().filter(|x| &x.section == s.kind()).collect();
        if mine.is_empty() {
            continue;
        }
        for (li, l) in s.data() {
            for x in &mine {
                for t in (x.pick)(l) {
                    if l.token(t).is_some_and(|v| ids.contains(&v.to_ascii_uppercase())) {
                        out.push(RefLoc { section: si, line: li, token: t, role: x.role });
                    }
                }
            }
        }
    }
    out.sort_by_key(|r| (r.section, r.line, r.token));
    out.dedup_by_key(|r| (r.section, r.line, r.token));
    out
}

/// Names of the objects of a kind, in file order, without duplicates.
pub fn names(inp: &InpFile, kind: RefKind) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for x in sites(kind).iter().filter(|x| x.role == Role::Def) {
        for l in inp.rows(&x.section) {
            for t in (x.pick)(l) {
                if let Some(v) = l.token(t) {
                    if seen.insert(v.to_ascii_uppercase()) {
                        out.push(v.to_string());
                    }
                }
            }
        }
    }
    out
}

/// A line that refers to an object, for "used by" messages.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Usage {
    pub section: String,
    /// First token of the line (the referring object).
    pub by: String,
    pub role: Role,
}

/// Lines that refer to `id` without belonging to it.
pub fn usages(inp: &InpFile, kind: RefKind, id: &str) -> Vec<Usage> {
    let ids: HashSet<String> = [id.to_ascii_uppercase()].into();
    find_refs(inp, kind, &ids)
        .into_iter()
        .filter(|r| matches!(r.role, Role::Ref | Role::List | Role::Rule))
        .map(|r| {
            let s = &inp.sections()[r.section];
            let l = &s.lines()[r.line];
            Usage { section: s.name().to_string(), by: l.token(0).unwrap_or("").to_string(), role: r.role }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = "\
[RAINGAGES]
RG1 INTENSITY 0:05 1.0 TIMESERIES TS1
[SUBCATCHMENTS]
S1 RG1 J1 1 10 50 1 0
S2 RG1 S1 1 10 50 1 0
[OUTFALLS]
O1 90 TIMESERIES TS1 NO S2
[JUNCTIONS]
J1 100 2
[CONDUITS]
C1 J1 O1 10 0.01 0 0
[XSECTIONS]
C1 CUSTOM 1 SH1 1
[INFLOWS]
J1 FLOW TS1 FLOW 1 1 0 P1
[DWF]
J1 FLOW 1 \"\" P1
[CURVES]
SH1 SHAPE 0 0
[TIMESERIES]
TS1 0:00 1
[PATTERNS]
P1 HOURLY 1 1
[REPORT]
NODES J1 O1
[TAGS]
Node J1 main
[CONTROLS]
RULE R1
IF NODE J1 DEPTH > 1
THEN CONDUIT C1 STATUS = CLOSED
";

    fn ids(v: &[&str]) -> HashSet<String> {
        v.iter().map(|s| s.to_ascii_uppercase()).collect()
    }

    #[test]
    fn finds_every_occurrence() {
        let inp = InpFile::parse_str(SRC);
        let j1 = find_refs(&inp, RefKind::Node, &ids(&["j1"]));
        let roles: Vec<Role> = j1.iter().map(|r| r.role).collect();
        use Role::*;
        assert_eq!(roles, [Ref, Def, Ref, Owned, Owned, List, Owned, Rule]);
        let ts = find_refs(&inp, RefKind::Timeseries, &ids(&["TS1"]));
        assert_eq!(ts.len(), 4);
        let s1 = find_refs(&inp, RefKind::Subcatchment, &ids(&["S2"]));
        assert_eq!(s1.iter().map(|r| r.role).collect::<Vec<_>>(), [Def, Ref]);
        assert_eq!(find_refs(&inp, RefKind::Pattern, &ids(&["P1"])).len(), 3);
        assert_eq!(find_refs(&inp, RefKind::Curve, &ids(&["sh1"])).len(), 2);
        assert_eq!(names(&inp, RefKind::Node), ["J1", "O1"]);
        let u = usages(&inp, RefKind::Curve, "SH1");
        assert_eq!(u, [Usage { section: "XSECTIONS".into(), by: "C1".into(), role: Ref }]);
    }
}
