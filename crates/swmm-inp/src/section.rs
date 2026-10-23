//! `[SECTION]` blocks of an `.inp` file.

use crate::line::{Line, LineEnding, LineKind};

macro_rules! section_kinds {
    ($($variant:ident => $name:literal),* $(,)?) => {
        /// Sections known to SWMM 5.1 / 5.2, in the order the EPA GUI writes them.
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        pub enum SectionKind {
            $($variant,)*
            /// Any other section (extensions, typos…), preserved verbatim.
            Unknown(String),
        }

        impl SectionKind {
            /// All known kinds, in canonical order.
            pub const KNOWN: &'static [SectionKind] = &[$(SectionKind::$variant,)*];

            /// Kind from a section name, case-insensitive, with or without brackets.
            pub fn from_name(name: &str) -> SectionKind {
                let n = name.trim().trim_start_matches('[').trim_end_matches(']').trim().to_ascii_uppercase();
                match n.as_str() {
                    $($name => SectionKind::$variant,)*
                    _ => SectionKind::Unknown(n),
                }
            }

            /// Upper-case name without brackets.
            pub fn name(&self) -> &str {
                match self {
                    $(SectionKind::$variant => $name,)*
                    SectionKind::Unknown(n) => n,
                }
            }
        }
    };
}

section_kinds! {
    Title => "TITLE",
    Options => "OPTIONS",
    Report => "REPORT",
    Files => "FILES",
    Raingages => "RAINGAGES",
    Evaporation => "EVAPORATION",
    Temperature => "TEMPERATURE",
    Adjustments => "ADJUSTMENTS",
    Subcatchments => "SUBCATCHMENTS",
    Subareas => "SUBAREAS",
    Infiltration => "INFILTRATION",
    LidControls => "LID_CONTROLS",
    LidUsage => "LID_USAGE",
    Aquifers => "AQUIFERS",
    Groundwater => "GROUNDWATER",
    Gwf => "GWF",
    Snowpacks => "SNOWPACKS",
    Junctions => "JUNCTIONS",
    Outfalls => "OUTFALLS",
    Dividers => "DIVIDERS",
    Storage => "STORAGE",
    Conduits => "CONDUITS",
    Pumps => "PUMPS",
    Orifices => "ORIFICES",
    Weirs => "WEIRS",
    Outlets => "OUTLETS",
    Xsections => "XSECTIONS",
    Transects => "TRANSECTS",
    Streets => "STREETS",
    Inlets => "INLETS",
    InletUsage => "INLET_USAGE",
    Losses => "LOSSES",
    Controls => "CONTROLS",
    Pollutants => "POLLUTANTS",
    Landuses => "LANDUSES",
    Coverages => "COVERAGES",
    Loadings => "LOADINGS",
    Buildup => "BUILDUP",
    Washoff => "WASHOFF",
    Treatment => "TREATMENT",
    Inflows => "INFLOWS",
    Dwf => "DWF",
    Rdii => "RDII",
    Hydrographs => "HYDROGRAPHS",
    Curves => "CURVES",
    Timeseries => "TIMESERIES",
    Patterns => "PATTERNS",
    Map => "MAP",
    Coordinates => "COORDINATES",
    Vertices => "VERTICES",
    Polygons => "POLYGONS",
    Symbols => "SYMBOLS",
    Labels => "LABELS",
    Backdrop => "BACKDROP",
    Tags => "TAGS",
    Profiles => "PROFILES",
    Events => "EVENTS",
}

impl SectionKind {
    /// Sections whose lines each define one named object (first token = ID).
    pub fn defines_objects(&self) -> bool {
        use SectionKind::*;
        matches!(
            self,
            Raingages
                | Subcatchments
                | Aquifers
                | Junctions
                | Outfalls
                | Dividers
                | Storage
                | Conduits
                | Pumps
                | Orifices
                | Weirs
                | Outlets
                | Pollutants
                | Landuses
        )
    }

    /// Sections SWMM does not tokenize.
    pub fn is_free_text(&self) -> bool {
        matches!(self, SectionKind::Title)
    }
}

/// A `[SECTION]` header line and the lines that follow it, up to the next header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub(crate) header: Line,
    pub(crate) kind: SectionKind,
    pub(crate) lines: Vec<Line>,
}

impl Section {
    pub(crate) fn from_header(header: Line) -> Section {
        let kind = SectionKind::from_name(header_name(header.text()));
        Section { header, kind, lines: Vec::new() }
    }

    /// New empty section with a standard header line.
    pub fn new(kind: SectionKind, ending: LineEnding) -> Section {
        let header = Line::from_text(format!("[{}]", kind.name()), ending, false);
        Section { header, kind, lines: Vec::new() }
    }

    pub fn kind(&self) -> &SectionKind {
        &self.kind
    }

    pub fn name(&self) -> &str {
        self.kind.name()
    }

    pub fn header(&self) -> &Line {
        &self.header
    }

    /// All lines after the header (data, comments, blanks).
    pub fn lines(&self) -> &[Line] {
        &self.lines
    }

    pub fn line_mut(&mut self, index: usize) -> Option<&mut Line> {
        self.lines.get_mut(index)
    }

    /// Data lines with their index in [`Section::lines`].
    pub fn data(&self) -> impl Iterator<Item = (usize, &Line)> + '_ {
        let want = if self.kind.is_free_text() { LineKind::Text } else { LineKind::Data };
        self.lines.iter().enumerate().filter(move |(_, l)| l.kind() == want)
    }

    /// Number of data lines.
    pub fn data_len(&self) -> usize {
        self.data().count()
    }

    /// Index of the first data line whose first token equals `id` (case-insensitive, like SWMM).
    pub fn find(&self, id: &str) -> Option<usize> {
        self.data().find(|(_, l)| l.token(0).is_some_and(|t| t.eq_ignore_ascii_case(id))).map(|(i, _)| i)
    }

    /// Appends a data line, before any trailing blank lines so sections stay separated.
    pub fn push_tokens<S: AsRef<str>>(&mut self, tokens: &[S], ending: LineEnding) -> usize {
        let at = self.lines.iter().rposition(|l| l.kind() != LineKind::Blank).map_or(0, |i| i + 1);
        self.lines.insert(at, Line::from_tokens(tokens, None, ending));
        at
    }

    pub fn insert_line(&mut self, index: usize, line: Line) {
        self.lines.insert(index, line);
    }

    pub fn remove_line(&mut self, index: usize) -> Line {
        self.lines.remove(index)
    }

    /// Removes every data line whose first token equals `id`. Returns how many were removed.
    pub fn remove_id(&mut self, id: &str) -> usize {
        let before = self.lines.len();
        self.lines.retain(|l| !(l.is_data() && l.token(0).is_some_and(|t| t.eq_ignore_ascii_case(id))));
        before - self.lines.len()
    }
}

fn header_name(text: &str) -> &str {
    let t = text.trim_start();
    let t = t.strip_prefix('[').unwrap_or(t);
    t.split(']').next().unwrap_or(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_round_trip() {
        for k in SectionKind::KNOWN {
            assert_eq!(&SectionKind::from_name(k.name()), k);
        }
        assert_eq!(SectionKind::from_name("[junctions]"), SectionKind::Junctions);
        assert_eq!(SectionKind::from_name("MODULES"), SectionKind::Unknown("MODULES".into()));
    }

    #[test]
    fn header_with_comment() {
        let s = Section::from_header(Line::from_text("[CONDUITS] ;pipes", LineEnding::Lf, false));
        assert_eq!(s.kind(), &SectionKind::Conduits);
    }
}
