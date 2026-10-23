//! Numeric input attributes of every object of a kind, for thematic maps.

use swmm_inp::{InpFile, SectionKind};

use crate::{LinkType, Network, ObjKind};

/// Attributes available for a kind of object.
pub fn attribute_names(kind: ObjKind) -> &'static [&'static str] {
    match kind {
        ObjKind::Node => &["invert_elevation", "max_depth", "rim_elevation"],
        ObjKind::Link => &["length", "roughness", "geom1", "slope"],
        ObjKind::Subcatchment => &["area", "imperviousness", "width", "slope"],
        ObjKind::Gage => &[],
    }
}

/// Values of an attribute for every object of a kind (NaN where it does not apply).
pub fn attribute(inp: &InpFile, net: &Network, kind: ObjKind, name: &str) -> Option<Vec<f32>> {
    let mut v = vec![f32::NAN; net.len(kind)];
    // Section that defines object `i` (a duplicate ID in another section is ignored).
    let defined_in = |i: u32, section: &SectionKind| match kind {
        ObjKind::Node => net.nodes[i as usize].kind.section() == *section,
        ObjKind::Link => *section == SectionKind::Xsections || net.links[i as usize].kind.section() == *section,
        _ => true,
    };
    // Fills `v` from column `col` of a section's lines.
    let fill = |v: &mut Vec<f32>, section: SectionKind, col: usize| {
        for l in inp.rows(&section) {
            let i = l.token(0).and_then(|id| net.find(kind, id)).filter(|&i| defined_in(i, &section));
            if let (Some(i), Some(x)) = (i, l.token(col).and_then(|x| x.parse::<f32>().ok())) {
                v[i as usize] = x;
            }
        }
    };
    match (kind, name) {
        (ObjKind::Node, "invert_elevation") => {
            for s in [SectionKind::Junctions, SectionKind::Outfalls, SectionKind::Dividers, SectionKind::Storage] {
                fill(&mut v, s, 1);
            }
        }
        (ObjKind::Node, "max_depth" | "rim_elevation") => {
            fill(&mut v, SectionKind::Junctions, 2);
            fill(&mut v, SectionKind::Storage, 2);
            if name == "rim_elevation" {
                let inv = attribute(inp, net, kind, "invert_elevation")?;
                v.iter_mut().zip(inv).for_each(|(d, e)| *d += e);
            }
        }
        (ObjKind::Link, "length") => fill(&mut v, SectionKind::Conduits, 3),
        (ObjKind::Link, "roughness") => fill(&mut v, SectionKind::Conduits, 4),
        (ObjKind::Link, "geom1") => fill(&mut v, SectionKind::Xsections, 2),
        (ObjKind::Link, "slope") => {
            let inv = attribute(inp, net, ObjKind::Node, "invert_elevation")?;
            let elevation_offsets = inp.option("LINK_OFFSETS").is_some_and(|o| o.eq_ignore_ascii_case("ELEVATION"));
            for l in inp.rows(&SectionKind::Conduits) {
                let Some(i) = l.token(0).and_then(|id| net.find(kind, id)) else { continue };
                let link = &net.links[i as usize];
                if link.kind != LinkType::Conduit {
                    continue;
                }
                let num = |k: usize| l.token(k).and_then(|x| x.parse::<f32>().ok());
                let (Some(from), Some(to), Some(len)) = (link.from, link.to, num(3)) else { continue };
                let (o1, o2) = (num(5).unwrap_or(0.0), num(6).unwrap_or(0.0));
                let (z1, z2) =
                    if elevation_offsets { (o1, o2) } else { (inv[from as usize] + o1, inv[to as usize] + o2) };
                if len > 0.0 {
                    v[i as usize] = (z1 - z2) / len;
                }
            }
        }
        (ObjKind::Subcatchment, "area") => fill(&mut v, SectionKind::Subcatchments, 3),
        (ObjKind::Subcatchment, "imperviousness") => fill(&mut v, SectionKind::Subcatchments, 4),
        (ObjKind::Subcatchment, "width") => fill(&mut v, SectionKind::Subcatchments, 5),
        (ObjKind::Subcatchment, "slope") => fill(&mut v, SectionKind::Subcatchments, 6),
        _ => return None,
    }
    Some(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::SRC;

    #[test]
    fn attributes() {
        let inp = InpFile::parse_str(SRC);
        let net = Network::from_inp(&inp);
        let inv = attribute(&inp, &net, ObjKind::Node, "invert_elevation").unwrap();
        assert_eq!(inv, vec![100.0, 99.0, 97.0, 95.0]);
        let rim = attribute(&inp, &net, ObjKind::Node, "rim_elevation").unwrap();
        assert_eq!(rim[0], 102.5);
        assert!(rim[2].is_nan());
        let slope = attribute(&inp, &net, ObjKind::Link, "slope").unwrap();
        assert!((slope[0] - 1.0 / 120.0).abs() < 1e-6);
        assert!((slope[1] - (99.0 - 97.1) / 50.0).abs() < 1e-6);
        assert!(slope[2].is_nan());
        assert_eq!(attribute(&inp, &net, ObjKind::Link, "geom1").unwrap()[0], 0.4);
        assert_eq!(attribute(&inp, &net, ObjKind::Subcatchment, "area").unwrap()[0], 2.5);
        assert!(attribute(&inp, &net, ObjKind::Node, "nope").is_none());
        for k in ObjKind::ALL {
            for n in attribute_names(k) {
                assert!(attribute(&inp, &net, k, n).is_some(), "{k:?} {n}");
            }
        }
    }
}
