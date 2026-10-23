//! Undoable edits of an [`InpFile`].
//!
//! Every edit is a [`Transaction`] of line-level [`Op`]s. Applying an op turns it into
//! its own inverse (a splice gives back the lines it removed), so a transaction applied
//! twice is a no-op and undo / redo are the same operation. Lines that no edit touches
//! keep their original text, so a saved file differs from the source only where the
//! user changed something.

use swmm_inp::{InpFile, Line, LineEnding, LineKind, Section, SectionKind};

/// Error of an edit, shown to the user.
pub type EditResult<T> = Result<T, String>;

/// One primitive change.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    /// Replaces `remove` lines of section `section` at index `at` with `lines`.
    Splice { section: usize, at: usize, remove: usize, lines: Vec<Line> },
    /// `Some`: inserts this section at `at`; `None`: removes the section at `at`.
    Section { at: usize, section: Option<Section> },
}

/// Lines changed by an op, for refreshing views derived from the file.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub kind: SectionKind,
    pub removed: Vec<Line>,
    pub inserted: Vec<Line>,
}

impl Op {
    /// Applies the op and turns it into its inverse.
    fn apply(&mut self, inp: &mut InpFile) -> Change {
        match self {
            Op::Splice { section, at, remove, lines } => {
                let s = &mut inp.sections_mut()[*section];
                let kind = s.kind().clone();
                let inserted = std::mem::take(lines);
                let n = inserted.len();
                let removed = s.splice(*at, *remove, inserted.clone());
                *remove = n;
                *lines = removed.clone();
                Change { kind, removed, inserted }
            }
            Op::Section { at, section } => match section.take() {
                Some(s) => {
                    let change = Change { kind: s.kind().clone(), removed: Vec::new(), inserted: s.lines().to_vec() };
                    inp.insert_section(*at, s);
                    change
                }
                None => {
                    let s = inp.remove_section_at(*at);
                    let change = Change { kind: s.kind().clone(), removed: s.lines().to_vec(), inserted: Vec::new() };
                    *section = Some(s);
                    change
                }
            },
        }
    }
}

/// A named group of ops, stored in the form that reverts them.
#[derive(Debug, Clone, PartialEq)]
pub struct Transaction {
    pub id: u64,
    pub label: String,
    ops: Vec<Op>,
}

impl Transaction {
    /// Applies the transaction; afterwards it holds the inverse.
    pub fn apply(&mut self, inp: &mut InpFile) -> Vec<Change> {
        let changes = self.ops.iter_mut().map(|op| op.apply(inp)).collect();
        self.ops.reverse();
        changes
    }

    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }
}

/// Builds a transaction, applying each op immediately so that later lookups see the
/// file as edited so far.
pub struct Tx<'a> {
    inp: &'a mut InpFile,
    /// Inverses of the applied ops, in application order.
    done: Vec<Op>,
    changes: Vec<Change>,
}

impl<'a> Tx<'a> {
    pub fn new(inp: &'a mut InpFile) -> Tx<'a> {
        Tx { inp, done: Vec::new(), changes: Vec::new() }
    }

    pub fn inp(&self) -> &InpFile {
        self.inp
    }

    fn push(&mut self, mut op: Op) {
        self.changes.push(op.apply(self.inp));
        self.done.push(op);
    }

    pub fn splice(&mut self, section: usize, at: usize, remove: usize, lines: Vec<Line>) {
        if remove == 0 && lines.is_empty() {
            return;
        }
        self.push(Op::Splice { section, at, remove, lines });
    }

    pub fn replace_line(&mut self, section: usize, at: usize, line: Line) {
        if self.inp.sections()[section].lines().get(at) == Some(&line) {
            return;
        }
        self.splice(section, at, 1, vec![line]);
    }

    pub fn insert_line(&mut self, section: usize, at: usize, line: Line) {
        self.splice(section, at, 0, vec![line]);
    }

    pub fn remove_line(&mut self, section: usize, at: usize) {
        self.splice(section, at, 1, Vec::new());
    }

    /// Index of the first section of this kind, creating it at its canonical position
    /// (with blank lines around it, like the EPA GUI) when missing.
    pub fn ensure_section(&mut self, kind: &SectionKind) -> usize {
        if let Some(i) = self.inp.sections().iter().position(|s| s.kind() == kind) {
            return i;
        }
        let ending = self.inp.line_ending();
        let at = self.inp.canonical_position(kind);
        if let Some(prev) = at.checked_sub(1) {
            let lines = self.inp.sections()[prev].lines();
            if let Some(last) = lines.last().filter(|l| l.ending() == LineEnding::None) {
                let mut fixed = last.clone();
                fixed.set_ending(ending);
                let i = lines.len() - 1;
                self.replace_line(prev, i, fixed);
            }
            let lines = self.inp.sections()[prev].lines();
            if lines.last().is_none_or(|l| l.kind() != LineKind::Blank) {
                let n = lines.len();
                self.insert_line(prev, n, Line::from_text("", ending, false));
            }
        }
        let mut section = Section::new(kind.clone(), ending);
        if at < self.inp.sections().len() {
            section.insert_line(0, Line::from_text("", ending, false));
        }
        self.push(Op::Section { at, section: Some(section) });
        at
    }

    /// Appends a data line to the first section of this kind (created if needed).
    pub fn append<S: AsRef<str>>(&mut self, kind: &SectionKind, tokens: &[S]) -> (usize, usize) {
        let s = self.ensure_section(kind);
        let at = self.inp.sections()[s].append_index();
        let line = Line::from_tokens(tokens, None, self.inp.line_ending());
        self.insert_line(s, at, line);
        (s, at)
    }

    /// Reverts everything applied so far.
    pub fn rollback(mut self) {
        for op in self.done.iter_mut().rev() {
            op.apply(self.inp);
        }
    }

    /// The transaction that undoes this one, and the lines changed.
    fn commit(mut self, id: u64, label: String) -> (Transaction, Vec<Change>) {
        self.done.reverse();
        (Transaction { id, label, ops: self.done }, self.changes)
    }
}

/// An applied edit.
#[derive(Debug)]
pub struct Applied<T> {
    pub label: String,
    pub changes: Vec<Change>,
    pub value: T,
}

/// Undo and redo stacks.
#[derive(Debug)]
pub struct History {
    undo: Vec<Transaction>,
    redo: Vec<Transaction>,
    next_id: u64,
    /// Top of the undo stack when the file was last saved (`Some(None)`: empty stack).
    saved: Option<Option<u64>>,
    limit: usize,
}

impl Default for History {
    fn default() -> Self {
        History { undo: Vec::new(), redo: Vec::new(), next_id: 1, saved: Some(None), limit: 500 }
    }
}

impl History {
    /// Runs `f` as one transaction on `inp`. On error the file is left unchanged. An edit
    /// that changes nothing is not recorded.
    pub fn edit<T>(
        &mut self,
        inp: &mut InpFile,
        label: impl Into<String>,
        f: impl FnOnce(&mut Tx) -> EditResult<T>,
    ) -> EditResult<Applied<T>> {
        let mut tx = Tx::new(inp);
        let value = match f(&mut tx) {
            Ok(v) => v,
            Err(e) => {
                tx.rollback();
                return Err(e);
            }
        };
        let label = label.into();
        let (t, changes) = tx.commit(self.next_id, label.clone());
        if !t.is_empty() {
            self.next_id += 1;
            self.undo.push(t);
            self.redo.clear();
            if self.undo.len() > self.limit {
                self.undo.remove(0);
            }
        }
        Ok(Applied { label, changes, value })
    }

    /// Undoes the last edit; `None` when there is nothing to undo.
    pub fn undo(&mut self, inp: &mut InpFile) -> Option<Applied<()>> {
        let mut t = self.undo.pop()?;
        let changes = t.apply(inp);
        let label = t.label.clone();
        self.redo.push(t);
        Some(Applied { label, changes, value: () })
    }

    pub fn redo(&mut self, inp: &mut InpFile) -> Option<Applied<()>> {
        let mut t = self.redo.pop()?;
        let changes = t.apply(inp);
        let label = t.label.clone();
        self.undo.push(t);
        Some(Applied { label, changes, value: () })
    }

    pub fn undo_label(&self) -> Option<&str> {
        self.undo.last().map(|t| t.label.as_str())
    }

    pub fn redo_label(&self) -> Option<&str> {
        self.redo.last().map(|t| t.label.as_str())
    }

    /// The file differs from the last saved state.
    pub fn is_dirty(&self) -> bool {
        self.saved != Some(self.undo.last().map(|t| t.id))
    }

    pub fn mark_saved(&mut self) {
        self.saved = Some(self.undo.last().map(|t| t.id));
    }

    /// Number of edits since the model was opened (changes on every edit, undo or redo).
    pub fn state_id(&self) -> (usize, u64) {
        (self.undo.len(), self.undo.last().map_or(0, |t| t.id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = "[TITLE]\r\nDemo\r\n\r\n[JUNCTIONS]\r\n;;Name Elev\r\nJ1  100  2\r\nJ2  99   2\r\n\r\n[CONDUITS]\r\nC1 J1 J2 10 0.01 0 0";

    #[test]
    fn undo_redo_restore_bytes() {
        let mut inp = InpFile::parse_str(SRC);
        let mut h = History::default();
        assert!(!h.is_dirty());
        let a = h
            .edit(&mut inp, "edit", |tx| {
                let s = tx.ensure_section(&SectionKind::Junctions);
                let mut l = tx.inp().sections()[s].lines()[1].clone();
                l.set_token(1, "101");
                tx.replace_line(s, 1, l);
                tx.append(&SectionKind::Junctions, &["J3", "98", "2"]);
                tx.append(&SectionKind::Coordinates, &["J3", "1", "2"]);
                tx.append(&SectionKind::Raingages, &["RG1", "INTENSITY", "1:00", "1.0", "TIMESERIES", "TS1"]);
                Ok(7)
            })
            .unwrap();
        assert_eq!(a.value, 7);
        assert!(a.changes.iter().any(|c| c.kind == SectionKind::Coordinates));
        let edited = inp.to_string_lossy();
        assert!(edited.contains("J1  101  2\r\nJ2  99   2\r\nJ3               98         2\r\n\r\n[CONDUITS]"));
        assert!(edited.contains("[RAINGAGES]\r\nRG1"), "{edited}");
        // The last section had no final line ending: one was added before the new section.
        assert!(edited.contains("C1 J1 J2 10 0.01 0 0\r\n\r\n[COORDINATES]\r\nJ3"), "{edited}");
        assert_eq!(InpFile::parse_str(&edited).to_string_lossy(), edited);
        assert!(h.is_dirty());
        assert_eq!(h.undo_label(), Some("edit"));
        h.undo(&mut inp).unwrap();
        assert_eq!(inp.to_string_lossy(), SRC);
        assert!(!h.is_dirty());
        h.redo(&mut inp).unwrap();
        assert_eq!(inp.to_string_lossy(), edited);
        h.mark_saved();
        assert!(!h.is_dirty());
        h.undo(&mut inp);
        assert!(h.is_dirty());
        assert!(h.undo(&mut inp).is_none());
    }

    #[test]
    fn failed_edit_rolls_back() {
        let mut inp = InpFile::parse_str(SRC);
        let mut h = History::default();
        let r: EditResult<Applied<()>> = h.edit(&mut inp, "bad", |tx| {
            tx.append(&SectionKind::Outfalls, &["O1", "90", "FREE"]);
            Err("nope".into())
        });
        assert_eq!(r.unwrap_err(), "nope");
        assert_eq!(inp.to_string_lossy(), SRC);
        assert!(h.undo_label().is_none());
        // A no-op edit is not recorded.
        h.edit(&mut inp, "nothing", |_| Ok(())).unwrap();
        assert!(h.undo_label().is_none() && !h.is_dirty());
    }

    #[test]
    fn new_edit_clears_redo_and_saved_state() {
        let mut inp = InpFile::parse_str(SRC);
        let mut h = History::default();
        let add = |h: &mut History, inp: &mut InpFile, id: &str| {
            h.edit(inp, id, |tx| {
                tx.append(&SectionKind::Junctions, &[id, "1", "1"]);
                Ok(())
            })
            .unwrap();
        };
        add(&mut h, &mut inp, "A");
        h.mark_saved();
        h.undo(&mut inp);
        add(&mut h, &mut inp, "B");
        assert!(h.redo_label().is_none());
        assert!(h.is_dirty());
        h.undo(&mut inp);
        // Back to the original file, which was not the saved one.
        assert_eq!(inp.to_string_lossy(), SRC);
        assert!(h.is_dirty());
    }
}
