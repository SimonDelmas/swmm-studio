//! Named fields of an object, read from every `.inp` section that describes it.

use serde::Serialize;
use swmm_inp::{InpFile, Line, SectionKind};

use crate::schema::{self, Context, FieldType};
use crate::{LinkType, Network, ObjKind, ObjRef};

/// One field of a line.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Field {
    pub name: String,
    pub value: String,
    /// Key of the field in the schema (`None` for tokens past the known layout).
    pub key: Option<String>,
    #[serde(flatten)]
    pub ty: FieldType,
    /// Unit label in the model's units (`ft`, `ha`, `LPS`…), empty when none.
    pub unit: String,
    /// Value written when the field is filled in automatically.
    pub default: String,
    pub required: bool,
    /// The token is in the file (optional trailing fields may be missing).
    pub present: bool,
}

/// One `.inp` line describing the object, as named fields.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PropertyGroup {
    /// Section name, e.g. `JUNCTIONS`, `INFLOWS (FLOW)`.
    pub title: String,
    /// Section of the line, e.g. `INFLOWS`.
    pub section: String,
    /// First tokens that identify the line in its section.
    pub key: Vec<String>,
    pub fields: Vec<Field>,
    /// Inline comment of the line.
    pub comment: Option<String>,
    /// The fields can be edited (the section has a schema).
    pub editable: bool,
    /// The line is optional and can be removed.
    pub removable: bool,
}

/// An optional line the object does not have yet.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Addable {
    pub title: String,
    pub section: String,
    pub key: Vec<String>,
}

fn sections_of(inp: &InpFile, net: &Network, r: ObjRef) -> Vec<SectionKind> {
    let _ = inp;
    match r.kind {
        ObjKind::Node => {
            let main = net.nodes[r.index as usize].kind.section();
            vec![main, SectionKind::Coordinates, SectionKind::Inflows, SectionKind::Dwf, SectionKind::Rdii]
        }
        ObjKind::Link => {
            let main = net.links[r.index as usize].kind.section();
            vec![main, SectionKind::Xsections, SectionKind::Losses, SectionKind::Vertices]
        }
        ObjKind::Subcatchment => vec![
            SectionKind::Subcatchments,
            SectionKind::Subareas,
            SectionKind::Infiltration,
            SectionKind::LidUsage,
            SectionKind::Groundwater,
            SectionKind::Gwf,
            SectionKind::Coverages,
        ],
        ObjKind::Gage => vec![SectionKind::Raingages, SectionKind::Symbols],
    }
}

fn removable(kind: &SectionKind) -> bool {
    matches!(
        kind,
        SectionKind::Inflows
            | SectionKind::Dwf
            | SectionKind::Rdii
            | SectionKind::Losses
            | SectionKind::Tags
            | SectionKind::Groundwater
            | SectionKind::Gwf
    )
}

/// Fields of one line: its tokens named by the schema, then the optional fields it
/// does not have.
pub fn fields_of(kind: &SectionKind, tokens: &[&str], inp: &InpFile) -> (Vec<Field>, bool) {
    // A groundwater flow expression is one field, however many tokens it has.
    let joined;
    let tokens = if *kind == SectionKind::Gwf && tokens.len() > 3 {
        joined = tokens[2..].join(" ");
        &[tokens[0], tokens[1], joined.as_str()][..]
    } else {
        tokens
    };
    let flow = inp.flow_units();
    let ctx = Context::of(inp);
    let Some(defs) = schema::layout(kind, tokens, &ctx) else {
        let names = field_names(kind, tokens, &ctx.infiltration);
        let fields = names
            .into_iter()
            .zip(tokens)
            .map(|(name, v)| Field {
                name,
                value: v.to_string(),
                key: None,
                ty: FieldType::Text,
                unit: String::new(),
                default: String::new(),
                required: false,
                present: true,
            })
            .collect();
        return (fields, false);
    };
    // A trailing infiltration method is shown last, after the parameters.
    let (body, method) = schema::split_method(kind, tokens);
    let mut out: Vec<Field> = Vec::new();
    for (i, d) in defs.iter().enumerate() {
        out.push(Field {
            name: d.name.to_string(),
            value: body.get(i).map_or(String::new(), |s| s.to_string()),
            key: Some(d.key.to_string()),
            ty: d.ty.clone(),
            unit: d.unit.label(flow).to_string(),
            default: d.default.to_string(),
            required: d.required,
            present: i < body.len(),
        });
    }
    for (i, v) in body.iter().enumerate().skip(defs.len()) {
        out.push(Field {
            name: format!("Field {}", i + 1),
            value: v.to_string(),
            key: None,
            ty: FieldType::Text,
            unit: String::new(),
            default: String::new(),
            required: false,
            present: true,
        });
    }
    if let Some(m) = method {
        out.push(Field {
            name: "Method".into(),
            value: m.to_string(),
            key: None,
            ty: FieldType::Text,
            unit: String::new(),
            default: String::new(),
            required: false,
            present: true,
        });
    }
    (out, true)
}

/// All properties of an object, grouped by section, in a fixed order.
pub fn properties(inp: &InpFile, net: &Network, r: ObjRef) -> Vec<PropertyGroup> {
    let id = net.id(r).to_string();
    let mut out = Vec::new();
    for kind in &sections_of(inp, net, r) {
        let lines: Vec<&Line> =
            inp.rows(kind).filter(|l| l.token(0).is_some_and(|t| t.eq_ignore_ascii_case(&id))).collect();
        // Vertices are edited on the map; show how many there are.
        if *kind == SectionKind::Vertices {
            if !lines.is_empty() {
                out.push(PropertyGroup {
                    title: "VERTICES".into(),
                    section: "VERTICES".into(),
                    key: vec![id.clone()],
                    fields: vec![Field {
                        name: "Vertices".into(),
                        value: lines.len().to_string(),
                        key: None,
                        ty: FieldType::Text,
                        unit: String::new(),
                        default: String::new(),
                        required: false,
                        present: true,
                    }],
                    comment: None,
                    editable: false,
                    removable: false,
                });
            }
            continue;
        }
        let key_len = schema::key_len(kind);
        for l in lines {
            let tokens: Vec<&str> = l.tokens().collect();
            let (fields, editable) = fields_of(kind, &tokens, inp);
            let mut title = kind.name().to_string();
            if matches!(kind, SectionKind::Inflows | SectionKind::Dwf | SectionKind::Gwf) {
                title = format!("{title} ({})", tokens.get(1).unwrap_or(&""));
            }
            out.push(PropertyGroup {
                title,
                section: kind.name().to_string(),
                key: tokens.iter().take(key_len).map(|s| s.to_string()).collect(),
                fields,
                comment: l.comment().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
                editable,
                removable: removable(kind),
            });
        }
    }
    let tag_type = match r.kind {
        ObjKind::Node => "Node",
        ObjKind::Link => "Link",
        ObjKind::Subcatchment => "Subcatch",
        ObjKind::Gage => "",
    };
    if let Some(l) = inp.rows(&SectionKind::Tags).find(|l| {
        l.token(0).is_some_and(|t| t.eq_ignore_ascii_case(tag_type))
            && l.token(1).is_some_and(|t| t.eq_ignore_ascii_case(&id))
    }) {
        out.push(PropertyGroup {
            title: "TAGS".into(),
            section: "TAGS".into(),
            key: l.tokens().take(2).map(str::to_string).collect(),
            fields: vec![Field {
                name: "Tag".into(),
                value: l.token(2).unwrap_or("").to_string(),
                key: Some("tag".into()),
                ty: FieldType::Text,
                unit: String::new(),
                default: String::new(),
                required: true,
                present: true,
            }],
            comment: None,
            editable: false,
            removable: true,
        });
    }
    out
}

/// Optional lines an object could have but does not.
pub fn addable(inp: &InpFile, net: &Network, r: ObjRef) -> Vec<Addable> {
    let id = net.id(r).to_string();
    let has = |kind: &SectionKind, key: &[&str]| crate::ops::find_line(inp, kind, key).is_some();
    let mut out = Vec::new();
    let mut add = |title: &str, kind: SectionKind, key: Vec<String>| {
        out.push(Addable { title: title.into(), section: kind.name().into(), key })
    };
    match r.kind {
        ObjKind::Node => {
            if !has(&SectionKind::Inflows, &[&id, "FLOW"]) {
                add("Direct inflow", SectionKind::Inflows, vec![id.clone(), "FLOW".into()]);
            }
            if !has(&SectionKind::Dwf, &[&id, "FLOW"]) {
                add("Dry weather flow", SectionKind::Dwf, vec![id.clone(), "FLOW".into()]);
            }
            if !has(&SectionKind::Rdii, &[&id]) {
                add("RDII inflow", SectionKind::Rdii, vec![id.clone()]);
            }
        }
        ObjKind::Link => {
            let ty = net.links[r.index as usize].kind;
            if matches!(ty, LinkType::Conduit | LinkType::Orifice | LinkType::Weir)
                && !has(&SectionKind::Xsections, &[&id])
            {
                add("Cross-section", SectionKind::Xsections, vec![id.clone()]);
            }
            if ty == LinkType::Conduit && !has(&SectionKind::Losses, &[&id]) {
                add("Losses", SectionKind::Losses, vec![id.clone()]);
            }
        }
        ObjKind::Subcatchment => {
            if !has(&SectionKind::Subareas, &[&id]) {
                add("Subareas", SectionKind::Subareas, vec![id.clone()]);
            }
            if !has(&SectionKind::Infiltration, &[&id]) {
                add("Infiltration", SectionKind::Infiltration, vec![id.clone()]);
            }
            if !has(&SectionKind::Groundwater, &[&id]) {
                add("Groundwater", SectionKind::Groundwater, vec![id.clone()]);
            } else {
                // Custom flow equations replace the standard ones of a subcatchment with groundwater.
                for (ty, title) in [("LATERAL", "Lateral flow equation"), ("DEEP", "Deep flow equation")] {
                    if !has(&SectionKind::Gwf, &[&id, ty]) {
                        add(title, SectionKind::Gwf, vec![id.clone(), ty.into()]);
                    }
                }
            }
        }
        ObjKind::Gage => {}
    }
    out
}

/// Field names for the tokens of a line. Lines longer than the known layout get
/// `Field N` names for the extra tokens.
pub fn field_names(kind: &SectionKind, t: &[&str], infiltration: &str) -> Vec<String> {
    let ctx = Context { infiltration: infiltration.to_ascii_uppercase() };
    let mut out: Vec<String> = match schema::layout(kind, t, &ctx) {
        Some(defs) => defs.iter().map(|d| d.name.to_string()).collect(),
        None => vec!["Name".to_string()],
    };
    if schema::split_method(kind, t).1.is_some() {
        out.truncate(t.len() - 1);
        while out.len() < t.len() - 1 {
            out.push(format!("Field {}", out.len() + 1));
        }
        out.push("Method".into());
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

    fn fv(g: &PropertyGroup, i: usize) -> (&str, &str) {
        (g.fields[i].name.as_str(), g.fields[i].value.as_str())
    }

    #[test]
    fn node_properties() {
        let inp = InpFile::parse_str(SRC);
        let net = Network::from_inp(&inp);
        let g = properties(&inp, &net, ObjRef { kind: ObjKind::Node, index: 1 });
        let j = group(&g, "JUNCTIONS");
        assert_eq!(fv(j, 1), ("Invert elevation", "99"));
        assert_eq!(j.fields[1].unit, "m");
        assert_eq!(j.comment.as_deref(), Some("second"));
        assert_eq!(
            (j.section.as_str(), j.key.clone(), j.editable, j.removable),
            ("JUNCTIONS", vec!["j2".to_string()], true, false)
        );
        assert_eq!(group(&g, "COORDINATES").fields[2].value, "0");
        let o = properties(&inp, &net, ObjRef { kind: ObjKind::Node, index: 2 });
        let f = group(&o, "OUTFALLS");
        assert_eq!(fv(f, 3), ("Fixed stage", "98.2"));
        assert_eq!(f.fields[4].name, "Flap gate");
        // Optional "Route to" shown but not in the file.
        assert!(!f.fields[5].present);
        let s = properties(&inp, &net, ObjRef { kind: ObjKind::Node, index: 3 });
        assert_eq!(fv(group(&s, "STORAGE"), 5), ("Storage curve", "SC1"));
        let add = addable(&inp, &net, ObjRef { kind: ObjKind::Node, index: 1 });
        assert_eq!(add.iter().map(|a| a.section.as_str()).collect::<Vec<_>>(), ["INFLOWS", "DWF", "RDII"]);
    }

    #[test]
    fn link_and_subcatchment_properties() {
        let inp = InpFile::parse_str(SRC);
        let net = Network::from_inp(&inp);
        let c = properties(&inp, &net, ObjRef { kind: ObjKind::Link, index: 1 });
        let main = group(&c, "CONDUITS");
        assert_eq!(main.fields.iter().filter(|f| f.present).count(), 7);
        assert_eq!(main.fields[3].unit, "m");
        let x = group(&c, "XSECTIONS");
        assert_eq!(fv(x, 3), ("Shape curve", "SH1"));
        assert_eq!(group(&c, "VERTICES").fields[0].value, "2");
        let s = properties(&inp, &net, ObjRef { kind: ObjKind::Subcatchment, index: 0 });
        assert_eq!(group(&s, "INFILTRATION").fields[1].name, "Suction head");
        assert_eq!(group(&s, "SUBAREAS").fields[6].value, "OUTLET");
        assert_eq!(group(&s, "SUBCATCHMENTS").fields[3].unit, "ha");
        assert!(addable(&inp, &net, ObjRef { kind: ObjKind::Link, index: 0 }).iter().any(|a| a.section == "LOSSES"));
    }

    #[test]
    fn names_for_long_lines() {
        let n = field_names(&SectionKind::Unknown("X".into()), &["a", "b"], "HORTON");
        assert_eq!(n, ["Name", "Field 2"]);
        let n = field_names(&SectionKind::Infiltration, &["S1", "3", "0.5", "4", "7", "0", "HORTON"], "GREEN_AMPT");
        assert_eq!(n[1], "Max infiltration rate");
        assert_eq!(n[6], "Method");
    }
}

#[cfg(test)]
mod groundwater_tests {
    use super::*;
    use crate::edit::History;

    const SRC: &str = "\
[OPTIONS]
FLOW_UNITS CMS
[SUBCATCHMENTS]
S1 * J1 1 50 100 1 0
S2 * J1 1 50 100 1 0
[JUNCTIONS]
J1 1
[AQUIFERS]
A1 0.5 0.15 0.3 5 10 15 0.35 14 0.002 0 10 0.3
[GROUNDWATER]
S1 A1 J1 10 0.001 2 0 0 0 0
[GWF]
S1 LATERAL 0.001 * (Hgw - Hcb) ^ 1.5
";

    #[test]
    fn groundwater_properties_and_edits() {
        let mut inp = InpFile::parse_str(SRC);
        let net = Network::from_inp(&inp);
        let s1 = ObjRef { kind: ObjKind::Subcatchment, index: 0 };
        let g = properties(&inp, &net, s1);
        let gw = g.iter().find(|x| x.section == "GROUNDWATER").unwrap();
        assert!(gw.editable && gw.removable);
        assert_eq!((gw.fields[1].name.as_str(), gw.fields[1].value.as_str()), ("Aquifer", "A1"));
        assert_eq!(gw.fields[3].unit, "m");
        assert!(!gw.fields[10].present);
        let gwf = g.iter().find(|x| x.section == "GWF").unwrap();
        assert_eq!(gwf.title, "GWF (LATERAL)");
        assert_eq!(gwf.key, ["S1", "LATERAL"]);
        assert_eq!(gwf.fields.len(), 3);
        assert_eq!(gwf.fields[2].value, "0.001 * (Hgw - Hcb) ^ 1.5");
        let add: Vec<String> =
            addable(&inp, &net, s1).into_iter().filter(|a| a.section == "GWF").map(|a| a.key.join(" ")).collect();
        assert_eq!(add, ["S1 DEEP"]);
        let add: Vec<String> = addable(&inp, &net, ObjRef { kind: ObjKind::Subcatchment, index: 1 })
            .into_iter()
            .map(|a| a.section)
            .collect();
        assert_eq!(add, ["SUBAREAS", "INFILTRATION", "GROUNDWATER"]);

        let mut h = History::default();
        let key = |k: &[&str]| k.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        h.edit(&mut inp, "e", |tx| {
            crate::ops::set_field(tx, &SectionKind::Gwf, &key(&["S1", "LATERAL"]), 2, "0.002*Hgw")
        })
        .unwrap();
        // The optional values after the fixed depth are written as `*` up to the one set.
        h.edit(&mut inp, "e", |tx| crate::ops::set_field(tx, &SectionKind::Groundwater, &key(&["S1"]), 12, "6"))
            .unwrap();
        h.edit(&mut inp, "e", |tx| crate::ops::add_line(tx, &SectionKind::Gwf, &key(&["S1", "DEEP"]))).unwrap();
        h.edit(&mut inp, "e", |tx| crate::ops::add_line(tx, &SectionKind::Groundwater, &key(&["S2"]))).unwrap();
        let text = inp.to_string_lossy();
        assert!(text.contains("S1               LATERAL    0.002*Hgw\n"), "{text}");
        let line = |t: &str| text.lines().any(|l| l.split_whitespace().eq(t.split(' ')));
        assert!(line("S1 A1 J1 10 0.001 2 0 0 0 0 * * 6"), "{text}");
        assert!(line("S1 DEEP 0"), "{text}");
        assert!(line("S2 * * 0 0 0 0 0 0 0"), "{text}");
        assert!(h
            .edit(&mut inp, "e", |tx| crate::ops::set_field(tx, &SectionKind::Groundwater, &key(&["S1"]), 4, "*"))
            .is_err());
        // An aquifer and a node are required.
        let issues = crate::validate::validate(&inp, &Network::from_inp(&inp));
        let missing: Vec<&str> =
            issues.iter().filter(|i| i.code == "missing_reference").map(|i| i.message.as_str()).collect();
        assert_eq!(missing.len(), 2, "{missing:?}");
    }
}
