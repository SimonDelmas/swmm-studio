//! Application settings shared by the CLI and the desktop app
//! (`%APPDATA%\SwmmStudio\settings.json`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::EngineError;

/// A SWMM executable registered by the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineConfig {
    pub name: String,
    pub path: PathBuf,
    /// Version detected when the engine was added (informative).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub engines: Vec<EngineConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_engine: Option<String>,
    /// Keys written by other parts of the application, preserved as-is.
    #[serde(flatten)]
    pub other: BTreeMap<String, serde_json::Value>,
}

impl Settings {
    /// `%APPDATA%\SwmmStudio\settings.json` (or the platform equivalent).
    /// `SWMM_STUDIO_SETTINGS` overrides it (tests, portable installs).
    pub fn default_path() -> PathBuf {
        if let Some(p) = std::env::var_os("SWMM_STUDIO_SETTINGS") {
            return PathBuf::from(p);
        }
        dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("SwmmStudio").join("settings.json")
    }

    /// Loads settings; a missing file gives defaults.
    pub fn load(path: &Path) -> Result<Settings, EngineError> {
        match std::fs::read_to_string(path) {
            Ok(s) => serde_json::from_str(&s).map_err(|e| EngineError::Settings(format!("{}: {e}", path.display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(EngineError::io(path, e)),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), EngineError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| EngineError::io(dir, e))?;
        }
        let json = serde_json::to_string_pretty(self).expect("settings serialize");
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| EngineError::io(&tmp, e))?;
        std::fs::rename(&tmp, path).map_err(|e| EngineError::io(path, e))
    }

    pub fn engine(&self, name: &str) -> Option<&EngineConfig> {
        self.engines.iter().find(|e| e.name.eq_ignore_ascii_case(name))
    }

    /// The default engine, or the only one when there is a single engine.
    pub fn default_engine(&self) -> Option<&EngineConfig> {
        match &self.default_engine {
            Some(n) => self.engine(n),
            None if self.engines.len() == 1 => self.engines.first(),
            None => None,
        }
    }

    /// Adds or replaces an engine by name. The first engine added becomes the default.
    pub fn add_engine(&mut self, engine: EngineConfig) {
        match self.engines.iter_mut().find(|e| e.name.eq_ignore_ascii_case(&engine.name)) {
            Some(e) => *e = engine,
            None => self.engines.push(engine),
        }
        if self.default_engine.is_none() {
            self.default_engine = self.engines.first().map(|e| e.name.clone());
        }
    }

    pub fn remove_engine(&mut self, name: &str) -> bool {
        let before = self.engines.len();
        self.engines.retain(|e| !e.name.eq_ignore_ascii_case(name));
        if self.default_engine.as_deref().is_some_and(|d| d.eq_ignore_ascii_case(name)) {
            self.default_engine = self.engines.first().map(|e| e.name.clone());
        }
        before != self.engines.len()
    }

    pub fn set_default(&mut self, name: &str) -> Result<(), EngineError> {
        let e = self.engine(name).ok_or_else(|| EngineError::UnknownEngine(name.to_string()))?;
        self.default_engine = Some(e.name.clone());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(name: &str) -> EngineConfig {
        EngineConfig { name: name.into(), path: format!("C:\\{name}.exe").into(), version: None }
    }

    #[test]
    fn registry() {
        let mut s = Settings::default();
        assert!(s.default_engine().is_none());
        s.add_engine(engine("epa"));
        s.add_engine(engine("tss"));
        assert_eq!(s.default_engine().unwrap().name, "epa");
        s.set_default("TSS").unwrap();
        assert_eq!(s.default_engine().unwrap().name, "tss");
        assert!(s.set_default("nope").is_err());
        assert!(s.remove_engine("tss"));
        assert_eq!(s.default_engine().unwrap().name, "epa");
    }

    #[test]
    fn save_load_keeps_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sub").join("settings.json");
        assert_eq!(Settings::load(&p).unwrap(), Settings::default());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, r#"{"engines":[{"name":"a","path":"a.exe"}],"language":"fr"}"#).unwrap();
        let mut s = Settings::load(&p).unwrap();
        assert_eq!(s.other["language"], "fr");
        s.add_engine(engine("b"));
        s.save(&p).unwrap();
        let again = Settings::load(&p).unwrap();
        assert_eq!(again, s);
    }
}
