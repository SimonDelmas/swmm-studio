//! Control rules (`[CONTROLS]`): syntax and the objects they name, checked line by line
//! the way SWMM reads them.
//!
//! ```text
//! RULE id
//! IF   condition            (AND / OR condition …)
//! THEN action               (AND action …)
//! ELSE action               (AND action …)
//! PRIORITY value
//! ```
//!
//! A condition is `object id attribute relation value`, `object id attribute relation
//! object id attribute`, `SIMULATION attribute relation value`, or a variable or expression
//! (`VARIABLE name = object id attribute`, `EXPRESSION name = …`) compared with a value.
//! An action is `object id STATUS|SETTING = value`, the value being a number, a word,
//! `CURVE id`, `TIMESERIES id` or `PID kp ki kd`.

use std::collections::HashSet;

use serde::Serialize;
use swmm_inp::{InpFile, Line, LineEnding, LineKind, SectionKind};

use crate::refs;
use crate::schema::RefKind;
use crate::validate::Severity;

/// A problem on one line of the section.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RuleIssue {
    pub severity: Severity,
    pub code: &'static str,
    pub message: String,
    /// Index of the line in the section (0 = the first line after the header).
    pub line: usize,
    /// Rule the line belongs to, if any.
    pub rule: Option<String>,
}

/// Names of the model that rules can refer to (upper case, as SWMM compares them).
pub struct Names {
    sections: Vec<(SectionKind, HashSet<String>)>,
    curves: HashSet<String>,
    timeseries: HashSet<String>,
}

const NODE_SECTIONS: [SectionKind; 4] =
    [SectionKind::Junctions, SectionKind::Outfalls, SectionKind::Dividers, SectionKind::Storage];
const LINK_SECTIONS: [SectionKind; 5] =
    [SectionKind::Conduits, SectionKind::Pumps, SectionKind::Orifices, SectionKind::Weirs, SectionKind::Outlets];

impl Names {
    pub fn of(inp: &InpFile) -> Names {
        let ids = |k: &SectionKind| -> HashSet<String> {
            inp.rows(k).filter_map(|l| l.token(0)).map(|s| s.to_ascii_uppercase()).collect()
        };
        let mut sections: Vec<(SectionKind, HashSet<String>)> =
            NODE_SECTIONS.iter().chain(&LINK_SECTIONS).map(|k| (k.clone(), ids(k))).collect();
        sections.push((SectionKind::Raingages, ids(&SectionKind::Raingages)));
        sections.push((SectionKind::Subcatchments, ids(&SectionKind::Subcatchments)));
        let upper = |k| refs::names(inp, k).into_iter().map(|s| s.to_ascii_uppercase()).collect();
        Names { sections, curves: upper(RefKind::Curve), timeseries: upper(RefKind::Timeseries) }
    }

    fn in_sections(&self, kinds: &[SectionKind], id: &str) -> bool {
        let id = id.to_ascii_uppercase();
        self.sections.iter().any(|(k, s)| kinds.contains(k) && s.contains(&id))
    }
}

/// An object keyword of a condition or action.
#[derive(Clone, Copy, PartialEq)]
enum Obj {
    Node,
    Link,
    Conduit,
    Pump,
    Orifice,
    Weir,
    Outlet,
    Gage,
    Subcatch,
}

impl Obj {
    fn parse(word: &str) -> Option<Obj> {
        Some(match word.to_ascii_uppercase().as_str() {
            "NODE" => Obj::Node,
            "LINK" => Obj::Link,
            "CONDUIT" => Obj::Conduit,
            "PUMP" => Obj::Pump,
            "ORIFICE" => Obj::Orifice,
            "WEIR" => Obj::Weir,
            "OUTLET" => Obj::Outlet,
            "GAGE" => Obj::Gage,
            "SUBCATCH" | "SUBCATCHMENT" => Obj::Subcatch,
            _ => return None,
        })
    }

    fn word(self) -> &'static str {
        match self {
            Obj::Node => "node",
            Obj::Link => "link",
            Obj::Conduit => "conduit",
            Obj::Pump => "pump",
            Obj::Orifice => "orifice",
            Obj::Weir => "weir",
            Obj::Outlet => "outlet",
            Obj::Gage => "rain gage",
            Obj::Subcatch => "subcatchment",
        }
    }

    fn sections(self) -> &'static [SectionKind] {
        match self {
            Obj::Node => &NODE_SECTIONS,
            Obj::Link => &LINK_SECTIONS,
            Obj::Conduit => &[SectionKind::Conduits],
            Obj::Pump => &[SectionKind::Pumps],
            Obj::Orifice => &[SectionKind::Orifices],
            Obj::Weir => &[SectionKind::Weirs],
            Obj::Outlet => &[SectionKind::Outlets],
            Obj::Gage => &[SectionKind::Raingages],
            Obj::Subcatch => &[SectionKind::Subcatchments],
        }
    }

    /// Attributes a condition can test (SWMM 5.2).
    fn attributes(self) -> &'static [&'static str] {
        match self {
            Obj::Node => &["DEPTH", "MAXDEPTH", "HEAD", "VOLUME", "INFLOW"],
            Obj::Gage => &["INTENSITY"],
            Obj::Subcatch => &["RUNOFF"],
            _ => &[
                "FLOW",
                "FULLFLOW",
                "DEPTH",
                "MAXDEPTH",
                "VELOCITY",
                "LENGTH",
                "SLOPE",
                "STATUS",
                "SETTING",
                "TIMEOPEN",
                "TIMECLOSED",
            ],
        }
    }
}

const SIMULATION_ATTRIBUTES: [&str; 6] = ["TIME", "DATE", "CLOCKTIME", "DAYOFYEAR", "DAY", "MONTH"];
const RELATIONS: [&str; 6] = ["=", "<>", "<", "<=", ">", ">="];

/// Words that start a line of the section; highlighted by the editor.
pub const KEYWORDS: [&str; 10] =
    ["RULE", "IF", "AND", "OR", "THEN", "ELSE", "PRIORITY", "VARIABLE", "EXPRESSION", "SIMULATION"];

/// Where the clauses of the current rule are.
#[derive(Clone, Copy, PartialEq, PartialOrd)]
enum Part {
    /// After `RULE`, before `IF`.
    Start,
    If,
    Then,
    Else,
    Priority,
}

struct Checker<'a> {
    names: &'a Names,
    variables: HashSet<String>,
    rules: HashSet<String>,
    rule: Option<String>,
    rule_line: usize,
    part: Part,
    out: Vec<RuleIssue>,
}

impl Checker<'_> {
    fn push(&mut self, line: usize, severity: Severity, code: &'static str, message: String) {
        let message = match &self.rule {
            Some(r) => format!("rule {r}: {message}"),
            None => message,
        };
        self.out.push(RuleIssue { severity, code, message, line, rule: self.rule.clone() });
    }

    fn error(&mut self, line: usize, code: &'static str, message: String) {
        self.push(line, Severity::Error, code, message);
    }

    /// Ends the current rule: it must have a condition and an action.
    fn close(&mut self) {
        if self.rule.is_none() {
            return;
        }
        let at = self.rule_line;
        match self.part {
            Part::Start => self.error(at, "rule_syntax", "has no IF condition".into()),
            Part::If => self.error(at, "rule_syntax", "has no THEN action".into()),
            _ => {}
        }
        self.rule = None;
    }

    /// `object id` at `t[0..2]`; returns the object and how many tokens it took.
    fn object(&mut self, line: usize, t: &[&str], what: &str) -> Option<Obj> {
        let Some(&word) = t.first() else {
            self.error(line, "rule_syntax", format!("{what} is missing"));
            return None;
        };
        let Some(obj) = Obj::parse(word) else {
            self.error(line, "rule_syntax", format!("{word} is not an object type (NODE, LINK, PUMP…)"));
            return None;
        };
        let Some(&id) = t.get(1) else {
            self.error(line, "rule_syntax", format!("the {} has no name", obj.word()));
            return None;
        };
        if !self.names.in_sections(obj.sections(), id) {
            self.error(line, "unknown_rule_object", format!("{} {id} does not exist", obj.word()));
        }
        Some(obj)
    }

    /// `object id attribute` (or `SIMULATION attribute`, or a variable): tokens taken, or None.
    fn operand(&mut self, line: usize, t: &[&str]) -> Option<usize> {
        let Some(&first) = t.first() else {
            self.error(line, "rule_syntax", "the condition is empty".into());
            return None;
        };
        let up = first.to_ascii_uppercase();
        if up == "SIMULATION" {
            let Some(&attr) = t.get(1) else {
                self.error(line, "rule_syntax", "SIMULATION needs an attribute (TIME, DATE…)".into());
                return None;
            };
            if !SIMULATION_ATTRIBUTES.contains(&attr.to_ascii_uppercase().as_str()) {
                self.push(
                    line,
                    Severity::Warning,
                    "unknown_rule_attribute",
                    format!("SIMULATION {attr}: unknown attribute ({})", SIMULATION_ATTRIBUTES.join(", ")),
                );
            }
            return Some(2);
        }
        if Obj::parse(first).is_none() && self.variables.contains(&up) {
            return Some(1);
        }
        let obj = self.object(line, t, "the condition")?;
        let Some(&attr) = t.get(2) else {
            self.error(line, "rule_syntax", format!("{} {}: the attribute is missing", obj.word(), t[1]));
            return None;
        };
        if !obj.attributes().contains(&attr.to_ascii_uppercase().as_str()) {
            self.push(
                line,
                Severity::Warning,
                "unknown_rule_attribute",
                format!("{attr} is not an attribute of a {} ({})", obj.word(), obj.attributes().join(", ")),
            );
        }
        Some(3)
    }

    fn condition(&mut self, line: usize, t: &[&str]) {
        let Some(n) = self.operand(line, t) else { return };
        let Some(&rel) = t.get(n) else {
            self.error(line, "rule_syntax", "the comparison (=, <, >…) is missing".into());
            return;
        };
        if !RELATIONS.contains(&rel) {
            self.error(line, "rule_syntax", format!("{rel} is not a comparison ({})", RELATIONS.join(" ")));
            return;
        }
        let rhs = &t[n + 1..];
        if rhs.is_empty() {
            self.error(line, "rule_syntax", "the value compared with is missing".into());
        } else if Obj::parse(rhs[0]).is_some() || rhs[0].eq_ignore_ascii_case("SIMULATION") {
            self.operand(line, rhs);
        }
    }

    fn action(&mut self, line: usize, t: &[&str]) {
        let Some(obj) = self.object(line, t, "the action") else { return };
        if matches!(obj, Obj::Node | Obj::Gage | Obj::Subcatch) {
            self.error(line, "rule_syntax", format!("a {} cannot be set by an action", obj.word()));
            return;
        }
        let attr = t.get(2).map(|a| a.to_ascii_uppercase()).unwrap_or_default();
        if attr != "STATUS" && attr != "SETTING" {
            self.error(line, "rule_syntax", "an action sets STATUS or SETTING".into());
            return;
        }
        if t.get(3) != Some(&"=") {
            self.error(line, "rule_syntax", format!("{attr} must be followed by ="));
            return;
        }
        let value = &t[4..];
        let Some(&v) = value.first() else {
            self.error(line, "rule_syntax", "the value set is missing".into());
            return;
        };
        let named = |kw: &str| v.eq_ignore_ascii_case(kw);
        if named("CURVE") || named("TIMESERIES") {
            let (word, set) =
                if named("CURVE") { ("curve", &self.names.curves) } else { ("time series", &self.names.timeseries) };
            match value.get(1) {
                None => self.error(line, "rule_syntax", format!("the {word} has no name")),
                Some(id) if !set.contains(&id.to_ascii_uppercase()) => {
                    self.error(line, "unknown_rule_object", format!("{word} {id} does not exist"))
                }
                _ => {}
            }
        } else if named("PID") {
            if value.len() < 4 || value[1..4].iter().any(|x| x.parse::<f64>().is_err()) {
                self.error(line, "rule_syntax", "PID needs three numbers (gain, integral and derivative times)".into());
            }
        } else if attr == "STATUS" {
            let ok = ["OPEN", "CLOSED", "ON", "OFF"].iter().any(|w| named(w)) || v.parse::<f64>().is_ok();
            if !ok {
                self.error(line, "rule_syntax", format!("STATUS {v}: expected OPEN, CLOSED, ON or OFF"));
            }
        } else if v.parse::<f64>().is_err() && !self.variables.contains(&v.to_ascii_uppercase()) {
            self.error(line, "rule_syntax", format!("SETTING {v} is not a number"));
        }
        if attr == "STATUS" && !matches!(obj, Obj::Conduit | Obj::Pump | Obj::Link) {
            self.push(line, Severity::Warning, "rule_syntax", format!("the STATUS of a {} cannot be set", obj.word()));
        }
        if attr == "SETTING" && obj == Obj::Conduit {
            self.push(line, Severity::Warning, "rule_syntax", "a conduit has no SETTING (use STATUS)".into());
        }
    }

    fn line(&mut self, i: usize, t: &[&str]) {
        let key = t[0].to_ascii_uppercase();
        let rest = &t[1..];
        match key.as_str() {
            "RULE" => {
                self.close();
                let Some(&id) = rest.first() else {
                    self.error(i, "rule_syntax", "RULE has no name".into());
                    return;
                };
                if !self.rules.insert(id.to_ascii_uppercase()) {
                    self.error(i, "duplicate_rule", format!("rule {id} is defined more than once"));
                }
                self.rule = Some(id.to_string());
                self.rule_line = i;
                self.part = Part::Start;
            }
            "VARIABLE" | "EXPRESSION" => {
                self.close();
                let (Some(&name), Some(&"=")) = (rest.first(), rest.get(1)) else {
                    self.error(i, "rule_syntax", format!("{key} name = …"));
                    return;
                };
                if key == "VARIABLE" {
                    if self.object(i, &rest[2..], "the variable").is_some() && rest.len() < 5 {
                        self.error(i, "rule_syntax", format!("variable {name}: the attribute is missing"));
                    }
                } else if rest.len() < 3 {
                    self.error(i, "rule_syntax", format!("expression {name} is empty"));
                }
                self.variables.insert(name.to_ascii_uppercase());
            }
            _ if self.rule.is_none() => {
                self.error(i, "rule_syntax", format!("{} is outside of a rule (a rule starts with RULE name)", t[0]));
            }
            "IF" => {
                if self.part != Part::Start {
                    self.error(i, "rule_syntax", "a rule has one IF".into());
                }
                self.part = Part::If;
                self.condition(i, rest);
            }
            "THEN" => {
                if self.part != Part::If {
                    let msg = if self.part == Part::Start { "THEN before IF" } else { "a rule has one THEN" };
                    self.error(i, "rule_syntax", msg.into());
                }
                self.part = Part::Then;
                self.action(i, rest);
            }
            "ELSE" => {
                if self.part != Part::Then {
                    let msg = if self.part < Part::Then { "ELSE before THEN" } else { "a rule has one ELSE" };
                    self.error(i, "rule_syntax", msg.into());
                }
                self.part = Part::Else;
                self.action(i, rest);
            }
            "AND" | "OR" => match self.part {
                Part::If => self.condition(i, rest),
                Part::Then | Part::Else if key == "AND" => self.action(i, rest),
                Part::Then | Part::Else => self.error(i, "rule_syntax", "actions are joined by AND, not OR".into()),
                _ => self.error(i, "rule_syntax", format!("{key} must follow IF, THEN or ELSE")),
            },
            "PRIORITY" => {
                if self.part < Part::Then {
                    self.error(i, "rule_syntax", "PRIORITY comes after the actions".into());
                }
                self.part = Part::Priority;
                if rest.first().and_then(|v| v.parse::<f64>().ok()).is_none() {
                    self.error(i, "rule_syntax", "PRIORITY needs a number".into());
                }
            }
            _ => self.error(
                i,
                "rule_syntax",
                format!("{} is not a rule keyword (RULE, IF, AND, OR, THEN, ELSE, PRIORITY)", t[0]),
            ),
        }
    }
}

/// Checks the lines of a `[CONTROLS]` section.
pub fn check_lines(lines: &[Line], names: &Names) -> Vec<RuleIssue> {
    let mut c = Checker {
        names,
        variables: HashSet::new(),
        rules: HashSet::new(),
        rule: None,
        rule_line: 0,
        part: Part::Start,
        out: Vec::new(),
    };
    for (i, l) in lines.iter().enumerate() {
        if l.kind() != LineKind::Data {
            continue;
        }
        let t: Vec<&str> = l.tokens().collect();
        if !t.is_empty() {
            c.line(i, &t);
        }
    }
    c.close();
    c.out
}

/// Checks the text of a `[CONTROLS]` section (as in the editor), against the model's names.
pub fn check_text(text: &str, inp: &InpFile) -> Vec<RuleIssue> {
    let lines: Vec<Line> =
        text.split('\n').map(|s| Line::from_text(s.strip_suffix('\r').unwrap_or(s), LineEnding::Lf, false)).collect();
    check_lines(&lines, &Names::of(inp))
}

/// Checks the `[CONTROLS]` section of the model.
pub fn check(inp: &InpFile) -> Vec<RuleIssue> {
    let names = Names::of(inp);
    // Only the first section is edited as text; its line numbers are those of the editor.
    inp.sections()
        .iter()
        .find(|s| *s.kind() == SectionKind::Controls)
        .map(|s| check_lines(s.lines(), &names))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODEL: &str = "\
[RAINGAGES]
RG1 INTENSITY 0:05 1.0 TIMESERIES TS1
[JUNCTIONS]
J1 100 2
[STORAGE]
SU1 90 5 0 FUNCTIONAL 1000 0 0
[CONDUITS]
C1 J1 SU1 10 0.01 0 0
[PUMPS]
P1 SU1 J1 PC1 OFF 0 0
[ORIFICES]
OR1 SU1 J1 SIDE 0 0.65
[CURVES]
PC1 PUMP1 1 1
[TIMESERIES]
TS1 0:00 1
";

    fn run(rules: &str) -> Vec<RuleIssue> {
        check_text(rules, &InpFile::parse_str(MODEL))
    }

    #[test]
    fn accepts_valid_rules() {
        let rules = "\
; comment
VARIABLE V1 = NODE SU1 DEPTH
EXPRESSION E1 = V1 * 2
RULE R1
IF NODE SU1 DEPTH > 4
AND SIMULATION TIME > 1:00
OR LINK C1 FLOW >= NODE J1 INFLOW
THEN PUMP P1 STATUS = ON
AND ORIFICE OR1 SETTING = CURVE PC1
ELSE PUMP P1 STATUS = OFF
AND ORIFICE OR1 SETTING = TIMESERIES ts1
PRIORITY 2

RULE R2
IF V1 > 2
AND GAGE RG1 INTENSITY > 0.5
THEN CONDUIT C1 STATUS = CLOSED
AND ORIFICE OR1 SETTING = PID 0.1 0.5 0
";
        assert_eq!(run(rules), []);
    }

    #[test]
    fn reports_syntax_and_names() {
        let rules = "\
IF NODE J1 DEPTH > 1
RULE R1
IF NODE J9 DEPTH > 1
AND NODE J1 FLOWX < 2
OR NODE J1 DEPTH ~ 2
THEN PUMP P9 STATUS = ON
AND ORIFICE OR1 SETTING = CURVE NOPE
PRIORITY high
RULE R1
THEN PUMP P1 STATUS = ON
RULE R3
IF NODE J1 DEPTH > 1
FOO bar
";
        let issues = run(rules);
        let at = |line: usize| issues.iter().filter(|i| i.line == line).map(|i| i.code).collect::<Vec<_>>();
        assert_eq!(at(0), ["rule_syntax"], "outside of a rule");
        assert_eq!(at(2), ["unknown_rule_object"]);
        assert_eq!(at(3), ["unknown_rule_attribute"]);
        assert_eq!(at(4), ["rule_syntax"], "bad relation");
        assert_eq!(at(5), ["unknown_rule_object"]);
        assert_eq!(at(6), ["unknown_rule_object"], "missing curve");
        assert_eq!(at(7), ["rule_syntax"], "priority");
        assert_eq!(at(8), ["duplicate_rule"]);
        assert_eq!(at(9), ["rule_syntax"], "THEN before IF");
        assert_eq!(at(10), ["rule_syntax"], "no THEN");
        assert_eq!(at(12), ["rule_syntax"], "unknown keyword");
        assert!(issues[1].message.starts_with("rule R1: node J9"), "{}", issues[1].message);
        assert_eq!(issues[1].severity, Severity::Error);
        assert_eq!(issues[2].severity, Severity::Warning);
    }
}
