//! Model checks run before a simulation: problems SWMM would stop on (errors) and
//! suspicious data (warnings), each linked to the object it is about.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use swmm_inp::{InpFile, SectionKind};

use crate::schema::{self, Context, FieldType, RefKind};
use crate::{attribute, refs, LinkType, Network, NodeType, ObjKind, ObjRef};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Issue {
    pub severity: Severity,
    /// Stable short name of the check (`duplicate_id`, `adverse_slope`…).
    pub code: &'static str,
    pub message: String,
    /// Object the issue is about, when it is in the network.
    pub object: Option<ObjRef>,
    /// Section and first token of the line, when the issue is about a line.
    pub section: Option<String>,
    pub id: Option<String>,
}

struct Out<'a> {
    net: &'a Network,
    issues: Vec<Issue>,
}

impl Out<'_> {
    fn push(
        &mut self,
        severity: Severity,
        code: &'static str,
        message: String,
        section: &SectionKind,
        id: &str,
        kind: Option<ObjKind>,
    ) {
        let object = kind.and_then(|k| self.net.find_ref(k, id));
        self.issues.push(Issue {
            severity,
            code,
            message,
            object,
            section: Some(section.name().to_string()),
            id: Some(id.to_string()),
        });
    }
}

const NODE_SECTIONS: [SectionKind; 4] =
    [SectionKind::Junctions, SectionKind::Outfalls, SectionKind::Dividers, SectionKind::Storage];
const LINK_SECTIONS: [SectionKind; 5] =
    [SectionKind::Conduits, SectionKind::Pumps, SectionKind::Orifices, SectionKind::Weirs, SectionKind::Outlets];

/// Kind of network object whose lines a section holds (for linking issues).
fn owner(kind: &SectionKind) -> Option<ObjKind> {
    use SectionKind as S;
    match kind {
        S::Junctions | S::Outfalls | S::Dividers | S::Storage | S::Coordinates | S::Inflows | S::Dwf | S::Rdii => {
            Some(ObjKind::Node)
        }
        S::Conduits | S::Pumps | S::Orifices | S::Weirs | S::Outlets | S::Xsections | S::Losses | S::Vertices => {
            Some(ObjKind::Link)
        }
        S::Subcatchments | S::Subareas | S::Infiltration | S::Polygons => Some(ObjKind::Subcatchment),
        S::Raingages | S::Symbols => Some(ObjKind::Gage),
        _ => None,
    }
}

fn ref_word(k: RefKind) -> &'static str {
    match k {
        RefKind::Node => "node",
        RefKind::Link => "link",
        RefKind::Subcatchment => "subcatchment",
        RefKind::Gage => "rain gage",
        RefKind::Outlet => "node or subcatchment",
        RefKind::Curve => "curve",
        RefKind::Timeseries => "time series",
        RefKind::Pattern => "time pattern",
        RefKind::Hydrograph => "unit hydrograph",
        RefKind::Transect => "transect",
        RefKind::Street => "street",
        RefKind::Snowpack => "snow pack",
    }
}

/// Checks the model.
pub fn validate(inp: &InpFile, net: &Network) -> Vec<Issue> {
    let mut out = Out { net, issues: Vec::new() };
    let ctx = Context::of(inp);
    use Severity::*;

    // Duplicate names within each category.
    for (sections, what, kind) in [
        (&NODE_SECTIONS[..], "node", ObjKind::Node),
        (&LINK_SECTIONS[..], "link", ObjKind::Link),
        (&[SectionKind::Subcatchments][..], "subcatchment", ObjKind::Subcatchment),
        (&[SectionKind::Raingages][..], "rain gage", ObjKind::Gage),
    ] {
        let mut seen: HashSet<String> = HashSet::new();
        for s in sections {
            for l in inp.rows(s) {
                if let Some(id) = l.token(0) {
                    if !seen.insert(id.to_ascii_uppercase()) {
                        out.push(
                            Error,
                            "duplicate_id",
                            format!("{what} {id} is defined more than once (the first definition is used)"),
                            s,
                            id,
                            Some(kind),
                        );
                    }
                }
            }
        }
    }

    // References to objects that do not exist, from every field of every line.
    let mut names: HashMap<RefKind, HashSet<String>> = HashMap::new();
    let mut known = |k: RefKind, v: &str| -> bool {
        let set = names.entry(k).or_insert_with(|| match k {
            RefKind::Outlet => refs::names(inp, RefKind::Node)
                .into_iter()
                .chain(refs::names(inp, RefKind::Subcatchment))
                .map(|s| s.to_ascii_uppercase())
                .collect(),
            _ => refs::names(inp, k).into_iter().map(|s| s.to_ascii_uppercase()).collect(),
        });
        set.contains(&v.to_ascii_uppercase())
    };
    for s in inp.sections() {
        let kind = s.kind();
        let defines = kind.defines_objects();
        for (_, l) in s.data() {
            let t: Vec<&str> = l.tokens().collect();
            let Some(defs) = schema::layout(kind, &t, &ctx) else { continue };
            let id = t.first().copied().unwrap_or("");
            for (i, d) in defs.iter().enumerate() {
                let FieldType::Ref { to } = d.ty else { continue };
                let Some(v) = t.get(i).copied().filter(|v| !v.is_empty() && *v != "*") else {
                    if i > 0 && t.get(i) == Some(&"*") && needs_target(kind, d.key) {
                        out.push(
                            Error,
                            "missing_reference",
                            format!("{id}: {} is not set", d.name),
                            kind,
                            id,
                            owner(kind),
                        );
                    }
                    continue;
                };
                if i == 0 && defines {
                    continue;
                }
                // Coordinates and symbols share a layout: symbols name rain gages.
                let to = if i == 0 && *kind == SectionKind::Symbols { RefKind::Gage } else { to };
                if !known(to, v) {
                    let (code, msg) = if i == 0 {
                        ("orphan_line", format!("[{}] line for {v}, which is not a {}", kind.name(), ref_word(to)))
                    } else if *kind == SectionKind::Rdii {
                        ("unknown_hydrograph", format!("{id}: RDII uses unit hydrograph {v}, which does not exist"))
                    } else {
                        ("unknown_reference", format!("{id}: {} {v} does not exist ({})", d.name, ref_word(to)))
                    };
                    let sev = if i == 0 { Warning } else { Error };
                    out.push(sev, code, msg, kind, id, owner(kind));
                }
            }
        }
    }

    // Links: end nodes, cross-sections, length, roughness, offsets, slope.
    let xsections: HashSet<String> =
        inp.rows(&SectionKind::Xsections).filter_map(|l| l.token(0)).map(|s| s.to_ascii_uppercase()).collect();
    let invert = attribute(inp, net, ObjKind::Node, "invert_elevation").unwrap_or_default();
    let elevation_offsets = inp.option("LINK_OFFSETS").is_some_and(|o| o.eq_ignore_ascii_case("ELEVATION"));
    for link in &net.links {
        let id = link.id.as_str();
        let section = link.kind.section();
        if link.from.is_some() && link.from == link.to {
            out.push(
                Error,
                "same_end_nodes",
                format!("{id} starts and ends at the same node"),
                &section,
                id,
                Some(ObjKind::Link),
            );
        }
        let needs_xsection = matches!(link.kind, LinkType::Conduit | LinkType::Orifice | LinkType::Weir);
        if needs_xsection && !xsections.contains(&id.to_ascii_uppercase()) {
            out.push(
                Error,
                "missing_xsection",
                format!("{id} has no [XSECTIONS] line"),
                &section,
                id,
                Some(ObjKind::Link),
            );
        }
    }
    for l in inp.rows(&SectionKind::Conduits) {
        let Some(id) = l.token(0) else { continue };
        let Some(li) = net.find(ObjKind::Link, id) else { continue };
        let link = &net.links[li as usize];
        if link.kind != LinkType::Conduit {
            continue;
        }
        let num = |k: usize| l.token(k).and_then(|x| x.parse::<f64>().ok());
        let s = &SectionKind::Conduits;
        match num(3) {
            Some(len) if len > 0.0 => {}
            _ => out.push(Error, "bad_length", format!("{id}: length must be positive"), s, id, Some(ObjKind::Link)),
        }
        match num(4) {
            Some(n) if n > 0.0 => {}
            _ => out.push(
                Error,
                "bad_roughness",
                format!("{id}: roughness must be positive"),
                s,
                id,
                Some(ObjKind::Link),
            ),
        }
        let (Some(a), Some(b)) = (link.from, link.to) else { continue };
        let (za, zb) = (
            invert.get(a as usize).copied().unwrap_or(f32::NAN) as f64,
            invert.get(b as usize).copied().unwrap_or(f32::NAN) as f64,
        );
        let mut ends = [za, zb];
        for (k, (tok, z)) in [(5, za), (6, zb)].into_iter().enumerate() {
            let off = l.token(tok);
            let which = if k == 0 { "inlet" } else { "outlet" };
            if elevation_offsets {
                if let Some(e) = off.filter(|o| *o != "*").and_then(|o| o.parse::<f64>().ok()) {
                    ends[k] = e;
                    if e < z - 1e-9 {
                        out.push(
                            Warning,
                            "offset_below_invert",
                            format!("{id}: {which} elevation {e} is below the node invert {z}"),
                            s,
                            id,
                            Some(ObjKind::Link),
                        );
                    }
                }
            } else if let Some(o) = off.and_then(|o| o.parse::<f64>().ok()) {
                ends[k] = z + o;
                if o < 0.0 {
                    out.push(
                        Warning,
                        "offset_below_invert",
                        format!("{id}: negative {which} offset {o} (below the node invert)"),
                        s,
                        id,
                        Some(ObjKind::Link),
                    );
                }
            }
        }
        if ends[0].is_finite() && ends[1].is_finite() && ends[0] < ends[1] {
            out.push(
                Warning,
                "adverse_slope",
                format!("{id}: adverse slope (inlet {:.3} below outlet {:.3})", ends[0], ends[1]),
                s,
                id,
                Some(ObjKind::Link),
            );
        }
    }

    // Subcatchments without subareas or infiltration.
    for (section, what) in [(SectionKind::Subareas, "[SUBAREAS]"), (SectionKind::Infiltration, "[INFILTRATION]")] {
        let have: HashSet<String> =
            inp.rows(&section).filter_map(|l| l.token(0)).map(|s| s.to_ascii_uppercase()).collect();
        for s in &net.subcatchments {
            if !have.contains(&s.id.to_ascii_uppercase()) {
                out.push(
                    Error,
                    "missing_subarea",
                    format!("{} has no {what} line", s.id),
                    &SectionKind::Subcatchments,
                    &s.id,
                    Some(ObjKind::Subcatchment),
                );
            }
        }
    }

    // Nodes: not connected, no coordinates; sub-networks without an outfall.
    let mut degree = vec![0u32; net.nodes.len()];
    for l in &net.links {
        for n in [l.from, l.to].into_iter().flatten() {
            degree[n as usize] += 1;
        }
    }
    let outlets: HashSet<u32> = net
        .subcatchments
        .iter()
        .filter_map(|s| s.outlet)
        .filter(|o| o.kind == ObjKind::Node)
        .map(|o| o.index)
        .collect();
    for (i, n) in net.nodes.iter().enumerate() {
        let section = n.kind.section();
        if degree[i] == 0 {
            let msg = if outlets.contains(&(i as u32)) {
                format!("{} receives runoff but no link is connected to it", n.id)
            } else {
                format!("{} is not connected to any link", n.id)
            };
            out.push(Warning, "unconnected_node", msg, &section, &n.id, Some(ObjKind::Node));
        }
        if n.xy.is_none() {
            out.push(
                Warning,
                "no_coordinates",
                format!("{} has no coordinates (not drawn on the map)", n.id),
                &section,
                &n.id,
                Some(ObjKind::Node),
            );
        }
    }
    // Union-find over links.
    let mut parent: Vec<u32> = (0..net.nodes.len() as u32).collect();
    fn root(p: &mut [u32], mut x: u32) -> u32 {
        while p[x as usize] != x {
            p[x as usize] = p[p[x as usize] as usize];
            x = p[x as usize];
        }
        x
    }
    for l in &net.links {
        if let (Some(a), Some(b)) = (l.from, l.to) {
            let (ra, rb) = (root(&mut parent, a), root(&mut parent, b));
            if ra != rb {
                parent[ra as usize] = rb;
            }
        }
    }
    let mut groups: HashMap<u32, (usize, bool, u32)> = HashMap::new();
    for (i, n) in net.nodes.iter().enumerate() {
        if degree[i] == 0 {
            continue;
        }
        let r = root(&mut parent, i as u32);
        let g = groups.entry(r).or_insert((0, false, i as u32));
        g.0 += 1;
        g.1 |= n.kind == NodeType::Outfall;
    }
    let mut lonely: Vec<_> = groups.into_values().filter(|g| !g.1).collect();
    lonely.sort_by_key(|g| g.2);
    for (count, _, first) in lonely {
        let n = &net.nodes[first as usize];
        out.push(
            Warning,
            "no_outfall",
            format!("{count} connected node(s) starting with {} drain to no outfall", n.id),
            &n.kind.section(),
            &n.id,
            Some(ObjKind::Node),
        );
    }

    out.issues.sort_by_key(|a| a.severity);
    out.issues
}

/// Fields that must name an object (a `*` there is an error).
fn needs_target(kind: &SectionKind, key: &str) -> bool {
    matches!(
        (kind, key),
        (
            SectionKind::Conduits
                | SectionKind::Pumps
                | SectionKind::Orifices
                | SectionKind::Weirs
                | SectionKind::Outlets,
            "from" | "to"
        ) | (SectionKind::Rdii, "uh")
            | (SectionKind::Raingages, "ts")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = "\
[OPTIONS]
FLOW_UNITS LPS
[RAINGAGES]
RG1 INTENSITY 0:05 1.0 TIMESERIES TSX
[SUBCATCHMENTS]
S1 RG1 J1 2.5 60 150 1.5 0
[SUBAREAS]
S1 0.013 0.15 1.5 5 25 OUTLET
[JUNCTIONS]
J1 100 2.5
J2 101 2.5
J3 99 2
J1 50 1
K1 90 1
K2 89 1
L1 10 1
[OUTFALLS]
O1 97 FREE
[CONDUITS]
C1 J1 J2 120 0.013 0 0
C2 J2 O1 50 0.013 -0.5 0
C3 J3 O1 0 0 0 0
K12 K1 K2 10 0.01 0 0
[XSECTIONS]
C1 CIRCULAR 0.4 0 0 0 1
C2 CUSTOM 2 SH1 1
K12 CIRCULAR 1 0 0 0 1
CZ CIRCULAR 1 0 0 0 1
[RDII]
J2 UH9 1
[COORDINATES]
J1 0 0
[SYMBOLS]
RG1 0 0
";

    #[test]
    fn finds_problems() {
        let inp = InpFile::parse_str(SRC);
        let net = Network::from_inp(&inp);
        let issues = validate(&inp, &net);
        let has = |code: &str, id: &str| issues.iter().any(|i| i.code == code && i.id.as_deref() == Some(id));
        assert!(has("duplicate_id", "J1"));
        assert!(has("unknown_reference", "RG1"), "missing time series");
        assert!(has("unknown_reference", "C2"), "missing shape curve");
        assert!(has("unknown_hydrograph", "J2"));
        assert!(has("orphan_line", "CZ"));
        assert!(!has("orphan_line", "RG1"), "symbols name rain gages");
        assert!(has("missing_xsection", "C3"));
        assert!(has("bad_length", "C3") && has("bad_roughness", "C3"));
        assert!(has("adverse_slope", "C1"));
        assert!(has("offset_below_invert", "C2"));
        assert!(has("missing_subarea", "S1"), "no infiltration line");
        assert!(has("unconnected_node", "L1"));
        assert!(has("no_outfall", "K1"));
        assert!(!has("no_outfall", "J1"));
        assert!(has("no_coordinates", "J2") && !has("no_coordinates", "J1"));
        let first_warning = issues.iter().position(|i| i.severity == Severity::Warning).unwrap();
        assert!(issues[first_warning..].iter().all(|i| i.severity == Severity::Warning));
        let c1 = issues.iter().find(|i| i.code == "adverse_slope").unwrap();
        assert_eq!(c1.object, Some(ObjRef { kind: ObjKind::Link, index: 0 }));
    }
}
