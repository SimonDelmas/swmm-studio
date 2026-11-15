//! Parser for EPA SWMM 5 status reports (`.rpt`).
//!
//! The report is split into titled blocks (the `****` banners). Each block is parsed
//! generically as a table (dashed header), a list of `label ..... values` lines, or
//! plain text, so every block of every SWMM version is available. Typed helpers give
//! direct access to errors, warnings and continuity errors.

mod parse;

use std::path::Path;

use parse::{is_block_start, parse_block, parse_message};

#[derive(Debug, thiserror::Error)]
pub enum RptError {
    #[error("cannot read {path}: {source}")]
    Read { path: String, source: std::io::Error },
}

/// An `ERROR` or `WARNING` line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    /// Code after the keyword (`"209"`, `"04"`, `"TSS1"`…).
    pub code: String,
    pub text: String,
    /// Input line number, for input errors (`... at line 45 of [CONDUITS] section:`).
    pub line: Option<usize>,
    pub section: Option<String>,
    /// The offending input line, printed by SWMM after input errors.
    pub context: Option<String>,
}

impl Message {
    /// The object ID quoted by a SWMM message, e.g. the `J9` in `undefined object J9 at
    /// line…` or the `C1` in `... used for Conduit C1`. A capitalised type is the one of
    /// the object the message is about (`invalid pump curve assigned to Pump P1` is about
    /// `P1`); without one, a type in lower case counts (`… for RDII at node N1`). A type
    /// may be followed by a more precise one (`Weir Divider D1`, `Storage node N1`).
    pub fn object(&self) -> Option<&str> {
        let words: Vec<&str> = self.text.split_whitespace().collect();
        let is_type = |w: &str, any_case: bool| {
            let lw = w.to_ascii_lowercase();
            matches!(
                lw.as_str(),
                "object"
                    | "conduit"
                    | "node"
                    | "link"
                    | "subcatchment"
                    | "junction"
                    | "outfall"
                    | "storage"
                    | "pump"
                    | "orifice"
                    | "weir"
                    | "outlet"
                    | "divider"
                    | "gage"
                    | "curve"
                    | "timeseries"
                    | "pattern"
            ) && (any_case || lw == "object" || w.starts_with(|c: char| c.is_ascii_uppercase()))
        };
        for any_case in [false, true] {
            for (i, w) in words.iter().enumerate() {
                if is_type(w, any_case) {
                    if let Some(id) = words.get(i + 1).filter(|next| !is_type(next, true)) {
                        return Some(id.trim_end_matches([',', '.', ':']));
                    }
                }
            }
        }
        None
    }
}

/// A `label ...... value value` line.
#[derive(Debug, Clone, PartialEq)]
pub struct KeyValue {
    pub key: String,
    pub values: Vec<String>,
}

impl KeyValue {
    pub fn number(&self, i: usize) -> Option<f64> {
        self.values.get(i).and_then(|v| v.trim_end_matches('%').parse().ok())
    }
}

/// A table with a dashed header.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Table {
    /// Header lines as printed.
    pub header: Vec<String>,
    /// One best-effort name per data column, built from the header words above it.
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// Rows after a closing dashed line (e.g. `System` totals).
    pub footer: Vec<Vec<String>>,
    /// Text printed between the banner and the table.
    pub notes: Vec<String>,
}

impl Table {
    /// Column index whose name contains `pattern` (case-insensitive).
    pub fn column(&self, pattern: &str) -> Option<usize> {
        let p = pattern.to_ascii_lowercase();
        self.columns.iter().position(|c| c.to_ascii_lowercase().contains(&p))
    }

    /// Row whose first cell equals `id`.
    pub fn row(&self, id: &str) -> Option<&[String]> {
        self.rows.iter().find(|r| r.first().is_some_and(|c| c == id)).map(Vec::as_slice)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Body {
    Table(Table),
    KeyValues(Vec<KeyValue>),
    Text(Vec<String>),
}

/// A titled block of the report.
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub title: String,
    /// Column headings printed next to the banner (continuity tables: `Volume`, `Depth`…).
    pub value_headers: Vec<String>,
    pub body: Body,
}

impl Block {
    pub fn key_values(&self) -> &[KeyValue] {
        match &self.body {
            Body::KeyValues(kv) => kv,
            _ => &[],
        }
    }

    pub fn table(&self) -> Option<&Table> {
        match &self.body {
            Body::Table(t) => Some(t),
            _ => None,
        }
    }

    pub fn text(&self) -> Vec<&str> {
        match &self.body {
            Body::Text(t) => t.iter().map(String::as_str).collect(),
            _ => Vec::new(),
        }
    }

    /// Value of a `label ... value` line whose label starts with `key` (case-insensitive).
    pub fn get(&self, key: &str) -> Option<&KeyValue> {
        let k = key.to_ascii_lowercase();
        self.key_values().iter().find(|kv| kv.key.to_ascii_lowercase().starts_with(&k))
    }
}

/// Continuity error (%) of one balance.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Continuity {
    pub runoff_quantity: Option<f64>,
    pub groundwater: Option<f64>,
    pub flow_routing: Option<f64>,
    pub runoff_quality: Option<f64>,
    pub quality_routing: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Report {
    /// e.g. `5.2 (Build 5.2.4)`.
    pub version: Option<String>,
    pub errors: Vec<Message>,
    pub warnings: Vec<Message>,
    pub blocks: Vec<Block>,
    pub analysis_begun: Option<String>,
    pub analysis_ended: Option<String>,
    pub elapsed: Option<String>,
}

impl Report {
    pub fn read(path: impl AsRef<Path>) -> Result<Report, RptError> {
        let path = path.as_ref();
        let bytes =
            std::fs::read(path).map_err(|source| RptError::Read { path: path.display().to_string(), source })?;
        let text = match std::str::from_utf8(&bytes) {
            Ok(s) => s.to_string(),
            Err(_) => encoding_rs::WINDOWS_1252.decode_without_bom_handling(&bytes).0.into_owned(),
        };
        Ok(Report::parse(&text))
    }

    pub fn parse(text: &str) -> Report {
        let lines: Vec<&str> = text.lines().collect();
        let mut r = Report::default();
        let mut i = 0;
        while i < lines.len() {
            let line = lines[i];
            let t = line.trim();
            if is_block_start(&lines, i) {
                let (block, next) = parse_block(&lines, i);
                r.blocks.push(block);
                i = next;
                continue;
            }
            if let Some(v) = t.strip_prefix("EPA STORM WATER MANAGEMENT MODEL - VERSION ") {
                r.version = Some(v.trim().to_string());
            } else if let Some(m) = parse_message(t, "ERROR") {
                let mut m = m;
                if m.line.is_some() {
                    if let Some(next) = lines
                        .get(i + 1)
                        .map(|l| l.trim())
                        .filter(|l| !l.is_empty() && parse_message(l, "ERROR").is_none())
                    {
                        m.context = Some(next.to_string());
                        i += 1;
                    }
                }
                r.errors.push(m);
            } else if let Some(m) = parse_message(t, "WARNING") {
                r.warnings.push(m);
            } else if let Some(v) = t.strip_prefix("Analysis begun on:") {
                r.analysis_begun = Some(v.trim().to_string());
            } else if let Some(v) = t.strip_prefix("Analysis ended on:") {
                r.analysis_ended = Some(v.trim().to_string());
            } else if let Some(v) = t.strip_prefix("Total elapsed time:") {
                r.elapsed = Some(v.trim().to_string());
            }
            i += 1;
        }
        r
    }

    /// First block whose title equals `title` (case-insensitive).
    pub fn block(&self, title: &str) -> Option<&Block> {
        self.blocks.iter().find(|b| b.title.eq_ignore_ascii_case(title))
    }

    /// Table of a summary block (`Node Depth Summary`, `Link Flow Summary`…).
    pub fn table(&self, title: &str) -> Option<&Table> {
        self.block(title).and_then(Block::table)
    }

    /// Continuity errors of every balance present in the report.
    pub fn continuity(&self) -> Continuity {
        let err = |title: &str| self.block(title).and_then(|b| b.get("Continuity Error")).and_then(|kv| kv.number(0));
        Continuity {
            runoff_quantity: err("Runoff Quantity Continuity"),
            groundwater: err("Groundwater Continuity"),
            flow_routing: err("Flow Routing Continuity"),
            runoff_quality: err("Runoff Quality Continuity"),
            quality_routing: err("Quality Routing Continuity"),
        }
    }

    /// `Rainfall Dependent I/I` block: sewershed rainfall, RDII produced, RDII ratio.
    pub fn rdii(&self) -> Option<&Block> {
        self.block("Rainfall Dependent I/I")
    }

    /// The run produced results (no error).
    pub fn is_success(&self) -> bool {
        self.errors.is_empty()
    }
}

#[cfg(test)]
mod tests;
