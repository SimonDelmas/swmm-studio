//! Lossless reader/writer for EPA SWMM 5 input files (`.inp`).
//!
//! The file is kept as a list of sections made of [`Line`]s that hold their original
//! text. Writing an unmodified [`InpFile`] reproduces the source byte-for-byte:
//! comments, blank lines, alignment, line endings, unknown sections and text encoding
//! (UTF-8 with/without BOM or Windows-1252) are all preserved. Edited lines are the only
//! ones that change.
//!
//! ```
//! use swmm_inp::{InpFile, SectionKind};
//! let mut inp = InpFile::parse_str("[JUNCTIONS]\nJ1  100  2\n");
//! let s = inp.section_mut(&SectionKind::Junctions).unwrap();
//! let i = s.find("J1").unwrap();
//! s.line_mut(i).unwrap().set_token(1, "101");
//! assert_eq!(inp.to_string_lossy(), "[JUNCTIONS]\nJ1  101  2\n");
//! ```

pub mod datetime;
mod files;
mod line;
mod options;
mod section;

use std::path::Path;

pub use files::{FileRef, FileRefKind};
pub use line::{format_tokens, Line, LineEnding, LineKind};
pub use options::{FlowUnits, SimulationPeriod};
pub use section::{Section, SectionKind};

#[derive(Debug, thiserror::Error)]
pub enum InpError {
    #[error("cannot read {path}: {source}")]
    Read { path: String, source: std::io::Error },
    #[error("cannot write {path}: {source}")]
    Write { path: String, source: std::io::Error },
    #[error("text cannot be encoded as {0:?}: {1}")]
    Encoding(TextEncoding, String),
}

/// Text encoding of the source file, reused when writing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
    /// Legacy ANSI files (accents in IDs or comments written by the EPA GUI).
    Windows1252,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InpFile {
    encoding: TextEncoding,
    /// Line ending used for lines created by edits.
    ending: LineEnding,
    /// Lines before the first section header.
    preamble: Vec<Line>,
    sections: Vec<Section>,
}

impl Default for InpFile {
    fn default() -> Self {
        InpFile { encoding: TextEncoding::Utf8, ending: LineEnding::CrLf, preamble: Vec::new(), sections: Vec::new() }
    }
}

impl InpFile {
    pub fn read(path: impl AsRef<Path>) -> Result<InpFile, InpError> {
        let path = path.as_ref();
        let bytes =
            std::fs::read(path).map_err(|source| InpError::Read { path: path.display().to_string(), source })?;
        Ok(InpFile::parse_bytes(&bytes))
    }

    /// Parses raw file content. Never fails: anything SWMM would reject is still kept as text.
    pub fn parse_bytes(bytes: &[u8]) -> InpFile {
        let (text, encoding) = decode(bytes);
        let mut inp = InpFile::parse_str(&text);
        inp.encoding = encoding;
        inp
    }

    pub fn parse_str(text: &str) -> InpFile {
        let mut inp = InpFile { ending: dominant_ending(text), ..InpFile::default() };
        let mut free_text = false;
        for (content, ending) in split_lines(text) {
            if content.trim_start().starts_with('[') {
                let header = Line::from_text(content, ending, false);
                let section = Section::from_header(header);
                free_text = section.kind().is_free_text();
                inp.sections.push(section);
                continue;
            }
            let line = Line::parse(content.to_string(), ending, free_text);
            match inp.sections.last_mut() {
                Some(s) => s.lines.push(line),
                None => inp.preamble.push(line),
            }
        }
        inp
    }

    pub fn write(&self, path: impl AsRef<Path>) -> Result<(), InpError> {
        let path = path.as_ref();
        let bytes = self.to_bytes()?;
        std::fs::write(path, bytes).map_err(|source| InpError::Write { path: path.display().to_string(), source })
    }

    /// Encoded file content.
    pub fn to_bytes(&self) -> Result<Vec<u8>, InpError> {
        let text = self.to_string_lossy();
        match self.encoding {
            TextEncoding::Utf8 => Ok(text.into_bytes()),
            TextEncoding::Utf8Bom => {
                let mut out = vec![0xEF, 0xBB, 0xBF];
                out.extend_from_slice(text.as_bytes());
                Ok(out)
            }
            TextEncoding::Windows1252 => {
                let (bytes, _, had_errors) = encoding_rs::WINDOWS_1252.encode(&text);
                if had_errors {
                    let bad: String =
                        text.chars().filter(|c| encoding_rs::WINDOWS_1252.encode(&c.to_string()).2).take(10).collect();
                    return Err(InpError::Encoding(self.encoding, format!("unsupported characters {bad:?}")));
                }
                Ok(bytes.into_owned())
            }
        }
    }

    /// File content as text (before encoding).
    pub fn to_string_lossy(&self) -> String {
        let mut out = String::new();
        for line in self.all_lines() {
            out.push_str(line.text());
            out.push_str(line.ending().as_str());
        }
        out
    }

    fn all_lines(&self) -> impl Iterator<Item = &Line> + '_ {
        self.preamble.iter().chain(self.sections.iter().flat_map(|s| std::iter::once(&s.header).chain(s.lines.iter())))
    }

    pub fn encoding(&self) -> TextEncoding {
        self.encoding
    }

    pub fn set_encoding(&mut self, encoding: TextEncoding) {
        self.encoding = encoding;
    }

    /// Line ending used for new lines (the most common one in the source file).
    pub fn line_ending(&self) -> LineEnding {
        self.ending
    }

    pub fn preamble(&self) -> &[Line] {
        &self.preamble
    }

    pub fn sections(&self) -> &[Section] {
        &self.sections
    }

    pub fn sections_mut(&mut self) -> &mut [Section] {
        &mut self.sections
    }

    /// First section of this kind. SWMM allows a section to appear several times; use
    /// [`InpFile::sections_of`] to see all of them.
    pub fn section(&self, kind: &SectionKind) -> Option<&Section> {
        self.sections.iter().find(|s| s.kind() == kind)
    }

    pub fn section_mut(&mut self, kind: &SectionKind) -> Option<&mut Section> {
        self.sections.iter_mut().find(|s| s.kind() == kind)
    }

    pub fn sections_of<'a>(&'a self, kind: &'a SectionKind) -> impl Iterator<Item = &'a Section> + 'a {
        self.sections.iter().filter(move |s| s.kind() == kind)
    }

    /// Data lines of every section of this kind.
    pub fn rows<'a>(&'a self, kind: &'a SectionKind) -> impl Iterator<Item = &'a Line> + 'a {
        self.sections_of(kind).flat_map(|s| s.data().map(|(_, l)| l))
    }

    /// Returns the section, creating it if needed. New known sections are inserted at
    /// their canonical position, unknown ones at the end.
    pub fn section_or_insert(&mut self, kind: SectionKind) -> &mut Section {
        if let Some(i) = self.sections.iter().position(|s| *s.kind() == kind) {
            return &mut self.sections[i];
        }
        let at = self.canonical_position(&kind);
        // Keep a blank line between the previous section and the new one.
        let ending = self.ending;
        if let Some(prev) = at.checked_sub(1).map(|i| &mut self.sections[i]) {
            if prev.lines.last().is_some_and(|l| l.ending() == LineEnding::None) {
                prev.lines.last_mut().unwrap().set_ending(ending);
            }
            if prev.lines.last().is_none_or(|l| l.kind() != LineKind::Blank) {
                prev.lines.push(Line::from_text("", ending, false));
            }
        }
        let mut section = Section::new(kind, ending);
        if at < self.sections.len() {
            section.lines.push(Line::from_text("", ending, false));
        }
        self.sections.insert(at, section);
        &mut self.sections[at]
    }

    /// Index in [`InpFile::sections`] where a new section of this kind belongs: before the
    /// first section that comes after it in canonical order; unknown kinds go last.
    pub fn canonical_position(&self, kind: &SectionKind) -> usize {
        let rank = |k: &SectionKind| SectionKind::KNOWN.iter().position(|x| x == k);
        match rank(kind) {
            Some(r) => {
                self.sections.iter().position(|s| rank(s.kind()).is_some_and(|x| x > r)).unwrap_or(self.sections.len())
            }
            None => self.sections.len(),
        }
    }

    /// Inserts a section at an index of [`InpFile::sections`] (no blank-line fix-up).
    pub fn insert_section(&mut self, at: usize, section: Section) {
        self.sections.insert(at, section);
    }

    /// Removes the section at an index of [`InpFile::sections`].
    pub fn remove_section_at(&mut self, at: usize) -> Section {
        self.sections.remove(at)
    }

    /// Removes all sections of this kind. Returns how many were removed.
    pub fn remove_section(&mut self, kind: &SectionKind) -> usize {
        let before = self.sections.len();
        self.sections.retain(|s| s.kind() != kind);
        before - self.sections.len()
    }

    /// Number of data lines per section, in file order (sections merged by kind).
    pub fn summary(&self) -> Vec<(SectionKind, usize)> {
        let mut out: Vec<(SectionKind, usize)> = Vec::new();
        for s in &self.sections {
            let n = s.data_len();
            match out.iter_mut().find(|(k, _)| k == s.kind()) {
                Some((_, c)) => *c += n,
                None => out.push((s.kind().clone(), n)),
            }
        }
        out
    }
}

fn decode(bytes: &[u8]) -> (String, TextEncoding) {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(rest).into_owned(), TextEncoding::Utf8Bom);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), TextEncoding::Utf8),
        Err(_) => {
            let (text, _) = encoding_rs::WINDOWS_1252.decode_without_bom_handling(bytes);
            (text.into_owned(), TextEncoding::Windows1252)
        }
    }
}

/// Splits text into lines, keeping each line's own terminator.
fn split_lines(text: &str) -> impl Iterator<Item = (&str, LineEnding)> + '_ {
    let bytes = text.as_bytes();
    let mut pos = 0;
    std::iter::from_fn(move || {
        if pos >= bytes.len() {
            return None;
        }
        let start = pos;
        while pos < bytes.len() && bytes[pos] != b'\n' && bytes[pos] != b'\r' {
            pos += 1;
        }
        let content = &text[start..pos];
        let ending = if pos >= bytes.len() {
            LineEnding::None
        } else if bytes[pos] == b'\r' && bytes.get(pos + 1) == Some(&b'\n') {
            pos += 2;
            LineEnding::CrLf
        } else if bytes[pos] == b'\r' {
            pos += 1;
            LineEnding::Cr
        } else {
            pos += 1;
            LineEnding::Lf
        };
        Some((content, ending))
    })
}

fn dominant_ending(text: &str) -> LineEnding {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    if lf > crlf {
        LineEnding::Lf
    } else {
        LineEnding::CrLf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "[TITLE]\r\n;;Project Title/Notes\r\nMy model ; not a comment\r\n\r\n[OPTIONS]\r\n;;Option   Value\r\nFLOW_UNITS  CMS\r\n\r\n[JUNCTIONS]\r\n;;Name  Elev\r\nJ1  100  2 ;first\r\nJ2  99   2\r\n[MODULES]\r\nTSS YES";

    #[test]
    fn byte_exact_round_trip() {
        let inp = InpFile::parse_str(SAMPLE);
        assert_eq!(inp.to_string_lossy(), SAMPLE);
        assert_eq!(inp.sections().len(), 4);
    }

    #[test]
    fn mixed_endings_and_preamble() {
        let src = "; header comment\n\n[JUNCTIONS]\r\nJ1 1 2\rJ2 1 2\n";
        let inp = InpFile::parse_str(src);
        assert_eq!(inp.preamble().len(), 2);
        assert_eq!(inp.to_string_lossy(), src);
        assert_eq!(inp.rows(&SectionKind::Junctions).count(), 2);
    }

    #[test]
    fn title_is_free_text() {
        let inp = InpFile::parse_str(SAMPLE);
        let title = inp.section(&SectionKind::Title).unwrap();
        let rows: Vec<_> = title.data().map(|(_, l)| l.text()).collect();
        assert_eq!(rows, vec!["My model ; not a comment"]);
    }

    #[test]
    fn windows_1252_round_trip() {
        let bytes = b"[TITLE]\r\nR\xE9seau d'\xE9vacuation\r\n".to_vec();
        let inp = InpFile::parse_bytes(&bytes);
        assert_eq!(inp.encoding(), TextEncoding::Windows1252);
        assert!(inp.to_string_lossy().contains("Réseau"));
        assert_eq!(inp.to_bytes().unwrap(), bytes);
        let bom = InpFile::parse_bytes(&"\u{feff}[TITLE]\r\n".to_string().into_bytes());
        assert_eq!(bom.encoding(), TextEncoding::Utf8Bom);
    }

    #[test]
    fn unencodable_edit_is_an_error() {
        let mut inp = InpFile::parse_bytes(b"[JUNCTIONS]\r\nJ\xE9 1 2\r\n");
        let s = inp.section_mut(&SectionKind::Junctions).unwrap();
        s.line_mut(0).unwrap().set_token(0, "J\u{4e2d}");
        assert!(inp.to_bytes().is_err());
    }

    #[test]
    fn edit_only_touches_edited_line() {
        let mut inp = InpFile::parse_str(SAMPLE);
        let s = inp.section_mut(&SectionKind::Junctions).unwrap();
        let i = s.find("j2").unwrap();
        s.line_mut(i).unwrap().set_token(1, "98.5");
        assert_eq!(inp.to_string_lossy(), SAMPLE.replace("J2  99   2", "J2  98.5   2"));
    }

    #[test]
    fn insert_section_at_canonical_position() {
        let mut inp = InpFile::parse_str(SAMPLE);
        inp.section_or_insert(SectionKind::Report).push_tokens(&["NODES", "ALL"], LineEnding::CrLf);
        let names: Vec<_> = inp.sections().iter().map(|s| s.name().to_string()).collect();
        assert_eq!(names, ["TITLE", "OPTIONS", "REPORT", "JUNCTIONS", "MODULES"]);
        let text = inp.to_string_lossy();
        assert!(text.contains("FLOW_UNITS  CMS\r\n\r\n[REPORT]\r\nNODES            ALL\r\n\r\n[JUNCTIONS]"), "{text}");

        inp.section_or_insert(SectionKind::Tags).push_tokens(&["Node", "J1", "x"], LineEnding::CrLf);
        assert!(inp.to_string_lossy().ends_with("TSS YES\r\n\r\n[TAGS]\r\nNode             J1         x\r\n"));
        assert_eq!(InpFile::parse_str(&inp.to_string_lossy()), inp);
    }

    #[test]
    fn summary_counts_rows() {
        let inp = InpFile::parse_str(SAMPLE);
        let s = inp.summary();
        assert!(s.contains(&(SectionKind::Junctions, 2)));
        assert!(s.contains(&(SectionKind::Unknown("MODULES".into()), 1)));
    }
}
