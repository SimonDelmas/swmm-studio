//! Coordinate reference systems, reprojection and spatial index for SWMM Studio.
//!
//! - [`crs`]: EPSG registry (search by code or name), parsing of `EPSG:xxxx` codes and
//!   PROJ strings, conversion of model coordinates to WGS 84 longitude/latitude and back.
//! - [`mercator`]: spherical Web Mercator (EPSG:3857), the projection of web basemaps.
//! - [`index`]: R-tree over points, polylines and polygons for exact box / lasso selection
//!   and nearest-object picking.

pub mod crs;
pub mod index;
pub mod mercator;

pub use crs::{Crs, CrsInfo};
pub use index::{Hit, SpatialIndex};

#[derive(Debug, thiserror::Error)]
pub enum GeoError {
    #[error("unknown coordinate system {0:?}")]
    UnknownCrs(String),
    #[error("invalid coordinate system {0:?}: {1}")]
    InvalidCrs(String, String),
}

/// Axis-aligned bounding box `[min_x, min_y, max_x, max_y]` of points, ignoring NaN.
pub fn bounds(points: &[[f64; 2]]) -> Option<[f64; 4]> {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in points.iter().filter(|p| p[0].is_finite() && p[1].is_finite()) {
        b[0] = b[0].min(p[0]);
        b[1] = b[1].min(p[1]);
        b[2] = b[2].max(p[0]);
        b[3] = b[3].max(p[1]);
    }
    b[0].is_finite().then_some(b)
}
