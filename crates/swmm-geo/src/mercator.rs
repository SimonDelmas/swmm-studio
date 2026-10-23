//! Spherical Web Mercator (EPSG:3857), in metres.

const R: f64 = 6_378_137.0;
/// Latitude limit of Web Mercator tiles.
pub const MAX_LAT: f64 = 85.051_128_779_806_59;

pub fn from_lonlat(p: [f64; 2]) -> [f64; 2] {
    let lat = p[1].clamp(-MAX_LAT, MAX_LAT).to_radians();
    [R * p[0].to_radians(), R * (std::f64::consts::FRAC_PI_4 + lat / 2.0).tan().ln()]
}

pub fn to_lonlat(p: [f64; 2]) -> [f64; 2] {
    [(p[0] / R).to_degrees(), (2.0 * (p[1] / R).exp().atan() - std::f64::consts::FRAC_PI_2).to_degrees()]
}

/// Ground metres per Web Mercator metre at a latitude.
pub fn scale(lat: f64) -> f64 {
    lat.to_radians().cos()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let p = [2.3522, 48.8566];
        let m = from_lonlat(p);
        // Reference values from EPSG:3857.
        assert!((m[0] - 261_845.71).abs() < 0.1 && (m[1] - 6_250_564.35).abs() < 0.1, "{m:?}");
        let q = to_lonlat(m);
        assert!((q[0] - p[0]).abs() < 1e-12 && (q[1] - p[1]).abs() < 1e-12);
    }
}
