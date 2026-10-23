//! Named fields of an object, read from every `.inp` section that describes it.

use serde::Serialize;
use swmm_inp::{InpFile, Line, SectionKind};

use crate::{Network, ObjKind, ObjRef};

/// One `.inp` line describing the object, as named fields.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PropertyGroup {
    /// Section name, e.g. `JUNCTIONS`, `INFLOWS (FLOW)`.
    pub title: String,
    pub fields: Vec<(String, String)>,
    /// Inline comment of the line.
    pub comment: Option<String>,
}

/// All properties of an object, grouped by section, in a fixed order.
pub fn properties(inp: &InpFile, net: &Network, r: ObjRef) -> Vec<PropertyGroup> {
    let id = net.id(r).to_string();
    let infil = inp.option("INFILTRATION").unwrap_or_else(|| "HORTON".into());
    let sections: Vec<SectionKind> = match r.kind {
        ObjKind::Node => {
            let main = net.nodes[r.index as usize].kind.section();
            vec![main, SectionKind::Coordinates, SectionKind::Inflows, SectionKind::Dwf, SectionKind::Rdii]
        }
        ObjKind::Link => {
            let main = net.links[r.index as usize].kind.section();
            vec![main, SectionKind::Xsections, SectionKind::Losses]
        }
        ObjKind::Subcatchment => vec![
            SectionKind::Subcatchments,
            SectionKind::Subareas,
            SectionKind::Infiltration,
            SectionKind::LidUsage,
            SectionKind::Groundwater,
            SectionKind::Coverages,
        ],
        ObjKind::Gage => vec![SectionKind::Raingages, SectionKind::Symbols],
    };
    let mut out = Vec::new();
    for kind in &sections {
        let lines: Vec<&Line> =
            inp.rows(kind).filter(|l| l.token(0).is_some_and(|t| t.eq_ignore_ascii_case(&id))).collect();
        let multi = lines.len() > 1;
        for l in lines {
            let tokens: Vec<&str> = l.tokens().collect();
            let names = field_names(kind, &tokens, &infil);
            let mut title = kind.name().to_string();
            if multi && matches!(kind, SectionKind::Inflows | SectionKind::Dwf) {
                title = format!("{title} ({})", tokens.get(1).unwrap_or(&""));
            }
            out.push(PropertyGroup {
                title,
                fields: names.into_iter().zip(tokens.iter().map(|t| t.to_string())).collect(),
                comment: l.comment().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
            });
        }
    }
    let tag_type = match r.kind {
        ObjKind::Node => "Node",
        ObjKind::Link => "Link",
        ObjKind::Subcatchment => "Subcatch",
        ObjKind::Gage => "",
    };
    if let Some(tag) = inp
        .rows(&SectionKind::Tags)
        .find(|l| {
            l.token(0).is_some_and(|t| t.eq_ignore_ascii_case(tag_type))
                && l.token(1).is_some_and(|t| t.eq_ignore_ascii_case(&id))
        })
        .and_then(|l| l.token(2))
    {
        out.push(PropertyGroup { title: "TAGS".into(), fields: vec![("Tag".into(), tag.to_string())], comment: None });
    }
    out
}

/// Field names for the tokens of a line. Lines longer than the known layout get
/// `Field N` names for the extra tokens.
pub fn field_names(kind: &SectionKind, t: &[&str], infiltration: &str) -> Vec<String> {
    let up = |i: usize| t.get(i).map(|s| s.to_ascii_uppercase()).unwrap_or_default();
    let mut names: Vec<&str> = match kind {
        SectionKind::Junctions => {
            vec!["Name", "Elevation", "Max depth", "Initial depth", "Surcharge depth", "Ponded area"]
        }
        SectionKind::Outfalls => {
            let mut v = vec!["Name", "Elevation", "Type"];
            match up(2).as_str() {
                "FIXED" => v.push("Fixed stage"),
                "TIDAL" => v.push("Tidal curve"),
                "TIMESERIES" => v.push("Stage time series"),
                _ => {}
            }
            v.extend(["Flap gate", "Route to"]);
            v
        }
        SectionKind::Dividers => {
            let mut v = vec!["Name", "Elevation", "Diverted link", "Type"];
            match up(3).as_str() {
                "CUTOFF" => v.push("Cutoff flow"),
                "TABULAR" => v.push("Diversion curve"),
                "WEIR" => v.extend(["Min flow", "Weir max depth", "Weir coefficient"]),
                _ => {}
            }
            v.extend(["Max depth", "Initial depth", "Surcharge depth", "Ponded area"]);
            v
        }
        SectionKind::Storage => {
            let mut v = vec!["Name", "Elevation", "Max depth", "Initial depth", "Shape"];
            match up(4).as_str() {
                "TABULAR" => v.push("Storage curve"),
                "FUNCTIONAL" => v.extend(["Coefficient", "Exponent", "Constant"]),
                _ => v.extend(["Length / major axis", "Width / minor axis", "Side slope"]),
            }
            v.extend(["Surcharge depth", "Evaporation factor", "Suction head", "Conductivity", "Initial deficit"]);
            v
        }
        SectionKind::Conduits => vec![
            "Name",
            "From node",
            "To node",
            "Length",
            "Roughness",
            "Inlet offset",
            "Outlet offset",
            "Initial flow",
            "Max flow",
        ],
        SectionKind::Pumps => {
            vec!["Name", "From node", "To node", "Pump curve", "Initial status", "Startup depth", "Shutoff depth"]
        }
        SectionKind::Orifices => vec![
            "Name",
            "From node",
            "To node",
            "Type",
            "Offset",
            "Discharge coefficient",
            "Flap gate",
            "Open/close time",
        ],
        SectionKind::Weirs => vec![
            "Name",
            "From node",
            "To node",
            "Type",
            "Crest height",
            "Discharge coefficient",
            "Flap gate",
            "End contractions",
            "End coefficient",
            "Can surcharge",
            "Road width",
            "Road surface",
            "Coefficient curve",
        ],
        SectionKind::Outlets => {
            let mut v = vec!["Name", "From node", "To node", "Offset", "Type"];
            if up(4).starts_with("TABULAR") {
                v.push("Rating curve");
            } else {
                v.extend(["Coefficient", "Exponent"]);
            }
            v.push("Flap gate");
            v
        }
        SectionKind::Xsections => match up(1).as_str() {
            "CUSTOM" => vec!["Link", "Shape", "Max depth", "Shape curve", "Barrels"],
            "IRREGULAR" => vec!["Link", "Shape", "Transect"],
            "STREET" => vec!["Link", "Shape", "Street"],
            _ => vec!["Link", "Shape", "Geom1 (depth)", "Geom2", "Geom3", "Geom4", "Barrels", "Culvert code"],
        },
        SectionKind::Losses => vec!["Link", "Entry loss", "Exit loss", "Average loss", "Flap gate", "Seepage rate"],
        SectionKind::Subcatchments => {
            vec!["Name", "Rain gage", "Outlet", "Area", "% Impervious", "Width", "% Slope", "Curb length", "Snow pack"]
        }
        SectionKind::Subareas => vec![
            "Subcatchment",
            "N-Imperv",
            "N-Perv",
            "Dstore-Imperv",
            "Dstore-Perv",
            "% Zero-Imperv",
            "Subarea routing",
            "% Routed",
        ],
        SectionKind::Infiltration => {
            // SWMM 5.2 lets a line override the model's method in its last token.
            let method = t
                .iter()
                .skip(1)
                .rev()
                .find(|s| s.parse::<f64>().is_err())
                .map(|s| s.to_ascii_uppercase())
                .unwrap_or_else(|| infiltration.to_ascii_uppercase());
            let mut v = vec!["Subcatchment"];
            if method.contains("GREEN") {
                v.extend(["Suction head", "Conductivity", "Initial deficit"]);
            } else if method.contains("CURVE") {
                v.extend(["Curve number", "Conductivity (unused)", "Drying time"]);
            } else {
                v.extend(["Max rate", "Min rate", "Decay constant", "Drying time", "Max volume"]);
            }
            let n = t.len().saturating_sub(1);
            if n >= v.len() && t.last().is_some_and(|s| s.parse::<f64>().is_err()) {
                while v.len() < n {
                    v.push("");
                }
                v.push("Method");
            }
            v
        }
        SectionKind::Raingages => {
            let mut v = vec!["Name", "Format", "Interval", "Snow catch factor", "Source"];
            if up(4) == "FILE" {
                v.extend(["File", "Station", "Units"]);
            } else {
                v.push("Time series");
            }
            v
        }
        SectionKind::Rdii => vec!["Node", "Unit hydrograph", "Sewershed area"],
        SectionKind::Inflows => vec![
            "Node",
            "Constituent",
            "Time series",
            "Type",
            "Units factor",
            "Scale factor",
            "Baseline",
            "Baseline pattern",
        ],
        SectionKind::Dwf => {
            vec!["Node", "Constituent", "Average value", "Pattern 1", "Pattern 2", "Pattern 3", "Pattern 4"]
        }
        SectionKind::Coordinates | SectionKind::Symbols => vec!["Name", "X", "Y"],
        _ => vec!["Name"],
    };
    let mut out: Vec<String> = names.drain(..).map(str::to_string).collect();
    for (i, name) in out.iter_mut().enumerate() {
        if name.is_empty() {
            *name = format!("Field {}", i + 1);
        }
    }
    while out.len() < t.len() {
        out.push(format!("Field {}", out.len() + 1));
    }
    out.truncate(t.len());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::SRC;

    fn group<'a>(g: &'a [PropertyGroup], title: &str) -> &'a PropertyGroup {
        g.iter().find(|x| x.title == title).unwrap_or_else(|| panic!("no {title} in {g:?}"))
    }

    #[test]
    fn node_properties() {
        let inp = InpFile::parse_str(SRC);
        let net = Network::from_inp(&inp);
        let g = properties(&inp, &net, ObjRef { kind: ObjKind::Node, index: 1 });
        let j = group(&g, "JUNCTIONS");
        assert_eq!(j.fields[1], ("Elevation".to_string(), "99".to_string()));
        assert_eq!(j.comment.as_deref(), Some("second"));
        assert_eq!(group(&g, "COORDINATES").fields[2].1, "0");
        let o = properties(&inp, &net, ObjRef { kind: ObjKind::Node, index: 2 });
        let f = &group(&o, "OUTFALLS").fields;
        assert_eq!(f[3], ("Fixed stage".to_string(), "98.2".to_string()));
        assert_eq!(f[4].0, "Flap gate");
        let s = properties(&inp, &net, ObjRef { kind: ObjKind::Node, index: 3 });
        assert_eq!(group(&s, "STORAGE").fields[5], ("Storage curve".to_string(), "SC1".to_string()));
    }

    #[test]
    fn link_and_subcatchment_properties() {
        let inp = InpFile::parse_str(SRC);
        let net = Network::from_inp(&inp);
        let c = properties(&inp, &net, ObjRef { kind: ObjKind::Link, index: 1 });
        assert_eq!(group(&c, "CONDUITS").fields.len(), 7);
        let x = &group(&c, "XSECTIONS").fields;
        assert_eq!(x[3], ("Shape curve".to_string(), "SH1".to_string()));
        let s = properties(&inp, &net, ObjRef { kind: ObjKind::Subcatchment, index: 0 });
        assert_eq!(group(&s, "INFILTRATION").fields[1].0, "Suction head");
        assert_eq!(group(&s, "SUBAREAS").fields[6].1, "OUTLET");
    }

    #[test]
    fn names_for_long_lines() {
        let n = field_names(&SectionKind::Unknown("X".into()), &["a", "b"], "HORTON");
        assert_eq!(n, ["Name", "Field 2"]);
        let n = field_names(&SectionKind::Infiltration, &["S1", "3", "0.5", "4", "7", "0", "HORTON"], "GREEN_AMPT");
        assert_eq!(n[1], "Max rate");
        assert_eq!(n[6], "Method");
    }
}
