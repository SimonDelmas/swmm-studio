//! The default mapping of the columns of a file to the variables of an object: by the
//! object's name in the column titles, then by the variable's name, its usual names
//! (English and French) or its unit.

use std::collections::BTreeMap;

/// Lower case, without accents, words split on anything that is not a letter or a digit.
fn words(s: &str) -> Vec<String> {
    let plain: String = s
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'à' | 'â' | 'ä' | 'á' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' | 'í' => 'i',
            'ô' | 'ö' | 'ó' => 'o',
            'ù' | 'û' | 'ü' | 'ú' => 'u',
            'ç' => 'c',
            '³' => '3',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect();
    plain.split_whitespace().map(str::to_string).collect()
}

/// Where `phrase` appears in `words`, as consecutive words.
fn find(words: &[String], phrase: &[String]) -> Option<usize> {
    if phrase.is_empty() || phrase.len() > words.len() {
        return None;
    }
    (0..=words.len() - phrase.len()).find(|&i| words[i..i + phrase.len()] == *phrase)
}

/// Usual names of a variable (besides its own).
fn synonyms(kind: &str, var: &str) -> &'static [&'static str] {
    const DEPTH: &[&str] = &["depth", "hauteur", "h", "tirant d eau", "tirant", "profondeur", "water depth", "y"];
    match (kind, var) {
        ("node", "depth") | ("link", "depth") => DEPTH,
        ("node", "head") => {
            &["head", "level", "niveau", "cote", "hgl", "wse", "water level", "elevation", "charge", "z"]
        }
        ("node", "volume") | ("link", "volume") => &["volume", "vol", "stockage", "storage"],
        ("node", "lateral_inflow") => &["lateral", "qlat", "apport", "apport lateral"],
        ("node", "total_inflow") => &["inflow", "flow", "debit", "q", "discharge"],
        ("node", "flooding") => &["flooding", "flood", "debordement", "overflow", "surverse"],
        ("link", "flow") => &["flow", "debit", "q", "discharge", "flow rate"],
        ("link", "velocity") => &["velocity", "vitesse", "v", "speed"],
        ("link", "capacity") => &["capacity", "capacite", "remplissage", "fill", "filling"],
        ("subcatchment", "rainfall") => {
            &["rain", "rainfall", "pluie", "precipitation", "precip", "intensity", "intensite", "p"]
        }
        ("subcatchment", "snow_depth") => &["snow", "neige"],
        ("subcatchment", "evaporation") => &["evap", "et"],
        ("subcatchment", "infiltration") => &["infil"],
        ("subcatchment", "runoff") => &["runoff", "ruissellement", "flow", "debit", "q"],
        ("subcatchment", "gw_outflow") => &["groundwater flow", "gw flow", "baseflow"],
        ("subcatchment", "gw_elevation") => &["groundwater", "gw", "nappe", "piezo", "water table"],
        ("subcatchment", "soil_moisture") => &["soil moisture", "moisture", "humidite", "theta"],
        _ => &[],
    }
}

/// Units written in a column title that say what the column is.
fn unit_hint(kind: &str, var: &str, title: &str) -> bool {
    let t = title.to_lowercase().replace(' ', "");
    let any = |units: &[&str]| units.iter().any(|u| t.contains(u));
    const FLOW: &[&str] =
        &["m3/s", "m³/s", "l/s", "(cms)", "(cfs)", "(mgd)", "(gpm)", "(lps)", "[cms]", "[cfs]", "m3/h"];
    match (kind, var) {
        ("link", "flow") | ("node", "total_inflow") | ("subcatchment", "runoff") => any(FLOW),
        ("link", "velocity") => any(&["m/s", "ft/s", "(fps)"]) && !any(FLOW),
        ("subcatchment", "rainfall") => any(&["mm/h", "mm/hr", "in/hr", "in/h"]),
        _ => false,
    }
}

/// The variable a file with a single series is for.
pub fn main_variable(kind: &str) -> &'static str {
    match kind {
        "link" => "flow",
        "subcatchment" => "runoff",
        _ => "depth",
    }
}

/// How well a column title (its words without the object's name) names a variable.
fn score(kind: &str, var: &str, title: &str, ws: &[String]) -> u32 {
    let own = words(var);
    if find(ws, &own).is_some() {
        return 10 + own.len() as u32;
    }
    let mut best = 0;
    for syn in synonyms(kind, var) {
        let p = words(syn);
        if find(ws, &p).is_some() {
            // Longer names are surer; one letter (`q`, `h`) only a little.
            best = best.max(if p.len() > 1 {
                8
            } else if syn.len() > 1 {
                6
            } else {
                4
            });
        }
    }
    if best == 0 && unit_hint(kind, var, title) {
        best = 2;
    }
    best
}

/// Default mapping `variable → column` of the value columns `columns` to the variables
/// `vars` of the object `id` of kind `kind` (`node`, `link`, `subcatchment`).
///
/// Columns whose title holds the object's name are taken first (a file with the series of
/// several objects); each column goes to one variable at most. A single candidate column
/// that names no variable goes to the object's main variable (depth, flow, runoff).
pub fn suggest(kind: &str, id: &str, vars: &[String], columns: &[String]) -> BTreeMap<String, String> {
    let id_words = words(id);
    let titled: Vec<(usize, Vec<String>)> = columns
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            let mut ws = words(c);
            let at = find(&ws, &id_words)?;
            ws.drain(at..at + id_words.len());
            Some((i, ws))
        })
        .collect();
    let candidates: Vec<(usize, Vec<String>)> =
        if titled.is_empty() { columns.iter().map(|c| words(c)).enumerate().collect() } else { titled };

    let mut pairs: Vec<(u32, usize, usize)> = Vec::new();
    for (vi, var) in vars.iter().enumerate() {
        for (ci, ws) in &candidates {
            let s = score(kind, var, &columns[*ci], ws);
            if s > 0 {
                pairs.push((s, vi, *ci));
            }
        }
    }
    // Best scores first, then variables and columns in their order.
    pairs.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut map = BTreeMap::new();
    let mut used = vec![false; columns.len()];
    for (_, vi, ci) in pairs {
        if used[ci] || map.contains_key(&vars[vi]) {
            continue;
        }
        used[ci] = true;
        map.insert(vars[vi].clone(), columns[ci].clone());
    }
    let main = main_variable(kind);
    if map.is_empty() && candidates.len() == 1 && vars.iter().any(|v| v == main) {
        map.insert(main.to_string(), columns[candidates[0].0].clone());
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn vars(kind: &str) -> Vec<String> {
        match kind {
            "node" => s(&["depth", "head", "volume", "lateral_inflow", "total_inflow", "flooding"]),
            "link" => s(&["flow", "depth", "velocity", "volume", "capacity"]),
            _ => s(&[
                "rainfall",
                "snow_depth",
                "evaporation",
                "infiltration",
                "runoff",
                "gw_outflow",
                "gw_elevation",
                "soil_moisture",
            ]),
        }
    }

    fn m(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn by_variable_names() {
        let cols = s(&["Débit (l/s)", "Hauteur (m)", "Vitesse (m/s)", "Température"]);
        assert_eq!(
            suggest("link", "C1", &vars("link"), &cols),
            m(&[("flow", "Débit (l/s)"), ("depth", "Hauteur (m)"), ("velocity", "Vitesse (m/s)")])
        );
        let cols = s(&["Q", "H"]);
        assert_eq!(suggest("link", "C1", &vars("link"), &cols), m(&[("flow", "Q"), ("depth", "H")]));
        // Own names win over usual ones: `lateral_inflow` is not `total_inflow`.
        let cols = s(&["lateral inflow", "total_inflow", "level"]);
        assert_eq!(
            suggest("node", "J1", &vars("node"), &cols),
            m(&[("lateral_inflow", "lateral inflow"), ("total_inflow", "total_inflow"), ("head", "level")])
        );
    }

    #[test]
    fn by_object_name() {
        let cols = s(&["C1_flow", "C1_depth", "C2_flow", "C2_depth"]);
        assert_eq!(suggest("link", "C2", &vars("link"), &cols), m(&[("flow", "C2_flow"), ("depth", "C2_depth")]));
        // One column for the object, named by it only: its main variable.
        let cols = s(&["S1", "S2"]);
        assert_eq!(suggest("subcatchment", "S2", &vars("subcatchment"), &cols), m(&[("runoff", "S2")]));
        let cols = s(&["J1", "J2"]);
        assert_eq!(suggest("node", "J3", &vars("node"), &cols), m(&[]));
    }

    #[test]
    fn single_series() {
        assert_eq!(suggest("node", "J1", &vars("node"), &s(&["valeur"])), m(&[("depth", "valeur")]));
        assert_eq!(
            suggest("subcatchment", "S1", &vars("subcatchment"), &s(&["Pluie mm/h"])),
            m(&[("rainfall", "Pluie mm/h")])
        );
    }
}
