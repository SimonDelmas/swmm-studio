//! EPSG registry and reprojection of model coordinates (pure Rust, no PROJ install).

use std::sync::OnceLock;

use proj4rs::proj::Proj;
use proj4rs::transform::transform;

use crate::GeoError;

const WGS84: &str = "+proj=longlat +datum=WGS84 +no_defs";

/// Kind of coordinate system, from the WKT definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrsKind {
    Projected,
    Geographic,
    /// Horizontal + vertical (`COMPD_CS`).
    Compound,
    Other,
}

/// An EPSG entry of the registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrsInfo {
    pub code: u16,
    pub name: String,
    pub kind: CrsKind,
}

impl CrsInfo {
    /// `EPSG:<code>`.
    pub fn id(&self) -> String {
        format!("EPSG:{}", self.code)
    }
}

fn info_of(def: &crs_definitions::Def) -> CrsInfo {
    let wkt = def.wkt;
    let kind = match wkt.split('[').next().unwrap_or("") {
        "PROJCS" => CrsKind::Projected,
        "GEOGCS" => CrsKind::Geographic,
        "COMPD_CS" => CrsKind::Compound,
        _ => CrsKind::Other,
    };
    let name = wkt.split('"').nth(1).unwrap_or("").to_string();
    CrsInfo { code: def.code, name, kind }
}

/// Every EPSG definition, built once (the registry has no list, only a lookup by code).
fn registry() -> &'static [CrsInfo] {
    static ALL: OnceLock<Vec<CrsInfo>> = OnceLock::new();
    ALL.get_or_init(|| (0..=u16::MAX).filter_map(crs_definitions::from_code).map(|d| info_of(&d)).collect())
}

/// Coordinate system suggested by the extent of a model's coordinates
/// (`[min_x, min_y, max_x, max_y]`): degrees, or French Lambert 93. A guess, to be
/// confirmed by the user.
pub fn guess(b: [f64; 4]) -> Option<CrsInfo> {
    let degrees = b[0] >= -180.0 && b[2] <= 180.0 && b[1] >= -90.0 && b[3] <= 90.0 && b[2] - b[0] < 20.0;
    let lambert_93 = b[0] > 50_000.0 && b[2] < 1_300_000.0 && b[1] > 6_000_000.0 && b[3] < 7_200_000.0;
    if degrees {
        lookup(4326)
    } else if lambert_93 {
        lookup(2154)
    } else {
        None
    }
}

/// Registry entry for an EPSG code.
pub fn lookup(code: u16) -> Option<CrsInfo> {
    crs_definitions::from_code(code).map(|d| info_of(&d))
}

/// Searches the registry by code prefix (`"2154"`, `"EPSG:394"`) or by words of the name
/// (`"lambert 93"`, `"cc44"`). Projected systems come first.
pub fn search(query: &str, limit: usize) -> Vec<CrsInfo> {
    let q = query.trim();
    let q = q.strip_prefix("EPSG:").or_else(|| q.strip_prefix("epsg:")).unwrap_or(q).trim();
    if q.is_empty() {
        return Vec::new();
    }
    let usable = |c: &&CrsInfo| matches!(c.kind, CrsKind::Projected | CrsKind::Geographic);
    let mut hits: Vec<&CrsInfo> = if q.chars().all(|c| c.is_ascii_digit()) {
        registry().iter().filter(usable).filter(|c| c.code.to_string().starts_with(q)).collect()
    } else {
        let words: Vec<String> = q.split_whitespace().map(normalize).collect();
        registry()
            .iter()
            .filter(usable)
            .filter(|c| {
                let name = normalize(&c.name);
                words.iter().all(|w| name.contains(w.as_str()))
            })
            .collect()
    };
    hits.sort_by_key(|c| (c.kind != CrsKind::Projected, c.code.to_string().len(), c.code));
    hits.into_iter().take(limit).cloned().collect()
}

/// Lower case, separators removed, so that `Lambert-93`, `lambert 93` and `CC44` match.
fn normalize(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Prime meridians PROJ knows by name, in degrees east of Greenwich.
const PRIME_MERIDIANS: [(&str, f64); 13] = [
    ("greenwich", 0.0),
    ("lisbon", -9.131_906_111_111),
    ("paris", 2.337_229_166_667),
    ("bogota", -74.080_916_666_667),
    ("madrid", -3.687_938_888_889),
    ("rome", 12.452_333_333_333),
    ("bern", 7.439_583_333_333),
    ("jakarta", 106.807_719_444_444),
    ("ferro", -17.666_666_666_667),
    ("brussels", 4.367_975),
    ("stockholm", 18.058_277_777_778),
    ("athens", 23.716_337_5),
    ("oslo", 10.722_916_666_667),
];

/// A coordinate system the model coordinates can be converted from.
pub struct Crs {
    /// As given by the user: `EPSG:2154` or a PROJ string.
    pub id: String,
    pub name: String,
    /// PROJ definition the projection was built from.
    definition: String,
    proj: Proj,
    wgs84: Proj,
}

impl std::fmt::Debug for Crs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Crs").field("id", &self.id).field("name", &self.name).finish()
    }
}

impl Crs {
    /// Parses `EPSG:2154`, `2154` or a PROJ string (`+proj=lcc ...`).
    pub fn parse(s: &str) -> Result<Crs, GeoError> {
        let t = s.trim();
        let wgs84 = Proj::from_proj_string(WGS84).expect("WGS 84 definition");
        if t.starts_with('+') {
            let proj = Proj::from_proj_string(t).map_err(|e| GeoError::InvalidCrs(t.into(), e.to_string()))?;
            let name = "Custom (PROJ string)".into();
            return Ok(Crs { id: t.to_string(), name, definition: t.to_string(), proj, wgs84 });
        }
        let code_str = t.strip_prefix("EPSG:").or_else(|| t.strip_prefix("epsg:")).unwrap_or(t).trim();
        let code: u16 = code_str.parse().map_err(|_| GeoError::UnknownCrs(t.into()))?;
        let def = crs_definitions::from_code(code).ok_or_else(|| GeoError::UnknownCrs(t.into()))?;
        let proj = Proj::from_proj_string(def.proj4).map_err(|e| GeoError::InvalidCrs(t.into(), e.to_string()))?;
        let definition = def.proj4.to_string();
        Ok(Crs { id: format!("EPSG:{code}"), name: info_of(&def).name, definition, proj, wgs84 })
    }

    /// Longitude / latitude (from Greenwich) of the natural origin of a projected
    /// system, to show an empty model near where it will be drawn: the centre of a
    /// national grid (`+lon_0`, `+lat_0`, counted from the prime meridian `+pm`), the
    /// central meridian of a UTM zone at the equator. `None` for geographic systems and
    /// for projections that name no origin.
    pub fn origin(&self) -> Option<[f64; 2]> {
        if self.is_geographic() {
            return None;
        }
        let text = |key: &str| self.definition.split_whitespace().find_map(|p| p.strip_prefix(key));
        let number = |key: &str| text(key).and_then(|v| v.parse::<f64>().ok());
        if text("+proj=") == Some("utm") {
            // Zones are 6° wide, zone 1 starting at 180°W.
            return number("+zone=").map(|zone| [6.0 * zone - 183.0, 0.0]);
        }
        // `+lonc`: the centre of an oblique Mercator projection.
        let (lon, lat) = (number("+lon_0=").or_else(|| number("+lonc=")), number("+lat_0="));
        if lon.is_none() && lat.is_none() {
            return None;
        }
        // Longitudes of older national grids are counted from their own meridian: a
        // name PROJ knows, or degrees. An unknown name gives no origin rather than a wrong one.
        let prime_meridian = match text("+pm=") {
            None => 0.0,
            Some(value) => match PRIME_MERIDIANS.iter().find(|(name, _)| *name == value) {
                Some((_, degrees)) => *degrees,
                None => value.parse().ok()?,
            },
        };
        Some([lon.unwrap_or(0.0) + prime_meridian, lat.unwrap_or(0.0)])
    }

    pub fn is_geographic(&self) -> bool {
        self.proj.is_latlong()
    }

    /// Converts model coordinates to WGS 84 longitude/latitude in degrees, in place.
    /// Points that cannot be converted, or that land off the globe (projected metres
    /// read as degrees), become NaN.
    pub fn to_lonlat(&self, points: &mut [[f64; 2]]) {
        let geo = self.is_geographic();
        for p in points.iter_mut() {
            let mut q = if geo { (p[0].to_radians(), p[1].to_radians(), 0.0) } else { (p[0], p[1], 0.0) };
            let on_globe = |q: (f64, f64, f64)| {
                q.0.abs() <= 2.0 * std::f64::consts::PI && q.1.abs() <= std::f64::consts::FRAC_PI_2
            };
            match transform(&self.proj, &self.wgs84, &mut q) {
                Ok(()) if on_globe(q) => *p = [q.0.to_degrees(), q.1.to_degrees()],
                _ => *p = [f64::NAN, f64::NAN],
            }
        }
    }

    /// Converts WGS 84 longitude/latitude in degrees to model coordinates, in place.
    /// Points that cannot be converted become NaN.
    pub fn from_lonlat(&self, points: &mut [[f64; 2]]) {
        // One point at a time, like `to_lonlat`: proj4rs runs a `Transform` once per
        // pipeline step (datum shift, prime meridian, projection), so a batch adapter
        // that converts its input would convert it again at every step.
        let geo = self.is_geographic();
        for p in points.iter_mut() {
            let mut q = (p[0].to_radians(), p[1].to_radians(), 0.0);
            match transform(&self.wgs84, &self.proj, &mut q) {
                Ok(()) if q.0.is_finite() && q.1.is_finite() => {
                    *p = if geo { [q.0.to_degrees(), q.1.to_degrees()] } else { [q.0, q.1] }
                }
                _ => *p = [f64::NAN, f64::NAN],
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lambert93_reference_point() {
        // Reference: PROJ `cs2cs EPSG:2154 EPSG:4326` (IGN geodetic point near Paris).
        let crs = Crs::parse("EPSG:2154").unwrap();
        assert_eq!(crs.name, "RGF93 / Lambert-93");
        let mut p = [[652_469.02, 6_862_035.26]];
        crs.to_lonlat(&mut p);
        assert!((p[0][0] - 2.3522).abs() < 1e-3 && (p[0][1] - 48.8566).abs() < 1e-3, "{p:?}");
        // Origin of the projection: (700000, 6600000) is lon 3°, lat 46.5°.
        let mut o = [[700_000.0, 6_600_000.0]];
        crs.to_lonlat(&mut o);
        assert!((o[0][0] - 3.0).abs() < 1e-9 && (o[0][1] - 46.5).abs() < 1e-9, "{o:?}");
        crs.from_lonlat(&mut o);
        assert!((o[0][0] - 700_000.0).abs() < 1e-4 && (o[0][1] - 6_600_000.0).abs() < 1e-4, "{o:?}");
    }

    #[test]
    fn cc_zone_and_ntf_lambert() {
        // CC44 origin: lon 3°, lat 44°, false easting 1700000, false northing 3200000.
        let crs = Crs::parse("3944").unwrap();
        let mut p = [[1_700_000.0, 3_200_000.0]];
        crs.to_lonlat(&mut p);
        assert!((p[0][0] - 3.0).abs() < 1e-9 && (p[0][1] - 44.0).abs() < 1e-9, "{p:?}");
        // NTF (Paris) / Lambert Sud: Marseille within a few metres (datum shift towgs84).
        let crs = Crs::parse("epsg:27563").unwrap();
        let mut m = [[848_500.0, 112_000.0]];
        crs.to_lonlat(&mut m);
        assert!((m[0][0] - 5.38).abs() < 0.05 && (m[0][1] - 43.3).abs() < 0.05, "{m:?}");
    }

    #[test]
    fn natural_origin() {
        let origin = |id: &str| Crs::parse(id).unwrap().origin();
        // Lambert-93: 3°E, 46.5°N.
        let o = origin("EPSG:2154").unwrap();
        assert!((o[0] - 3.0).abs() < 1e-6 && (o[1] - 46.5).abs() < 1e-6, "{o:?}");
        // UTM zone 31 north: central meridian 3°E.
        assert_eq!(origin("EPSG:32631"), Some([3.0, 0.0]));
        // NTF Lambert zone II: longitudes from Paris.
        let o = origin("EPSG:27572").unwrap();
        assert!((o[0] - 2.337).abs() < 1e-3 && o[1] > 46.0 && o[1] < 47.5, "{o:?}");
        assert_eq!(origin("EPSG:4326"), None);
        // A named meridian other than Paris (the projection library refuses unknown names).
        let custom = |def: &str| Crs::parse(def).unwrap().origin();
        let o = custom("+proj=tmerc +lat_0=0 +lon_0=20 +pm=ferro +k=1 +x_0=0 +y_0=0 +ellps=bessel +units=m").unwrap();
        assert!((o[0] - 2.333).abs() < 1e-3, "{o:?}");
    }

    #[test]
    fn round_trip() {
        for (code, p) in [
            ("EPSG:2154", [892_000.0, 6_247_000.0]),
            ("EPSG:3944", [1_890_000.0, 3_140_000.0]),
            ("EPSG:27563", [848_500.0, 112_000.0]),
            ("EPSG:27572", [848_500.0, 1_812_000.0]),
            ("EPSG:4326", [5.38, 43.3]),
        ] {
            let crs = Crs::parse(code).unwrap();
            let mut q = [p, [p[0] + 10.0, p[1] + 10.0]];
            crs.to_lonlat(&mut q);
            crs.from_lonlat(&mut q);
            assert!((q[0][0] - p[0]).abs() < 1e-3 && (q[0][1] - p[1]).abs() < 1e-3, "{code}: {p:?} → {q:?}");
        }
    }

    #[test]
    fn geographic_and_proj_string() {
        let crs = Crs::parse("EPSG:4326").unwrap();
        assert!(crs.is_geographic());
        let mut p = [[2.35, 48.85]];
        crs.to_lonlat(&mut p);
        assert!((p[0][0] - 2.35).abs() < 1e-12 && (p[0][1] - 48.85).abs() < 1e-12);
        let utm = Crs::parse("+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs").unwrap();
        let mut q = [[500_000.0, 0.0]];
        utm.to_lonlat(&mut q);
        assert!((q[0][0] - 3.0).abs() < 1e-9 && q[0][1].abs() < 1e-9, "{q:?}");
        // Projected metres read as degrees are outside the globe.
        let mut m = [[700_000.0, 6_600_000.0], [2.35, 48.85]];
        crs.to_lonlat(&mut m);
        assert!(m[0][0].is_nan() && m[0][1].is_nan() && m[1][0].is_finite(), "{m:?}");
        assert!(Crs::parse("EPSG:1").is_err());
        assert!(Crs::parse("nonsense").is_err());
    }

    #[test]
    fn registry_search() {
        let r = search("lambert 93", 10);
        assert_eq!(r.first().map(|c| c.code), Some(2154), "{r:?}");
        let r = search("CC44", 5);
        assert!(r.iter().any(|c| c.code == 3944), "{r:?}");
        let r = search("EPSG:215", 50);
        assert!(r.iter().any(|c| c.code == 2154));
        assert!(r.iter().all(|c| c.code.to_string().starts_with("215")));
        assert_eq!(lookup(4326).unwrap().kind, CrsKind::Geographic);
        assert!(search("  ", 10).is_empty());
    }
}
