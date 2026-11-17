//! Units of observed series, converted to those of the model's results: flows, lengths,
//! velocities, volumes, rain and evaporation rates, fractions.

/// A unit: its label (as SWMM writes it, when SWMM has it), its value in the base unit of
/// its quantity, and other ways to write it in a column title.
struct Unit {
    label: &'static str,
    factor: f64,
    aliases: &'static [&'static str],
}

const fn u(label: &'static str, factor: f64, aliases: &'static [&'static str]) -> Unit {
    Unit { label, factor, aliases }
}

const FT3: f64 = 0.028_316_846_592;

/// Units of each quantity; the base units are m³/s, m, m/s, m³, mm/hr, mm/day and 1.
const QUANTITIES: &[&[Unit]] = &[
    &[
        u("CMS", 1.0, &["m3/s", "cms"]),
        u("LPS", 1e-3, &["l/s", "lps"]),
        u("m3/h", 1.0 / 3600.0, &["m3/hr"]),
        u("MLD", 1000.0 / 86400.0, &["ml/d", "mld"]),
        u("CFS", FT3, &["ft3/s", "cfs"]),
        u("GPM", 6.309_019_64e-5, &["gpm"]),
        u("MGD", 0.043_812_636_4, &["mgd"]),
    ],
    &[
        u("m", 1.0, &[]),
        u("cm", 0.01, &[]),
        u("mm", 0.001, &[]),
        u("ft", 0.3048, &["feet"]),
        u("in", 0.0254, &["inch", "inches"]),
    ],
    &[u("m/s", 1.0, &[]), u("cm/s", 0.01, &[]), u("ft/s", 0.3048, &["fps"])],
    &[u("m3", 1.0, &[]), u("L", 0.001, &["l", "litre", "liter"]), u("ft3", FT3, &[])],
    &[u("mm/hr", 1.0, &["mm/h"]), u("mm/min", 60.0, &[]), u("in/hr", 25.4, &["in/h"])],
    &[u("mm/day", 1.0, &["mm/d", "mm/j"]), u("in/day", 25.4, &["in/d"])],
    &[u("fraction", 1.0, &[]), u("%", 0.01, &["percent", "pct"])],
];

fn find(label: &str) -> Option<(&'static [Unit], &'static Unit)> {
    QUANTITIES.iter().find_map(|q| q.iter().find(|x| x.label.eq_ignore_ascii_case(label)).map(|x| (*q, x)))
}

/// The units a series of variable of unit `model` can be in (the model's unit first); none
/// when `model` is not a known unit (pollutants).
pub fn options(model: &str) -> Vec<&'static str> {
    match find(model) {
        Some((q, own)) => {
            std::iter::once(own.label).chain(q.iter().map(|x| x.label).filter(|l| *l != own.label)).collect()
        }
        None => Vec::new(),
    }
}

/// What to multiply values in unit `from` by to get them in unit `to` (none: not the same
/// quantity, or a unit not known).
pub fn factor(from: &str, to: &str) -> Option<f64> {
    if from.eq_ignore_ascii_case(to) {
        return Some(1.0);
    }
    let (qa, a) = find(from)?;
    let (qb, b) = find(to)?;
    std::ptr::eq(qa, qb).then(|| a.factor / b.factor)
}

fn plain(s: &str) -> String {
    s.trim().to_lowercase().replace('³', "3").replace(' ', "")
}

/// The unit written in a column title: between brackets (`Débit (l/s)`, `H [m]`) or as its
/// last word (`Q m3/s`).
pub fn from_title(title: &str) -> Option<&'static str> {
    let mut candidates: Vec<&str> = Vec::new();
    for (open, close) in [('(', ')'), ('[', ']')] {
        let mut rest = title;
        while let Some(i) = rest.find(open) {
            let after = &rest[i + 1..];
            let Some(j) = after.find(close) else { break };
            candidates.push(&after[..j]);
            rest = &after[j + 1..];
        }
    }
    if let Some(last) = title.split_whitespace().last().filter(|_| title.split_whitespace().count() > 1) {
        candidates.push(last);
    }
    candidates.iter().map(|c| plain(c)).find_map(|c| {
        QUANTITIES
            .iter()
            .flat_map(|q| q.iter())
            .find(|x| plain(x.label) == c || x.aliases.iter().any(|a| plain(a) == c))
            .map(|x| x.label)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: Option<f64>, b: f64) -> bool {
        a.is_some_and(|a| (a - b).abs() <= 1e-9 * b.abs().max(1.0))
    }

    #[test]
    fn conversions() {
        assert!(close(factor("LPS", "CMS"), 1e-3));
        assert!(close(factor("m3/h", "LPS"), 1.0 / 3.6));
        assert!(close(factor("CFS", "LPS"), 28.316_846_592));
        assert!(close(factor("cm", "m"), 0.01));
        assert!(close(factor("mm", "ft"), 0.001 / 0.3048));
        assert!(close(factor("in/hr", "mm/hr"), 25.4));
        assert!(close(factor("%", "fraction"), 0.01));
        assert!(close(factor("concentration", "concentration"), 1.0));
        assert_eq!(factor("m", "LPS"), None);
        assert_eq!(factor("mg/L", "concentration"), None);
    }

    #[test]
    fn choices() {
        assert_eq!(options("LPS")[..3], ["LPS", "CMS", "m3/h"]);
        assert_eq!(options("ft"), ["ft", "m", "cm", "mm", "in"]);
        assert!(options("concentration").is_empty());
    }

    #[test]
    fn titles() {
        assert_eq!(from_title("Débit (l/s)"), Some("LPS"));
        assert_eq!(from_title("Q [m³/s]"), Some("CMS"));
        assert_eq!(from_title("C1 Hauteur (cm)"), Some("cm"));
        assert_eq!(from_title("Pluie mm/h"), Some("mm/hr"));
        assert_eq!(from_title("Remplissage (%)"), Some("%"));
        assert_eq!(from_title("C1 flow"), None);
        assert_eq!(from_title("mm"), None);
    }
}
