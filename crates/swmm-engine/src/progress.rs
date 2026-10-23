//! Progress parsing of SWMM console output.
//!
//! Two formats exist:
//! - EPA SWMM 5.1 / some 5.2 builds: `Simulating day: 12     hour:  5` redrawn with
//!   backspaces; converted to a fraction using the simulation duration.
//! - OWA / recent builds: `... Running [=====     ] 45.3% [00:01:02]` redrawn with `\r`.

/// Splits console output on `\r`, `\n` and backspaces into status fragments.
#[derive(Debug, Default)]
pub struct Fragments {
    pending: String,
}

impl Fragments {
    /// Feeds raw output; returns complete fragments.
    pub fn push(&mut self, text: &str) -> Vec<String> {
        let mut out = Vec::new();
        for c in text.chars() {
            if matches!(c, '\r' | '\n' | '\u{8}') {
                if !self.pending.trim().is_empty() {
                    out.push(std::mem::take(&mut self.pending));
                } else {
                    self.pending.clear();
                }
            } else {
                self.pending.push(c);
            }
        }
        // `Simulating day` fragments are only terminated by the next backspace run;
        // emit them as soon as they look complete.
        if self.pending.contains("hour:") && self.pending.trim_end().ends_with(|c: char| c.is_ascii_digit()) {
            out.push(self.pending.clone());
        }
        out
    }

    /// Remaining text at end of stream.
    pub fn finish(&mut self) -> Option<String> {
        let s = std::mem::take(&mut self.pending);
        (!s.trim().is_empty()).then_some(s)
    }
}

/// Simulation progress in [0, 1] from one status fragment.
pub fn parse_progress(fragment: &str, total_days: Option<f64>) -> Option<f64> {
    if let Some(p) = fragment.find('%') {
        let num = fragment[..p].rsplit(|c: char| !(c.is_ascii_digit() || c == '.')).next()?;
        let pct: f64 = num.parse().ok()?;
        return Some((pct / 100.0).clamp(0.0, 1.0));
    }
    // `Simulating day: 12     hour:  5`, redrawn after backspaces as `12     hour:  6`.
    let p = fragment.find("hour:")?;
    let day: f64 = fragment[..p].split_whitespace().last()?.parse().ok()?;
    let hour: f64 = fragment[p + 5..].split_whitespace().next()?.parse().ok()?;
    let total = total_days.filter(|t| *t > 0.0)?;
    Some(((day + hour / 24.0) / total).clamp(0.0, 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owa_bar() {
        let mut f = Fragments::default();
        let frags = f.push("\r... Running [=====          ]  45.3% [   0.12s]\r... Running [==========]");
        assert_eq!(frags.len(), 1);
        assert!((parse_progress(&frags[0], None).unwrap() - 0.453).abs() < 1e-12);
        assert_eq!(parse_progress("... Running [====] 100.0% [ 0.00s]", None), Some(1.0));
    }

    #[test]
    fn epa_days() {
        let mut f = Fragments::default();
        let raw = "\r\n o  Simulating day: 0     hour:  0\u{8}\u{8}\u{8}\u{8}\u{8}\u{8}\u{8}\u{8}0     hour:  6";
        let frags = f.push(raw);
        let last = frags.last().unwrap();
        assert!(last.ends_with("hour:  6"), "{frags:?}");
        assert_eq!(parse_progress(last, Some(1.0)), Some(0.25));
        assert_eq!(parse_progress(" o  Simulating day: 1     hour:  12", Some(3.0)), Some(0.5));
        assert_eq!(parse_progress(" o  Simulating day: 1     hour:  12", None), None);
        assert_eq!(parse_progress("Retrieving project data", Some(1.0)), None);
    }
}
