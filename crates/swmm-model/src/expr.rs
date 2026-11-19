//! Expressions over the values of objects: `diameter < 0.3`, `type = outfall`,
//! `max(flow) > 2 and not id = "C1*"`, `length * slope`.
//!
//! An expression is parsed once ([`parse`]), then compiled against columns of values, one
//! value per object ([`compile`]), and evaluated for each object. Names (`diameter`) and
//! calls (`max(flow)`) are resolved by the caller ([`Columns`]): this module knows nothing
//! of models or results. Selection queries and bulk edits share it.
//!
//! Syntax (case-insensitive keywords and names):
//! - numbers (`0.3`, `1e-3`), texts (`'a b'`, `"C1"`), names, calls `f(name)`;
//! - `+ - * /`, comparisons `= == != <> < <= > >=`, `and` `or` `not` (or `&& || !`),
//!   parentheses;
//! - texts compare without regard to case; `*` and `?` in a quoted text compared with `=`
//!   or `!=` are wildcards (`id = "C1*"`);
//! - a bare word compared with a text (`type = outfall`) is a text;
//! - a comparison with a missing value (NaN: an attribute the object does not have) is false.

use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Num(f64),
    /// A quoted text.
    Text(String),
    Name(String),
    /// `func(name)`.
    Call(String, String),
    Neg(Box<Expr>),
    Not(Box<Expr>),
    Binary(BinOp, Box<Expr>, Box<Expr>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Or,
    And,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Add,
    Sub,
    Mul,
    Div,
}

impl BinOp {
    fn is_comparison(self) -> bool {
        matches!(self, BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge)
    }
}

/// Why an expression could not be read or used; `at` is a character offset in the text
/// (the end for an unfinished expression).
#[derive(Debug, Clone, PartialEq)]
pub struct ExprError {
    pub message: String,
    pub at: Option<usize>,
}

impl ExprError {
    fn at(message: impl Into<String>, at: usize) -> ExprError {
        ExprError { message: message.into(), at: Some(at) }
    }

    fn new(message: impl Into<String>) -> ExprError {
        ExprError { message: message.into(), at: None }
    }
}

impl fmt::Display for ExprError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self.at {
            Some(at) => write!(f, "{} (at character {})", self.message, at + 1),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for ExprError {}

// ---------------------------------------------------------------------------------------
// Parsing

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Text(String),
    Word(String),
    Op(&'static str),
    End,
}

fn tokenize(src: &str) -> Result<Vec<(Tok, usize)>, ExprError> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let start = i;
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c.is_ascii_digit() || (c == '.' && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit())) {
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            // Exponent: `1e-3`, `2E5`.
            if i < chars.len() && (chars[i] == 'e' || chars[i] == 'E') {
                let mut j = i + 1;
                if j < chars.len() && (chars[j] == '+' || chars[j] == '-') {
                    j += 1;
                }
                if j < chars.len() && chars[j].is_ascii_digit() {
                    i = j;
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                }
            }
            let text: String = chars[start..i].iter().collect();
            let n = text.parse::<f64>().map_err(|_| ExprError::at(format!("bad number {text}"), start))?;
            out.push((Tok::Num(n), start));
        } else if c.is_alphabetic() || c == '_' {
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            out.push((Tok::Word(chars[start..i].iter().collect()), start));
        } else if c == '"' || c == '\'' {
            i += 1;
            let mut text = String::new();
            loop {
                match chars.get(i) {
                    None => return Err(ExprError::at("text not closed", start)),
                    Some(&q) if q == c => {
                        // A doubled quote stands for itself.
                        if chars.get(i + 1) == Some(&c) {
                            text.push(c);
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    }
                    Some(&ch) => {
                        text.push(ch);
                        i += 1;
                    }
                }
            }
            out.push((Tok::Text(text), start));
        } else {
            const OPS: [&str; 18] =
                ["==", "!=", "<>", "<=", ">=", "&&", "||", "=", "<", ">", "!", "+", "-", "*", "/", "(", ")", ","];
            let rest: String = chars[i..chars.len().min(i + 2)].iter().collect();
            let Some(op) = OPS.iter().find(|op| rest.starts_with(**op)) else {
                return Err(ExprError::at(format!("unexpected character {c:?}"), start));
            };
            i += op.chars().count();
            out.push((Tok::Op(op), start));
        }
    }
    out.push((Tok::End, chars.len()));
    Ok(out)
}

struct Parser {
    toks: Vec<(Tok, usize)>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> &Tok {
        &self.toks[self.pos].0
    }

    fn offset(&self) -> usize {
        self.toks[self.pos].1
    }

    fn next(&mut self) -> Tok {
        let t = self.toks[self.pos].0.clone();
        if t != Tok::End {
            self.pos += 1;
        }
        t
    }

    /// The next token is the keyword `kw` (or one of the operators `ops`): consumes it.
    fn eat(&mut self, kw: &str, ops: &[&str]) -> bool {
        let hit = match self.peek() {
            Tok::Word(w) => !kw.is_empty() && w.eq_ignore_ascii_case(kw),
            Tok::Op(o) => ops.contains(o),
            _ => false,
        };
        if hit {
            self.pos += 1;
        }
        hit
    }

    fn or(&mut self) -> Result<Expr, ExprError> {
        let mut e = self.and()?;
        while self.eat("or", &["||"]) {
            e = Expr::Binary(BinOp::Or, Box::new(e), Box::new(self.and()?));
        }
        Ok(e)
    }

    fn and(&mut self) -> Result<Expr, ExprError> {
        let mut e = self.not()?;
        while self.eat("and", &["&&"]) {
            e = Expr::Binary(BinOp::And, Box::new(e), Box::new(self.not()?));
        }
        Ok(e)
    }

    fn not(&mut self) -> Result<Expr, ExprError> {
        if self.eat("not", &["!"]) {
            return Ok(Expr::Not(Box::new(self.not()?)));
        }
        self.comparison()
    }

    fn comparison(&mut self) -> Result<Expr, ExprError> {
        let e = self.sum()?;
        let op = match self.peek() {
            Tok::Op("=" | "==") => BinOp::Eq,
            Tok::Op("!=" | "<>") => BinOp::Ne,
            Tok::Op("<") => BinOp::Lt,
            Tok::Op("<=") => BinOp::Le,
            Tok::Op(">") => BinOp::Gt,
            Tok::Op(">=") => BinOp::Ge,
            _ => return Ok(e),
        };
        self.next();
        Ok(Expr::Binary(op, Box::new(e), Box::new(self.sum()?)))
    }

    fn sum(&mut self) -> Result<Expr, ExprError> {
        let mut e = self.product()?;
        loop {
            let op = match self.peek() {
                Tok::Op("+") => BinOp::Add,
                Tok::Op("-") => BinOp::Sub,
                _ => return Ok(e),
            };
            self.next();
            e = Expr::Binary(op, Box::new(e), Box::new(self.product()?));
        }
    }

    fn product(&mut self) -> Result<Expr, ExprError> {
        let mut e = self.unary()?;
        loop {
            let op = match self.peek() {
                Tok::Op("*") => BinOp::Mul,
                Tok::Op("/") => BinOp::Div,
                _ => return Ok(e),
            };
            self.next();
            e = Expr::Binary(op, Box::new(e), Box::new(self.unary()?));
        }
    }

    fn unary(&mut self) -> Result<Expr, ExprError> {
        if self.eat("", &["-"]) {
            return Ok(Expr::Neg(Box::new(self.unary()?)));
        }
        if self.eat("", &["+"]) {
            return self.unary();
        }
        self.primary()
    }

    fn primary(&mut self) -> Result<Expr, ExprError> {
        let at = self.offset();
        match self.next() {
            Tok::Num(n) => Ok(Expr::Num(n)),
            Tok::Text(t) => Ok(Expr::Text(t)),
            Tok::Op("(") => {
                let e = self.or()?;
                if !self.eat("", &[")"]) {
                    return Err(ExprError::at("missing )", self.offset()));
                }
                Ok(e)
            }
            Tok::Word(w) if ["and", "or", "not"].iter().any(|k| w.eq_ignore_ascii_case(k)) => {
                Err(ExprError::at(format!("a value is expected before {w:?}"), at))
            }
            Tok::Word(w) => {
                if !self.eat("", &["("]) {
                    return Ok(Expr::Name(w));
                }
                let arg_at = self.offset();
                let Tok::Word(arg) = self.next() else {
                    return Err(ExprError::at(format!("{w}( takes a name, like {w}(flow)"), arg_at));
                };
                if !self.eat("", &[")"]) {
                    return Err(ExprError::at("missing )", self.offset()));
                }
                Ok(Expr::Call(w, arg))
            }
            Tok::End => Err(ExprError::at("the expression is not finished", at)),
            Tok::Op(o) => Err(ExprError::at(format!("unexpected {o}"), at)),
        }
    }
}

/// Reads an expression.
pub fn parse(src: &str) -> Result<Expr, ExprError> {
    let mut p = Parser { toks: tokenize(src)?, pos: 0 };
    if *p.peek() == Tok::End {
        return Err(ExprError::new("the expression is empty"));
    }
    let e = p.or()?;
    match p.peek() {
        Tok::End => Ok(e),
        _ => Err(ExprError::at("an operator (and, or, =, <…) is expected here", p.offset())),
    }
}

impl Expr {
    /// Names and calls the expression uses, in order of appearance (with repeats):
    /// `(None, "diameter")`, `(Some("max"), "flow")`.
    pub fn references(&self) -> Vec<(Option<&str>, &str)> {
        let mut out = Vec::new();
        self.walk(&mut |e| match e {
            Expr::Name(n) => out.push((None, n.as_str())),
            Expr::Call(f, n) => out.push((Some(f.as_str()), n.as_str())),
            _ => {}
        });
        out
    }

    fn walk<'a>(&'a self, f: &mut impl FnMut(&'a Expr)) {
        f(self);
        match self {
            Expr::Neg(e) | Expr::Not(e) => e.walk(f),
            Expr::Binary(_, a, b) => {
                a.walk(f);
                b.walk(f);
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------------------
// Compilation and evaluation

/// Values of a name for every object (NaN or empty text: the object has none).
#[derive(Debug, Clone, PartialEq)]
pub enum Column {
    Num(Vec<f32>),
    Text(Vec<String>),
}

impl Column {
    fn len(&self) -> usize {
        match self {
            Column::Num(v) => v.len(),
            Column::Text(v) => v.len(),
        }
    }
}

/// Resolves the names and calls of an expression to columns.
pub trait Columns {
    /// Column of `name` (`func`: of `func(name)`); `Ok(None)` when the name is unknown.
    fn column(&mut self, func: Option<&str>, name: &str) -> Result<Option<Column>, String>;
}

/// What an expression gives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Type {
    Num,
    Text,
    Bool,
}

impl Type {
    fn name(self) -> &'static str {
        match self {
            Type::Num => "a number",
            Type::Text => "a text",
            Type::Bool => "a condition",
        }
    }
}

#[derive(Debug)]
enum Node {
    Num(f64),
    /// Lower-case text; `glob`: has `*` or `?` wildcards.
    Text {
        text: String,
        glob: bool,
    },
    NumCol(usize),
    TextCol(usize),
    Neg(Box<Node>),
    Not(Box<Node>),
    Bin(BinOp, Box<Node>, Box<Node>),
}

/// An expression ready to be evaluated for each object.
#[derive(Debug)]
pub struct Program {
    root: Node,
    ty: Type,
    nums: Vec<Vec<f32>>,
    texts: Vec<Vec<String>>,
    len: usize,
}

#[derive(Debug, Clone, Copy)]
enum Val<'a> {
    N(f64),
    T(&'a str, bool),
    B(bool),
}

struct Compiler<'c, C: Columns> {
    cols: &'c mut C,
    nums: Vec<Vec<f32>>,
    texts: Vec<Vec<String>>,
    /// Columns already read, by reference (`func`, `name`, lower-case).
    seen: Vec<((Option<String>, String), Type, usize)>,
    /// Number of objects: every column must have this many values.
    len: usize,
}

/// A compiled node, or a bare word that is not a known name (a text, if compared with one).
enum Compiled {
    Node(Node, Type),
    Word(String),
}

fn unknown(word: &str) -> ExprError {
    ExprError::new(format!("unknown name {word:?}"))
}

fn column_node(ty: Type, i: usize) -> Node {
    if ty == Type::Text {
        Node::TextCol(i)
    } else {
        Node::NumCol(i)
    }
}

fn text_node(s: &str) -> Node {
    Node::Text { text: s.to_lowercase(), glob: s.contains(['*', '?']) }
}

impl<C: Columns> Compiler<'_, C> {
    fn reference(&mut self, func: Option<&str>, name: &str) -> Result<Option<(Node, Type)>, ExprError> {
        let key = (func.map(str::to_lowercase), name.to_lowercase());
        if let Some(&(_, ty, i)) = self.seen.iter().find(|(k, ..)| *k == key) {
            return Ok(Some((column_node(ty, i), ty)));
        }
        let Some(col) = self.cols.column(func, name).map_err(ExprError::new)? else {
            return Ok(None);
        };
        if col.len() != self.len {
            return Err(ExprError::new(format!("{name} has {} values, not {}", col.len(), self.len)));
        }
        let (ty, i) = match col {
            Column::Num(v) => {
                self.nums.push(v);
                (Type::Num, self.nums.len() - 1)
            }
            Column::Text(v) => {
                self.texts.push(v.into_iter().map(|s| s.to_lowercase()).collect());
                (Type::Text, self.texts.len() - 1)
            }
        };
        self.seen.push((key, ty, i));
        Ok(Some((column_node(ty, i), ty)))
    }

    fn compile(&mut self, e: &Expr) -> Result<Compiled, ExprError> {
        let node = |n, t| Ok(Compiled::Node(n, t));
        match e {
            Expr::Num(x) => node(Node::Num(*x), Type::Num),
            Expr::Text(s) => node(text_node(s), Type::Text),
            Expr::Name(n) => match self.reference(None, n)? {
                Some((n, t)) => node(n, t),
                None => Ok(Compiled::Word(n.clone())),
            },
            Expr::Call(f, n) => match self.reference(Some(f), n)? {
                Some((n, t)) => node(n, t),
                None => Err(ExprError::new(format!("unknown name {f}({n})"))),
            },
            Expr::Neg(a) => {
                let a = self.typed(a, Type::Num, "-")?;
                node(Node::Neg(Box::new(a)), Type::Num)
            }
            Expr::Not(a) => {
                let a = self.typed(a, Type::Bool, "not")?;
                node(Node::Not(Box::new(a)), Type::Bool)
            }
            Expr::Binary(op, a, b) if op.is_comparison() => {
                let (a, b) = (self.compile(a)?, self.compile(b)?);
                // A bare word facing a text is a text (`type = outfall`).
                let (a, ta, b, tb) = match (a, b) {
                    (Compiled::Node(a, ta), Compiled::Node(b, tb)) => (a, ta, b, tb),
                    (Compiled::Node(a, Type::Text), Compiled::Word(w)) => (a, Type::Text, text_node(&w), Type::Text),
                    (Compiled::Word(w), Compiled::Node(b, Type::Text)) => (text_node(&w), Type::Text, b, Type::Text),
                    (Compiled::Word(w), _) | (_, Compiled::Word(w)) => return Err(unknown(&w)),
                };
                if ta == Type::Bool || tb == Type::Bool || ta != tb {
                    return Err(ExprError::new(format!("cannot compare {} with {}", ta.name(), tb.name())));
                }
                node(Node::Bin(*op, Box::new(a), Box::new(b)), Type::Bool)
            }
            Expr::Binary(op, a, b) => {
                let (want, sym, ty) = match op {
                    BinOp::And => (Type::Bool, "and", Type::Bool),
                    BinOp::Or => (Type::Bool, "or", Type::Bool),
                    BinOp::Add => (Type::Num, "+", Type::Num),
                    BinOp::Sub => (Type::Num, "-", Type::Num),
                    BinOp::Mul => (Type::Num, "*", Type::Num),
                    _ => (Type::Num, "/", Type::Num),
                };
                let a = self.typed(a, want, sym)?;
                let b = self.typed(b, want, sym)?;
                node(Node::Bin(*op, Box::new(a), Box::new(b)), ty)
            }
        }
    }

    fn typed(&mut self, e: &Expr, want: Type, op: &str) -> Result<Node, ExprError> {
        match self.compile(e)? {
            Compiled::Node(n, t) if t == want => Ok(n),
            Compiled::Node(_, t) => Err(ExprError::new(format!("{op} needs {}, not {}", want.name(), t.name()))),
            Compiled::Word(w) => Err(unknown(&w)),
        }
    }
}

/// Resolves the names of an expression for `len` objects.
pub fn compile(e: &Expr, columns: &mut impl Columns, len: usize) -> Result<Program, ExprError> {
    let mut c = Compiler { cols: columns, nums: Vec::new(), texts: Vec::new(), seen: Vec::new(), len };
    let (root, ty) = match c.compile(e)? {
        Compiled::Node(n, t) => (n, t),
        Compiled::Word(w) => return Err(unknown(&w)),
    };
    Ok(Program { root, ty, nums: c.nums, texts: c.texts, len })
}

/// `*` any run of characters, `?` one character (both lower-case already).
fn glob(pattern: &str, s: &str) -> bool {
    let (p, s): (Vec<char>, Vec<char>) = (pattern.chars().collect(), s.chars().collect());
    let (mut pi, mut si) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while si < s.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == s[si]) {
            pi += 1;
            si += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, si));
            pi += 1;
        } else if let Some((sp, ss)) = star {
            pi = sp + 1;
            si = ss + 1;
            star = Some((sp, ss + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

impl Program {
    /// What the expression gives.
    pub fn ty(&self) -> Type {
        self.ty
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    fn eval<'a>(&'a self, n: &'a Node, i: usize) -> Val<'a> {
        match n {
            Node::Num(x) => Val::N(*x),
            Node::Text { text, glob } => Val::T(text, *glob),
            Node::NumCol(c) => Val::N(self.nums[*c][i] as f64),
            Node::TextCol(c) => Val::T(&self.texts[*c][i], false),
            Node::Neg(a) => Val::N(-self.num(a, i)),
            Node::Not(a) => Val::B(!self.cond(a, i)),
            Node::Bin(BinOp::And, a, b) => Val::B(self.cond(a, i) && self.cond(b, i)),
            Node::Bin(BinOp::Or, a, b) => Val::B(self.cond(a, i) || self.cond(b, i)),
            Node::Bin(op, a, b) => match (self.eval(a, i), self.eval(b, i)) {
                (Val::N(x), Val::N(y)) => match op {
                    BinOp::Add => Val::N(x + y),
                    BinOp::Sub => Val::N(x - y),
                    BinOp::Mul => Val::N(x * y),
                    BinOp::Div => Val::N(x / y),
                    // A missing value matches nothing (`!=` included).
                    _ if x.is_nan() || y.is_nan() => Val::B(false),
                    // Values are stored as f32: `0.3` must equal a stored 0.3.
                    _ => Val::B(compare(*op, (x as f32).partial_cmp(&(y as f32)))),
                },
                (Val::T(x, gx), Val::T(y, gy)) => Val::B(match op {
                    BinOp::Eq | BinOp::Ne if gx || gy => {
                        let hit = if gy { glob(y, x) } else { glob(x, y) };
                        hit == (*op == BinOp::Eq)
                    }
                    _ => compare(*op, Some(x.cmp(y))),
                }),
                _ => Val::B(false),
            },
        }
    }

    fn num(&self, n: &Node, i: usize) -> f64 {
        match self.eval(n, i) {
            Val::N(x) => x,
            _ => f64::NAN,
        }
    }

    fn cond(&self, n: &Node, i: usize) -> bool {
        matches!(self.eval(n, i), Val::B(true))
    }

    /// Whether object `i` matches (a condition; false for other expressions).
    pub fn matches(&self, i: usize) -> bool {
        self.cond(&self.root, i)
    }

    /// Value for object `i` (a number; NaN for other expressions).
    pub fn value(&self, i: usize) -> f64 {
        self.num(&self.root, i)
    }

    /// Indices of the objects that match a condition.
    pub fn select(&self) -> Result<Vec<u32>, ExprError> {
        if self.ty != Type::Bool {
            return Err(ExprError::new(format!(
                "the expression gives {}, not a condition (like diameter < 0.3)",
                self.ty.name()
            )));
        }
        Ok((0..self.len).filter(|&i| self.matches(i)).map(|i| i as u32).collect())
    }
}

fn compare(op: BinOp, o: Option<std::cmp::Ordering>) -> bool {
    use std::cmp::Ordering::*;
    match (op, o) {
        (_, None) => false,
        (BinOp::Eq, Some(o)) => o == Equal,
        (BinOp::Ne, Some(o)) => o != Equal,
        (BinOp::Lt, Some(o)) => o == Less,
        (BinOp::Le, Some(o)) => o != Greater,
        (BinOp::Gt, Some(o)) => o == Greater,
        (BinOp::Ge, Some(o)) => o != Less,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Cols;

    impl Columns for Cols {
        fn column(&mut self, func: Option<&str>, name: &str) -> Result<Option<Column>, String> {
            Ok(match (func, name.to_lowercase().as_str()) {
                (None, "diameter") => Some(Column::Num(vec![0.2, 0.3, 0.5, f32::NAN])),
                (None, "length") => Some(Column::Num(vec![100.0, 50.0, 10.0, 20.0])),
                (None, "type") => {
                    Some(Column::Text(["Conduit", "Conduit", "Conduit", "Pump"].map(String::from).to_vec()))
                }
                (None, "id") => Some(Column::Text(["C1", "C2", "C10", "P1"].map(String::from).to_vec())),
                (Some("max"), "flow") => Some(Column::Num(vec![1.0, 3.0, 2.0, 5.0])),
                (Some(f), _) if f.eq_ignore_ascii_case("max") => None,
                (Some("fail"), _) => return Err("no results loaded".into()),
                _ => None,
            })
        }
    }

    fn select(src: &str) -> Result<Vec<u32>, String> {
        let e = parse(src).map_err(|e| e.to_string())?;
        compile(&e, &mut Cols, 4).and_then(|p| p.select()).map_err(|e| e.to_string())
    }

    #[test]
    fn comparisons() {
        assert_eq!(select("diameter < 0.3").unwrap(), vec![0]);
        assert_eq!(select("diameter <= 0.3").unwrap(), vec![0, 1]);
        assert_eq!(select("Diameter >= .3").unwrap(), vec![1, 2]);
        // Missing values never match.
        assert_eq!(select("diameter != 0.3").unwrap(), vec![0, 2]);
        assert_eq!(select("not diameter = 0.3").unwrap(), vec![0, 2, 3]);
        assert_eq!(select("length * 2 > 150 or length = 10").unwrap(), vec![0, 2]);
        assert_eq!(select("-length < -40 and !(length >= 100)").unwrap(), vec![1]);
        assert_eq!(select("max(flow) > 2").unwrap(), vec![1, 3]);
        assert_eq!(select("1e1 = length").unwrap(), vec![2]);
    }

    #[test]
    fn texts() {
        assert_eq!(select("type = PUMP").unwrap(), vec![3]);
        assert_eq!(select("type == 'conduit' && diameter > 0.25").unwrap(), vec![1, 2]);
        assert_eq!(select("id = \"c1*\"").unwrap(), vec![0, 2]);
        assert_eq!(select("id != 'C?'").unwrap(), vec![2, 3]);
        assert_eq!(select("pump = type").unwrap(), vec![3]);
    }

    #[test]
    fn errors() {
        assert!(select("").unwrap_err().contains("empty"));
        assert!(select("diameter <").unwrap_err().contains("not finished"));
        assert!(select("diametre < 0.3").unwrap_err().contains("unknown name \"diametre\""));
        assert!(select("length").unwrap_err().contains("not a condition"));
        assert!(select("type < 3").unwrap_err().contains("cannot compare"));
        assert!(select("diameter < 0.3 length").unwrap_err().contains("operator"));
        assert!(select("min(flow) > 1").unwrap_err().contains("min(flow)"));
        assert!(select("fail(flow) > 1").unwrap_err().contains("no results"));
        assert!(select("(diameter < 1").unwrap_err().contains("missing )"));
        assert!(select("id = 'C1").unwrap_err().contains("not closed"));
        assert!(select("length # 2").unwrap_err().contains("unexpected character"));
        assert!(select("length and 1").unwrap_err().contains("and needs a condition"));
        assert_eq!(parse("a < 1 or").unwrap_err().at, Some(8));
        let e = parse("length > 1").unwrap();
        assert!(compile(&e, &mut Cols, 5).unwrap_err().message.contains("4 values, not 5"));
    }

    #[test]
    fn values() {
        let e = parse("length / 10 + 1").unwrap();
        let p = compile(&e, &mut Cols, 4).unwrap();
        assert_eq!(p.ty(), Type::Num);
        assert_eq!(p.value(0), 11.0);
        assert_eq!(e.references(), vec![(None, "length")]);
        assert_eq!(parse("max(flow) > a").unwrap().references(), vec![(Some("max"), "flow"), (None, "a")]);
    }

    #[test]
    fn globs() {
        assert!(glob("c*", "c10"));
        assert!(glob("*1", "c1"));
        assert!(glob("c*0", "c10"));
        assert!(!glob("c?", "c10"));
        assert!(glob("*", ""));
        assert!(glob("a*b*c", "axxbyyc"));
        assert!(!glob("a*b*c", "axxbyy"));
    }
}
