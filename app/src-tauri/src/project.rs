//! Project file `<model>.swproj` (JSON) next to the `.inp`: coordinate system, basemap,
//! linked results and the UI state (view, styles).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const OSM_TILES: &str = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
pub const OSM_ATTRIBUTION: &str = "© OpenStreetMap contributors";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Basemap {
    pub url: String,
    pub attribution: String,
    pub opacity: f64,
    pub visible: bool,
}

impl Default for Basemap {
    fn default() -> Self {
        Basemap { url: OSM_TILES.into(), attribution: OSM_ATTRIBUTION.into(), opacity: 1.0, visible: true }
    }
}

/// Results linked to the model. Paths are stored relative to the project folder when
/// possible.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LinkedResults {
    pub out: Option<PathBuf>,
    pub rpt: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Project {
    pub version: u32,
    /// `EPSG:xxxx` or a PROJ string; `None` = local coordinates.
    pub crs: Option<String>,
    pub basemap: Basemap,
    pub results: LinkedResults,
    /// Engine used to run this model (name in the registry); `None` = default engine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// State owned by the front-end (view, map styles, panels).
    pub ui: serde_json::Value,
}

impl Default for Project {
    fn default() -> Self {
        Project {
            version: 1,
            crs: None,
            basemap: Basemap::default(),
            results: LinkedResults::default(),
            engine: None,
            ui: serde_json::Value::Object(Default::default()),
        }
    }
}

/// `C:/m/net.inp` → `C:/m/net.swproj`.
pub fn project_path(inp: &Path) -> PathBuf {
    inp.with_extension("swproj")
}

impl Project {
    /// Loads the project of a model; a missing file gives the defaults, an unreadable one
    /// an error message (the defaults are then used and the file is not overwritten until
    /// the user changes something).
    pub fn load(inp: &Path) -> (Project, Option<String>) {
        let p = project_path(inp);
        match std::fs::read_to_string(&p) {
            Ok(s) => match serde_json::from_str::<Project>(&s) {
                Ok(mut proj) => {
                    let dir = inp.parent().unwrap_or(Path::new("."));
                    proj.results.out = proj.results.out.map(|f| dir.join(f));
                    proj.results.rpt = proj.results.rpt.map(|f| dir.join(f));
                    (proj, None)
                }
                Err(e) => (Project::default(), Some(format!("{}: {e}", p.display()))),
            },
            Err(_) => (Project::default(), None),
        }
    }

    pub fn save(&self, inp: &Path) -> std::io::Result<()> {
        let dir = inp.parent().unwrap_or(Path::new("."));
        let rel =
            |f: &Option<PathBuf>| f.as_ref().map(|f| f.strip_prefix(dir).map(Path::to_path_buf).unwrap_or(f.clone()));
        let mut copy = self.clone();
        copy.results.out = rel(&self.results.out);
        copy.results.rpt = rel(&self.results.rpt);
        let text = serde_json::to_string_pretty(&copy).expect("project serializes");
        std::fs::write(project_path(inp), text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_with_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        let inp = dir.path().join("net.inp");
        let (p, err) = Project::load(&inp);
        assert_eq!((p.clone(), err), (Project::default(), None));
        let mut p = p;
        p.crs = Some("EPSG:2154".into());
        p.results.out = Some(dir.path().join("runs").join("a.out"));
        p.ui = serde_json::json!({ "view": { "zoom": 14 } });
        p.save(&inp).unwrap();
        let text = std::fs::read_to_string(project_path(&inp)).unwrap();
        assert!(text.contains("\"out\": \"runs"), "{text}");
        let (q, err) = Project::load(&inp);
        assert!(err.is_none());
        assert_eq!(q, p);
        std::fs::write(project_path(&inp), "{ broken").unwrap();
        let (r, err) = Project::load(&inp);
        assert_eq!(r, Project::default());
        assert!(err.is_some());
    }
}
