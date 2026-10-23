//! A single line of an `.inp` file, with its original text kept verbatim.
//!
//! Tokens are stored as byte spans into the line text, so parsing allocates
//! one `String` per line and untouched lines are written back byte-for-byte.

/// Line terminator as found in the source file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LineEnding {
    /// No terminator (last line of a file without trailing newline).
    None,
    #[default]
    CrLf,
    Lf,
    Cr,
}

impl LineEnding {
    pub fn as_str(self) -> &'static str {
        match self {
            LineEnding::None => "",
            LineEnding::CrLf => "\r\n",
            LineEnding::Lf => "\n",
            LineEnding::Cr => "\r",
        }
    }
}

/// What a line contains, as SWMM's own tokenizer would see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    /// Empty or whitespace only.
    Blank,
    /// Starts (after optional whitespace) with `;`.
    Comment,
    /// A `[SECTION]` header.
    Header,
    /// Data tokens, possibly followed by an inline comment.
    Data,
    /// Free text (lines of the `[TITLE]` section).
    Text,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Span {
    start: u32,
    end: u32,
    quoted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    text: String,
    ending: LineEnding,
    kind: LineKind,
    spans: Vec<Span>,
    /// Byte offset of the inline comment (`;`) in `text`, if any.
    comment_at: Option<u32>,
}

impl Line {
    /// Parses one line of text (without its terminator).
    ///
    /// `free_text` is set for lines of the `[TITLE]` section, which SWMM does
    /// not tokenize.
    pub fn parse(text: String, ending: LineEnding, free_text: bool) -> Line {
        let mut line = Line { text, ending, kind: LineKind::Blank, spans: Vec::new(), comment_at: None };
        line.analyse(free_text);
        line
    }

    /// Builds a new data line from tokens, formatted in EPA SWMM's column style.
    pub fn from_tokens<S: AsRef<str>>(tokens: &[S], comment: Option<&str>, ending: LineEnding) -> Line {
        Line::parse(format_tokens(tokens, comment), ending, false)
    }

    /// Builds a new free-text or comment line.
    pub fn from_text(text: impl Into<String>, ending: LineEnding, free_text: bool) -> Line {
        Line::parse(text.into(), ending, free_text)
    }

    fn analyse(&mut self, free_text: bool) {
        self.spans.clear();
        self.comment_at = None;
        let trimmed = self.text.trim_start();
        self.kind = if trimmed.trim_end().is_empty() {
            LineKind::Blank
        } else if trimmed.starts_with(';') {
            LineKind::Comment
        } else if trimmed.starts_with('[') {
            LineKind::Header
        } else if free_text {
            LineKind::Text
        } else {
            LineKind::Data
        };
        if self.kind == LineKind::Data {
            self.tokenize();
        }
    }

    /// Mirrors SWMM's `getTokens`: whitespace separated, `"` groups, `;` starts a comment.
    fn tokenize(&mut self) {
        let bytes = self.text.as_bytes();
        let mut i = 0;
        let n = bytes.len();
        while i < n {
            let b = bytes[i];
            if b == b' ' || b == b'\t' {
                i += 1;
            } else if b == b';' {
                self.comment_at = Some(i as u32);
                break;
            } else if b == b'"' {
                let start = i + 1;
                let mut end = start;
                while end < n && bytes[end] != b'"' {
                    end += 1;
                }
                self.spans.push(Span { start: start as u32, end: end as u32, quoted: true });
                i = (end + 1).min(n);
            } else {
                let start = i;
                while i < n && !matches!(bytes[i], b' ' | b'\t' | b';' | b'"') {
                    i += 1;
                }
                self.spans.push(Span { start: start as u32, end: i as u32, quoted: false });
            }
        }
    }

    /// The line exactly as it will be written (without terminator).
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn ending(&self) -> LineEnding {
        self.ending
    }

    pub fn set_ending(&mut self, ending: LineEnding) {
        self.ending = ending;
    }

    pub fn kind(&self) -> LineKind {
        self.kind
    }

    pub fn is_data(&self) -> bool {
        self.kind == LineKind::Data
    }

    /// Number of data tokens (0 for non-data lines).
    pub fn len(&self) -> usize {
        self.spans.len()
    }

    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
    }

    /// Token `i`, without surrounding quotes.
    pub fn token(&self, i: usize) -> Option<&str> {
        self.spans.get(i).map(|s| &self.text[s.start as usize..s.end as usize])
    }

    pub fn tokens(&self) -> impl ExactSizeIterator<Item = &str> + '_ {
        self.spans.iter().map(|s| &self.text[s.start as usize..s.end as usize])
    }

    /// Whether token `i` was quoted in the source.
    pub fn is_quoted(&self, i: usize) -> bool {
        self.spans.get(i).is_some_and(|s| s.quoted)
    }

    /// Inline comment text after `;` (data lines), or the whole comment (comment lines).
    pub fn comment(&self) -> Option<&str> {
        match self.kind {
            LineKind::Comment => {
                let t = self.text.trim_start();
                Some(&t[1..])
            }
            _ => self.comment_at.map(|at| &self.text[at as usize + 1..]),
        }
    }

    /// Replaces token `i`, keeping the line's other text (spacing, comment) untouched.
    ///
    /// The new value is quoted when it contains whitespace or the old token was quoted.
    /// Returns `false` if the token does not exist.
    pub fn set_token(&mut self, i: usize, value: &str) -> bool {
        let Some(span) = self.spans.get(i).copied() else {
            return false;
        };
        let quoted = span.quoted || needs_quotes(value);
        let (start, end) = if span.quoted {
            (span.start as usize - 1, (span.end as usize + 1).min(self.text.len()))
        } else {
            (span.start as usize, span.end as usize)
        };
        let replacement = if quoted { format!("\"{value}\"") } else { value.to_string() };
        self.text.replace_range(start..end, &replacement);
        self.analyse(false);
        true
    }

    /// Replaces all tokens; the line is reformatted, the inline comment kept.
    pub fn set_tokens<S: AsRef<str>>(&mut self, tokens: &[S]) {
        let comment = self.comment().map(str::to_string);
        self.text = format_tokens(tokens, comment.as_deref());
        self.analyse(false);
    }

    /// Owned copy of the tokens.
    pub fn to_vec(&self) -> Vec<String> {
        self.tokens().map(str::to_string).collect()
    }
}

fn needs_quotes(value: &str) -> bool {
    value.is_empty() || value.contains([' ', '\t', ';'])
}

/// Formats tokens the way the EPA SWMM GUI does: first column 17 wide, others 11.
pub fn format_tokens<S: AsRef<str>>(tokens: &[S], comment: Option<&str>) -> String {
    let mut out = String::new();
    for (i, t) in tokens.iter().enumerate() {
        let t = t.as_ref();
        let cell = if needs_quotes(t) { format!("\"{t}\"") } else { t.to_string() };
        let width: usize = if i == 0 { 16 } else { 10 };
        let last = i + 1 == tokens.len();
        out.push_str(&cell);
        if !last || comment.is_some() {
            let pad = width.saturating_sub(cell.chars().count()) + 1;
            out.extend(std::iter::repeat_n(' ', pad));
        }
    }
    if let Some(c) = comment {
        out.push(';');
        out.push_str(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(s: &str) -> Line {
        Line::parse(s.to_string(), LineEnding::CrLf, false)
    }

    #[test]
    fn tokenizes_like_swmm() {
        let l = data("J1   10.5  \"my file.dat\" ;note here");
        assert_eq!(l.kind(), LineKind::Data);
        assert_eq!(l.to_vec(), vec!["J1", "10.5", "my file.dat"]);
        assert!(l.is_quoted(2));
        assert_eq!(l.comment(), Some("note here"));
    }

    #[test]
    fn classifies_lines() {
        assert_eq!(data("   ").kind(), LineKind::Blank);
        assert_eq!(data("  ;;Name  Elev").kind(), LineKind::Comment);
        assert_eq!(data("[JUNCTIONS]").kind(), LineKind::Header);
        assert_eq!(Line::parse("My title".into(), LineEnding::Lf, true).kind(), LineKind::Text);
    }

    #[test]
    fn set_token_keeps_layout() {
        let mut l = data("J1        100.0     2.5   ;keep");
        assert!(l.set_token(1, "99.25"));
        assert_eq!(l.text(), "J1        99.25     2.5   ;keep");
        assert!(l.set_token(0, "a b"));
        assert_eq!(l.token(0), Some("a b"));
        assert_eq!(l.text(), "\"a b\"        99.25     2.5   ;keep");
        assert!(!l.set_token(9, "x"));
    }

    #[test]
    fn set_quoted_token() {
        let mut l = data("TS1 FILE \"C:\\data\\rain.dat\"");
        l.set_token(2, "D:\\rain.dat");
        assert_eq!(l.text(), "TS1 FILE \"D:\\rain.dat\"");
    }

    #[test]
    fn format_new_line() {
        let l = Line::from_tokens(&["J1", "10", "2"], None, LineEnding::CrLf);
        assert_eq!(l.text(), "J1               10         2");
        assert_eq!(l.to_vec(), vec!["J1", "10", "2"]);
    }
}
