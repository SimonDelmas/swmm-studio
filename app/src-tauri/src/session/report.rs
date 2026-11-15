//! The report (`.rpt`) of the loaded results, as the UI shows it: messages linked to the
//! objects they name, continuity errors and the summary blocks.

use std::path::{Path, PathBuf};

use serde::Serialize;
use swmm_model::{ObjKind, ObjRef};
use swmm_rpt::{Body, Report};

use super::{Res, Session};

#[derive(Debug, Clone, Serialize)]
pub struct MessageDto {
    pub code: String,
    pub text: String,
    pub line: Option<usize>,
    pub section: Option<String>,
    pub context: Option<String>,
    pub object: Option<ObjRef>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockInfo {
    pub title: String,
    pub kind: &'static str,
    pub rows: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportSummary {
    pub path: PathBuf,
    pub version: Option<String>,
    pub errors: Vec<MessageDto>,
    pub warnings: Vec<MessageDto>,
    /// `(balance, error %)`.
    pub continuity: Vec<(String, f64)>,
    pub blocks: Vec<BlockInfo>,
    pub analysis_begun: Option<String>,
    pub analysis_ended: Option<String>,
    pub elapsed: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockDto {
    pub title: String,
    pub value_headers: Vec<String>,
    pub kind: &'static str,
    pub columns: Vec<String>,
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub footer: Vec<Vec<String>>,
    pub notes: Vec<String>,
    /// Kind of the objects named in the first column, when they are network objects.
    pub id_kind: Option<ObjKind>,
}

impl Session {
    pub fn open_report(&mut self, path: &Path) -> Res<()> {
        let report = Report::read(path).map_err(|e| e.to_string())?;
        self.report = Some((path.to_path_buf(), report));
        self.project.results.rpt = Some(path.to_path_buf());
        Ok(())
    }

    fn message(&self, m: &swmm_rpt::Message) -> MessageDto {
        MessageDto {
            code: m.code.clone(),
            text: m.text.clone(),
            line: m.line,
            section: m.section.clone(),
            context: m.context.clone(),
            object: m.object().and_then(|id| self.net.find_any(id)),
        }
    }

    pub fn report_summary(&self) -> Option<ReportSummary> {
        let (path, r) = self.report.as_ref()?;
        let c = r.continuity();
        let continuity = [
            ("Runoff quantity", c.runoff_quantity),
            ("Groundwater", c.groundwater),
            ("Flow routing", c.flow_routing),
            ("Runoff quality", c.runoff_quality),
            ("Quality routing", c.quality_routing),
        ]
        .into_iter()
        .filter_map(|(n, v)| v.map(|v| (n.to_string(), v)))
        .collect();
        let blocks = r
            .blocks
            .iter()
            .map(|b| {
                let (kind, rows) = match &b.body {
                    Body::Table(t) => ("table", t.rows.len()),
                    Body::KeyValues(kv) => ("values", kv.len()),
                    Body::Text(t) => ("text", t.len()),
                };
                BlockInfo { title: b.title.clone(), kind, rows }
            })
            .collect();
        Some(ReportSummary {
            path: path.clone(),
            version: r.version.clone(),
            errors: r.errors.iter().map(|m| self.message(m)).collect(),
            warnings: r.warnings.iter().map(|m| self.message(m)).collect(),
            continuity,
            blocks,
            analysis_begun: r.analysis_begun.clone(),
            analysis_ended: r.analysis_ended.clone(),
            elapsed: r.elapsed.clone(),
        })
    }

    pub fn report_block(&self, i: usize) -> Res<BlockDto> {
        let (_, r) = self.report.as_ref().ok_or("no report loaded")?;
        let b = r.blocks.get(i).ok_or_else(|| format!("no report block #{i}"))?;
        let mut dto = BlockDto {
            title: b.title.clone(),
            value_headers: b.value_headers.clone(),
            kind: "text",
            columns: Vec::new(),
            header: Vec::new(),
            rows: Vec::new(),
            footer: Vec::new(),
            notes: Vec::new(),
            id_kind: None,
        };
        match &b.body {
            Body::Table(t) => {
                dto.kind = "table";
                dto.columns = t.columns.clone();
                dto.header = t.header.clone();
                dto.rows = t.rows.clone();
                dto.footer = t.footer.clone();
                dto.notes = t.notes.clone();
                dto.id_kind = self.id_kind(t.rows.iter().filter_map(|r| r.first()));
            }
            Body::KeyValues(kv) => {
                dto.kind = "values";
                dto.columns = std::iter::once("".to_string()).chain(b.value_headers.iter().cloned()).collect();
                dto.rows = kv
                    .iter()
                    .map(|k| std::iter::once(k.key.clone()).chain(k.values.iter().cloned()).collect())
                    .collect();
            }
            Body::Text(t) => dto.notes = t.clone(),
        }
        Ok(dto)
    }

    /// Kind of object most first-column cells name (looking at up to 50 rows).
    fn id_kind<'a>(&self, cells: impl Iterator<Item = &'a String>) -> Option<ObjKind> {
        let mut counts = [0usize; 4];
        let mut n = 0;
        for c in cells.take(50) {
            n += 1;
            for k in ObjKind::ALL {
                if self.net.find(k, c).is_some() {
                    counts[k as usize] += 1;
                    break;
                }
            }
        }
        let (best, count) = counts.iter().enumerate().max_by_key(|(_, c)| **c)?;
        (*count > 0 && *count * 2 >= n).then(|| ObjKind::ALL[best])
    }
}
