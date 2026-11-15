//! Views of the model for the editors: checks, sections as tables or text, climatology.

use serde::Serialize;
use swmm_inp::SectionKind;
use swmm_model::{climate::Climate, grid::Grid, validate::Issue};

use crate::session::{Res, Session};

#[derive(Debug, Clone, Serialize)]
pub struct SectionInfo {
    pub name: String,
    pub lines: usize,
    pub present: bool,
}

impl Session {
    pub fn validate(&self) -> Vec<Issue> {
        swmm_model::validate::validate(&self.inp, &self.net)
    }

    pub fn grid(&self, section: &str) -> Res<Grid> {
        let kind = SectionKind::from_name(section);
        swmm_model::grid::grid(&self.inp, &self.net, &kind).ok_or_else(|| format!("[{section}] has no table view"))
    }

    pub fn climate(&self) -> Climate {
        Climate::read(&self.inp)
    }

    /// Sections of the file, then the known ones it does not have.
    pub fn sections(&self) -> Vec<SectionInfo> {
        let mut out: Vec<SectionInfo> = Vec::new();
        for s in self.inp.sections() {
            if !out.iter().any(|x| x.name == s.name()) {
                out.push(SectionInfo { name: s.name().to_string(), lines: s.data_len(), present: true });
            }
        }
        for k in SectionKind::KNOWN {
            if !out.iter().any(|x| x.name == k.name()) {
                out.push(SectionInfo { name: k.name().to_string(), lines: 0, present: false });
            }
        }
        out
    }

    pub fn section_text(&self, section: &str) -> String {
        swmm_model::grid::section_text(&self.inp, &SectionKind::from_name(section)).unwrap_or_default()
    }
}
