//! Parser for EPA SWMM 5 status reports (`.rpt`).
//!
//! The report is split into titled blocks (the `****` banners). Each block is parsed
//! generically as a table (dashed header), a list of `label ..... values` lines, or
//! plain text, so every block of every SWMM version is available. Typed helpers give
//! direct access to errors, warnings and continuity errors.

use std::path::Path;

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
    /// First token that looks like an object ID quoted by SWMM messages, e.g. the `J9` in
    /// `undefined object J9 at line…` or the `C1` in `... used for Conduit C1`.
    pub fn object(&self) -> Option<&str> {
        let words: Vec<&str> = self.text.split_whitespace().collect();
        for (i, w) in words.iter().enumerate() {
            let lw = w.to_ascii_lowercase();
            if matches!(
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
            ) {
                if let Some(id) = words.get(i + 1) {
                    return Some(id.trim_end_matches([',', '.', ':']));
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

fn is_banner(t: &str) -> bool {
    t.len() >= 3 && t.bytes().all(|b| b == b'*')
}

/// A banner line, possibly followed by value headers (`*****    Volume   Depth`).
fn is_banner_start(t: &str) -> bool {
    t.split_whitespace().next().is_some_and(is_banner)
}

/// Banner, title, banner.
fn is_block_start(lines: &[&str], i: usize) -> bool {
    i + 2 < lines.len()
        && is_banner_start(lines[i].trim())
        && !is_banner_start(lines[i + 1].trim())
        && !lines[i + 1].trim().is_empty()
        && is_banner_start(lines[i + 2].trim())
}

/// Splits on runs of 2+ spaces.
fn phrases(s: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && b[i] == b' ' {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let start = i;
        while i < b.len() && !(b[i] == b' ' && b.get(i + 1).is_none_or(|&c| c == b' ')) {
            i += 1;
        }
        out.push((start, &s[start..i]));
    }
    out
}

fn parse_block(lines: &[&str], at: usize) -> (Block, usize) {
    // Banner, title line, banner: value headers can trail the three lines (continuity tables).
    let top = lines[at];
    let title_line = lines[at + 1];
    let title_phrases = phrases(title_line);
    let title = title_phrases.first().map_or("", |p| p.1).to_string();
    let trailing = |s: &str| phrases(s).into_iter().skip(1).map(|p| p.1.to_string()).collect::<Vec<_>>();
    let headers_top = trailing(top);
    let units = trailing(title_line);
    let value_headers = if units.is_empty() {
        headers_top
    } else if headers_top.len() == units.len() {
        headers_top.iter().zip(&units).map(|(h, u)| format!("{h} ({u})")).collect()
    } else {
        units
    };

    // Body: until the next banner or the end-of-run lines.
    let mut end = at + 3;
    while end < lines.len() {
        let t = lines[end].trim();
        if is_block_start(lines, end) || t.starts_with("Analysis begun on:") {
            break;
        }
        end += 1;
    }
    let body_lines = &lines[at + 3..end];
    let body = parse_body(body_lines);
    (Block { title, value_headers, body }, end)
}

fn is_dashes(t: &str) -> bool {
    t.len() >= 3 && t.bytes().all(|b| b == b'-')
}

fn parse_body(lines: &[&str]) -> Body {
    let content: Vec<&str> = lines.iter().copied().filter(|l| !l.trim().is_empty()).collect();
    if content.iter().filter(|l| is_dashes(l.trim())).count() >= 2 {
        return Body::Table(parse_table(lines));
    }
    let kv: Vec<Option<KeyValue>> = content.iter().map(|l| parse_key_value(l)).collect();
    if !kv.is_empty() && kv.iter().filter(|k| k.is_some()).count() * 2 >= kv.len() {
        return Body::KeyValues(kv.into_iter().flatten().collect());
    }
    Body::Text(content.iter().map(|l| l.trim().to_string()).collect())
}

/// `Total Precipitation ......   0.188   2.650` or `Minimum Time Step   :   37.57 sec`.
fn parse_key_value(line: &str) -> Option<KeyValue> {
    let t = line.trim();
    let (key, rest) = if let Some(p) = t.find(" ..") {
        let rest = t[p..].trim_start_matches([' ', '.']);
        (&t[..p], rest)
    } else {
        let (k, v) = t.split_at(t.find(':')?);
        if !k.ends_with(' ') {
            return None;
        }
        (k, &v[1..])
    };
    Some(KeyValue { key: key.trim().to_string(), values: rest.split_whitespace().map(str::to_string).collect() })
}

fn parse_table(lines: &[&str]) -> Table {
    let mut t = Table::default();
    let dashes: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| is_dashes(l.trim())).map(|(i, _)| i).collect();
    let (Some(&h0), Some(&h1)) = (dashes.first(), dashes.get(1)) else {
        return t;
    };
    t.header = lines[h0 + 1..h1].iter().map(|l| l.trim_end().to_string()).collect();
    t.notes = lines[..h0].iter().map(|l| l.trim()).filter(|l| !l.is_empty()).map(str::to_string).collect();
    let mut footer = false;
    for line in &lines[h1 + 1..] {
        let s = line.trim();
        if is_dashes(s) {
            footer = true;
        } else if !s.is_empty() {
            let row: Vec<String> = s.split_whitespace().map(str::to_string).collect();
            if footer {
                t.footer.push(row);
            } else {
                t.rows.push(row);
            }
        }
    }
    if let Some(first) = lines[h1 + 1..].iter().find(|l| !l.trim().is_empty() && !is_dashes(l.trim())) {
        t.columns = column_names(&t.header, first);
    }
    t
}

/// Names each data column after the header phrases printed above it.
fn column_names(header: &[String], sample: &str) -> Vec<String> {
    let mut spans = Vec::new();
    let b = sample.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && b[i] == b' ' {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i] != b' ' {
            i += 1;
        }
        if i > start {
            spans.push((start, i));
        }
    }
    let overlap = |a: usize, z: usize, (s, e): (usize, usize)| z.min(e) as i64 - a.max(s) as i64;
    // Best overlap, else the column whose end is nearest.
    let best = |a: usize, z: usize| {
        spans
            .iter()
            .enumerate()
            .max_by_key(|(_, &span)| (overlap(a, z, span), -(z as i64 - span.1 as i64).abs()))
            .map(|(i, _)| i)
    };
    let mut names: Vec<Vec<&str>> = vec![Vec::new(); spans.len()];
    for h in header {
        for (pos, phrase) in phrases(h) {
            let (a, z) = (pos, pos + phrase.len());
            let words: Vec<(usize, &str)> = phrase
                .split(' ')
                .scan(pos, |at, w| {
                    let start = *at;
                    *at += w.len() + 1;
                    Some((start, w))
                })
                .collect();
            let covered = spans.iter().filter(|&&s| overlap(a, z, s) > 0).count();
            // `days hr:min` sits over two data tokens: one word per column.
            if covered > 1 && covered == words.len() {
                for (wa, w) in words {
                    if let Some(c) = best(wa, wa + w.len()) {
                        names[c].push(w);
                    }
                }
            } else if let Some(c) = best(a, z) {
                names[c].push(phrase);
            }
        }
    }
    names.into_iter().map(|w| w.join(" ")).collect()
}

fn parse_message(t: &str, keyword: &str) -> Option<Message> {
    let rest = t.strip_prefix(keyword)?.strip_prefix(' ')?;
    let (code, text) = rest.split_once(':')?;
    let code = code.trim();
    if code.contains(' ') {
        return None;
    }
    let text = text.trim().to_string();
    let mut line = None;
    let mut section = None;
    if let Some(p) = text.find(" at line ") {
        let after = &text[p + 9..];
        line = after.split_whitespace().next().and_then(|n| n.parse().ok());
        if let (Some(a), Some(z)) = (after.find('['), after.find(']')) {
            section = Some(after[a + 1..z].to_string());
        }
    }
    Some(Message { code: code.to_string(), text, line, section, context: None })
}

#[cfg(test)]
mod tests;
