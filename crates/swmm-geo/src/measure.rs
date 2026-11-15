//! Lengths and areas: of polylines and rings in plane coordinates, or on the globe from
//! WGS 84 longitude / latitude.

/// Mean radius of the Earth, in metres.
const EARTH_RADIUS: f64 = 6_371_008.8;

/// Length of a polyline in metres from WGS 84 points (haversine).
pub fn geodesic_length(pts: &[[f64; 2]]) -> f64 {
    pts.windows(2)
        .map(|w| {
            let (p1, p2) = (w[0][1].to_radians(), w[1][1].to_radians());
            let dp = p2 - p1;
            let dl = (w[1][0] - w[0][0]).to_radians();
            let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
            2.0 * EARTH_RADIUS * a.sqrt().asin()
        })
        .sum()
}

pub fn planar_length(pts: &[[f64; 2]]) -> f64 {
    pts.windows(2).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).sum()
}

pub fn shoelace(pts: &[[f64; 2]]) -> f64 {
    let n = pts.len();
    (0..n).map(|i| pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]).sum::<f64>().abs() / 2.0
}

/// Area in m² of a ring of WGS 84 points (local equirectangular projection).
pub fn geodesic_area(pts: &[[f64; 2]]) -> f64 {
    let lat0 = (pts.iter().map(|p| p[1]).sum::<f64>() / pts.len() as f64).to_radians();
    let m: Vec<[f64; 2]> =
        pts.iter().map(|p| [EARTH_RADIUS * p[0].to_radians() * lat0.cos(), EARTH_RADIUS * p[1].to_radians()]).collect();
    shoelace(&m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_and_areas() {
        assert_eq!(planar_length(&[[0.0, 0.0], [3.0, 4.0], [3.0, 5.0]]), 6.0);
        assert_eq!(shoelace(&[[0.0, 0.0], [2.0, 0.0], [2.0, 3.0], [0.0, 3.0]]), 6.0);
        // One degree of latitude is about 111.2 km.
        let d = geodesic_length(&[[2.0, 48.0], [2.0, 49.0]]);
        assert!((d - 111_195.0).abs() < 50.0, "{d}");
        // A square of 0.001° at the equator: about 111.2 m a side.
        let a = geodesic_area(&[[0.0, 0.0], [0.001, 0.0], [0.001, 0.001], [0.0, 0.001]]);
        assert!((a - 111.195_f64.powi(2)).abs() < 5.0, "{a}");
    }
}
