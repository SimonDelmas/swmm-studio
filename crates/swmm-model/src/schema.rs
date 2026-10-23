//! Layout of `.inp` data lines: field names, types, units, defaults (SWMM 5.2 syntax).
//!
//! A layout can depend on the line itself (an outfall's fields depend on its type), so
//! [`layout`] takes the tokens. [`set_field`] uses it to edit one field: when the new
//! value changes the layout (FREE → FIXED outfall), the line is rebuilt and the other
//! values are carried over by field key.

use serde::Serialize;
use swmm_inp::{FlowUnits, SectionKind};

/// Physical quantity of a field; shown in the model's units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Unit {
    None,
    /// ft or m.
    Length,
    /// Subcatchment / sewershed area: ac or ha.
    Area,
    /// ft² or m².
    SqLength,
    Flow,
    /// Rainfall or infiltration rate: in/hr or mm/hr.
    Rate,
    /// Small depth (depression storage, infiltration volume): in or mm.
    Depth,
    Hours,
    Days,
    PerHour,
    Percent,
    Fraction,
}

impl Unit {
    pub fn label(self, flow: FlowUnits) -> &'static str {
        let si = flow.is_metric();
        match self {
            Unit::None => "",
            Unit::Length => {
                if si {
                    "m"
                } else {
                    "ft"
                }
            }
            Unit::Area => {
                if si {
                    "ha"
                } else {
                    "ac"
                }
            }
            Unit::SqLength => {
                if si {
                    "m²"
                } else {
                    "ft²"
                }
            }
            Unit::Flow => flow.name(),
            Unit::Rate => {
                if si {
                    "mm/hr"
                } else {
                    "in/hr"
                }
            }
            Unit::Depth => {
                if si {
                    "mm"
                } else {
                    "in"
                }
            }
            Unit::Hours => "hr",
            Unit::Days => "days",
            Unit::PerHour => "1/hr",
            Unit::Percent => "%",
            Unit::Fraction => "fraction",
        }
    }
}

/// What a reference field points to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefKind {
    Node,
    Link,
    Subcatchment,
    Gage,
    /// Node or subcatchment (subcatchment outlet).
    Outlet,
    Curve,
    Timeseries,
    Pattern,
    Hydrograph,
    Transect,
    Street,
    Snowpack,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FieldType {
    /// Object name (first token); changed by renaming.
    Id,
    Real,
    Text,
    /// `H:MM[:SS]` or decimal hours.
    Time,
    Choice {
        options: &'static [&'static str],
    },
    Ref {
        to: RefKind,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FieldDef {
    /// Stable key, used to carry values over when the layout changes.
    pub key: &'static str,
    pub name: &'static str,
    #[serde(flatten)]
    pub ty: FieldType,
    pub unit: Unit,
    /// Written when the field must be present but has no value yet.
    pub default: &'static str,
    /// SWMM needs the token (otherwise it may be omitted when it is the last one).
    pub required: bool,
    /// Smallest accepted value of a number.
    pub min: Option<f64>,
}

const YES_NO: &[&str] = &["YES", "NO"];

fn f(key: &'static str, name: &'static str, ty: FieldType, unit: Unit, default: &'static str) -> FieldDef {
    FieldDef { key, name, ty, unit, default, required: false, min: None }
}

fn id(name: &'static str) -> FieldDef {
    FieldDef { required: true, ..f("id", name, FieldType::Id, Unit::None, "") }
}

/// Non-negative number.
fn num(key: &'static str, name: &'static str, unit: Unit, default: &'static str) -> FieldDef {
    FieldDef { min: Some(0.0), ..f(key, name, FieldType::Real, unit, default) }
}

/// Number of any sign (elevations, offsets with elevation offsets).
fn signed(key: &'static str, name: &'static str, unit: Unit, default: &'static str) -> FieldDef {
    f(key, name, FieldType::Real, unit, default)
}

fn choice(key: &'static str, name: &'static str, options: &'static [&'static str], default: &'static str) -> FieldDef {
    f(key, name, FieldType::Choice { options }, Unit::None, default)
}

fn refer(key: &'static str, name: &'static str, to: RefKind, default: &'static str) -> FieldDef {
    f(key, name, FieldType::Ref { to }, Unit::None, default)
}

fn text(key: &'static str, name: &'static str, default: &'static str) -> FieldDef {
    f(key, name, FieldType::Text, Unit::None, default)
}

fn req(mut d: FieldDef) -> FieldDef {
    d.required = true;
    d
}

/// Marks the first `n` fields as required.
fn required(mut v: Vec<FieldDef>, n: usize) -> Vec<FieldDef> {
    v.iter_mut().take(n).for_each(|d| d.required = true);
    v
}

pub const OUTFALL_TYPES: &[&str] = &["FREE", "NORMAL", "FIXED", "TIDAL", "TIMESERIES"];
pub const DIVIDER_TYPES: &[&str] = &["OVERFLOW", "CUTOFF", "TABULAR", "WEIR"];
pub const STORAGE_SHAPES: &[&str] = &["FUNCTIONAL", "TABULAR", "CYLINDRICAL", "CONICAL", "PARABOLIC", "PYRAMIDAL"];
pub const WEIR_TYPES: &[&str] = &["TRANSVERSE", "SIDEFLOW", "V-NOTCH", "TRAPEZOIDAL", "ROADWAY"];
pub const OUTLET_TYPES: &[&str] = &["FUNCTIONAL/DEPTH", "FUNCTIONAL/HEAD", "TABULAR/DEPTH", "TABULAR/HEAD"];
pub const XSECTION_SHAPES: &[&str] = &[
    "CIRCULAR",
    "FORCE_MAIN",
    "FILLED_CIRCULAR",
    "DUMMY",
    "RECT_CLOSED",
    "RECT_OPEN",
    "TRAPEZOIDAL",
    "TRIANGULAR",
    "HORIZ_ELLIPSE",
    "VERT_ELLIPSE",
    "ARCH",
    "PARABOLIC",
    "POWER",
    "RECT_TRIANGULAR",
    "RECT_ROUND",
    "MODBASKETHANDLE",
    "EGG",
    "HORSESHOE",
    "GOTHIC",
    "CATENARY",
    "SEMIELLIPTICAL",
    "BASKETHANDLE",
    "SEMICIRCULAR",
    "CUSTOM",
    "IRREGULAR",
    "STREET",
];
pub const INFILTRATION_METHODS: &[&str] =
    &["HORTON", "MODIFIED_HORTON", "GREEN_AMPT", "MODIFIED_GREEN_AMPT", "CURVE_NUMBER"];

/// Names of the four geometry parameters of a cross-section shape.
fn geom_names(shape: &str) -> [&'static str; 4] {
    match shape {
        "CIRCULAR" | "EGG" | "HORSESHOE" | "GOTHIC" | "CATENARY" | "SEMIELLIPTICAL" | "BASKETHANDLE"
        | "SEMICIRCULAR" => ["Diameter / height", "Geom2", "Geom3", "Geom4"],
        "FORCE_MAIN" => ["Diameter", "Roughness (C-factor or ε)", "Geom3", "Geom4"],
        "FILLED_CIRCULAR" => ["Diameter", "Sediment depth", "Geom3", "Geom4"],
        "RECT_CLOSED" => ["Height", "Width", "Geom3", "Geom4"],
        "RECT_OPEN" => ["Height", "Width", "Sides removed", "Geom4"],
        "TRAPEZOIDAL" => ["Height", "Bottom width", "Left slope (H/V)", "Right slope (H/V)"],
        "TRIANGULAR" | "PARABOLIC" => ["Height", "Top width", "Geom3", "Geom4"],
        "POWER" => ["Height", "Top width", "Exponent", "Geom4"],
        "HORIZ_ELLIPSE" | "VERT_ELLIPSE" | "ARCH" => ["Height", "Width", "Size code", "Geom4"],
        "RECT_TRIANGULAR" => ["Height", "Top width", "Triangle height", "Geom4"],
        "RECT_ROUND" => ["Height", "Top width", "Bottom radius", "Geom4"],
        "MODBASKETHANDLE" => ["Height", "Bottom width", "Top radius", "Geom4"],
        _ => ["Geom1", "Geom2", "Geom3", "Geom4"],
    }
}

/// Model-wide settings that change layouts.
#[derive(Debug, Clone)]
pub struct Context {
    /// `[OPTIONS] INFILTRATION`, upper case.
    pub infiltration: String,
}

impl Context {
    pub fn of(inp: &swmm_inp::InpFile) -> Context {
        Context { infiltration: inp.option("INFILTRATION").unwrap_or_else(|| "HORTON".into()).to_ascii_uppercase() }
    }
}

/// Infiltration method of a line: its own trailing method token (SWMM 5.2) or the model's.
pub fn infiltration_method(t: &[&str], ctx: &Context) -> String {
    t.last()
        .filter(|s| t.len() > 1 && INFILTRATION_METHODS.iter().any(|m| m.eq_ignore_ascii_case(s)))
        .map(|s| s.to_ascii_uppercase())
        .unwrap_or_else(|| ctx.infiltration.clone())
}

/// Fields of a data line of a section, or `None` for sections without a schema.
pub fn layout(kind: &SectionKind, t: &[&str], ctx: &Context) -> Option<Vec<FieldDef>> {
    use RefKind as R;
    use Unit as U;
    let up = |i: usize| t.get(i).map(|s| s.to_ascii_uppercase()).unwrap_or_default();
    let v = match kind {
        SectionKind::Junctions => required(
            vec![
                id("Name"),
                signed("elev", "Invert elevation", U::Length, "0"),
                num("ymax", "Max depth", U::Length, "0"),
                num("y0", "Initial depth", U::Length, "0"),
                num("ysur", "Surcharge depth", U::Length, "0"),
                num("apond", "Ponded area", U::SqLength, "0"),
            ],
            2,
        ),
        SectionKind::Outfalls => {
            let ty = if up(2).is_empty() { "FREE".to_string() } else { up(2) };
            let mut v = vec![
                id("Name"),
                req(signed("elev", "Invert elevation", U::Length, "0")),
                req(choice("type", "Type", OUTFALL_TYPES, "FREE")),
            ];
            match ty.as_str() {
                "FIXED" => v.push(req(signed("stage", "Fixed stage", U::Length, "0"))),
                "TIDAL" => v.push(req(refer("stage", "Tidal curve", R::Curve, "*"))),
                "TIMESERIES" => v.push(req(refer("stage", "Stage time series", R::Timeseries, "*"))),
                _ => {}
            }
            v.push(choice("gated", "Flap gate", YES_NO, "NO"));
            v.push(refer("route", "Route to", R::Subcatchment, ""));
            v
        }
        SectionKind::Dividers => {
            let mut v = vec![
                id("Name"),
                req(signed("elev", "Invert elevation", U::Length, "0")),
                req(refer("link", "Diverted link", R::Link, "*")),
                req(choice("type", "Type", DIVIDER_TYPES, "OVERFLOW")),
            ];
            match up(3).as_str() {
                "CUTOFF" => v.push(req(num("qmin", "Cutoff flow", U::Flow, "0"))),
                "TABULAR" => v.push(req(refer("curve", "Diversion curve", R::Curve, "*"))),
                "WEIR" => v.extend([
                    req(num("qmin", "Min flow", U::Flow, "0")),
                    req(num("dmax", "Weir max depth", U::Length, "0")),
                    req(num("cw", "Weir coefficient", U::None, "0")),
                ]),
                _ => {}
            }
            v.extend([
                num("ymax", "Max depth", U::Length, "0"),
                num("y0", "Initial depth", U::Length, "0"),
                num("ysur", "Surcharge depth", U::Length, "0"),
                num("apond", "Ponded area", U::SqLength, "0"),
            ]);
            v
        }
        SectionKind::Storage => {
            let mut v = required(
                vec![
                    id("Name"),
                    signed("elev", "Invert elevation", U::Length, "0"),
                    num("ymax", "Max depth", U::Length, "0"),
                    num("y0", "Initial depth", U::Length, "0"),
                    choice("shape", "Shape", STORAGE_SHAPES, "FUNCTIONAL"),
                ],
                5,
            );
            match up(4).as_str() {
                "TABULAR" => v.push(req(refer("curve", "Storage curve", R::Curve, "*"))),
                "FUNCTIONAL" | "" => v.extend([
                    req(num("a1", "Coefficient", U::None, "1000")),
                    req(num("a2", "Exponent", U::None, "0")),
                    req(num("a0", "Constant", U::None, "0")),
                ]),
                _ => v.extend([
                    req(num("a1", "Length / major axis", U::Length, "1")),
                    req(num("a2", "Width / minor axis", U::Length, "1")),
                    req(num("a0", "Side slope", U::None, "0")),
                ]),
            }
            v.extend([
                num("ysur", "Surcharge depth", U::Length, "0"),
                num("fevap", "Evaporation factor", U::Fraction, "0"),
                num("psi", "Suction head", U::Depth, "0"),
                num("ksat", "Conductivity", U::Rate, "0"),
                num("imd", "Initial deficit", U::Fraction, "0"),
            ]);
            v
        }
        SectionKind::Conduits => required(
            vec![
                id("Name"),
                refer("from", "From node", R::Node, "*"),
                refer("to", "To node", R::Node, "*"),
                FieldDef { min: Some(0.0), ..f("length", "Length", FieldType::Real, U::Length, "100") },
                num("n", "Roughness (Manning n)", U::None, "0.01"),
                signed("off1", "Inlet offset", U::Length, "0"),
                signed("off2", "Outlet offset", U::Length, "0"),
                signed("q0", "Initial flow", U::Flow, "0"),
                num("qmax", "Max flow", U::Flow, "0"),
            ],
            7,
        ),
        SectionKind::Pumps => required(
            vec![
                id("Name"),
                refer("from", "From node", R::Node, "*"),
                refer("to", "To node", R::Node, "*"),
                refer("curve", "Pump curve (* = ideal)", R::Curve, "*"),
                choice("status", "Initial status", &["ON", "OFF"], "ON"),
                num("ystart", "Startup depth", U::Length, "0"),
                num("yoff", "Shutoff depth", U::Length, "0"),
            ],
            4,
        ),
        SectionKind::Orifices => required(
            vec![
                id("Name"),
                refer("from", "From node", R::Node, "*"),
                refer("to", "To node", R::Node, "*"),
                choice("type", "Type", &["SIDE", "BOTTOM"], "SIDE"),
                signed("offset", "Offset", U::Length, "0"),
                num("cd", "Discharge coefficient", U::None, "0.65"),
                choice("gated", "Flap gate", YES_NO, "NO"),
                num("orate", "Open/close time", U::Hours, "0"),
            ],
            6,
        ),
        SectionKind::Weirs => required(
            vec![
                id("Name"),
                refer("from", "From node", R::Node, "*"),
                refer("to", "To node", R::Node, "*"),
                choice("type", "Type", WEIR_TYPES, "TRANSVERSE"),
                signed("offset", "Crest height", U::Length, "0"),
                num("cd", "Discharge coefficient", U::None, "3.33"),
                choice("gated", "Flap gate", YES_NO, "NO"),
                num("ec", "End contractions", U::None, "0"),
                num("cd2", "End coefficient", U::None, "0"),
                choice("surcharge", "Can surcharge", YES_NO, "YES"),
                num("width", "Road width", U::Length, "0"),
                choice("surface", "Road surface", &["PAVED", "GRAVEL"], "PAVED"),
                refer("curve", "Coefficient curve", R::Curve, "*"),
            ],
            6,
        ),
        SectionKind::Outlets => {
            let mut v = vec![
                id("Name"),
                req(refer("from", "From node", R::Node, "*")),
                req(refer("to", "To node", R::Node, "*")),
                req(signed("offset", "Offset", U::Length, "0")),
                req(choice("type", "Type", OUTLET_TYPES, "FUNCTIONAL/DEPTH")),
            ];
            if up(4).starts_with("TABULAR") {
                v.push(req(refer("curve", "Rating curve", R::Curve, "*")));
            } else {
                v.extend([req(num("c", "Coefficient", U::None, "10")), req(num("e", "Exponent", U::None, "0.5"))]);
            }
            v.push(choice("gated", "Flap gate", YES_NO, "NO"));
            v
        }
        SectionKind::Xsections => {
            let shape = if up(1).is_empty() { "CIRCULAR".to_string() } else { up(1) };
            let mut v = vec![
                FieldDef { required: true, ..f("id", "Link", FieldType::Ref { to: R::Link }, U::None, "") },
                req(choice("shape", "Shape", XSECTION_SHAPES, "CIRCULAR")),
            ];
            match shape.as_str() {
                "CUSTOM" => v.extend([
                    req(num("geom1", "Max depth", U::Length, "1")),
                    req(refer("curve", "Shape curve", R::Curve, "*")),
                    num("barrels", "Barrels", U::None, "1"),
                ]),
                "IRREGULAR" => v.push(req(refer("curve", "Transect", R::Transect, "*"))),
                "STREET" => v.push(req(refer("curve", "Street", R::Street, "*"))),
                s => {
                    let g = geom_names(s);
                    v.extend([
                        req(num("geom1", g[0], U::Length, "1")),
                        num("geom2", g[1], U::None, "0"),
                        num("geom3", g[2], U::None, "0"),
                        num("geom4", g[3], U::None, "0"),
                        num("barrels", "Barrels", U::None, "1"),
                        text("culvert", "Culvert code", ""),
                    ]);
                    // Widths are lengths too.
                    for d in v.iter_mut().skip(3) {
                        if d.name.contains("width") || d.name.contains("Width") || d.name.contains("height") {
                            d.unit = U::Length;
                        }
                    }
                    // Geom2-4 are written as placeholders up to the barrels.
                    v.iter_mut().skip(3).take(3).for_each(|d| d.required = true);
                }
            }
            v
        }
        SectionKind::Losses => vec![
            FieldDef { required: true, ..f("id", "Link", FieldType::Ref { to: R::Link }, U::None, "") },
            req(num("kentry", "Entry loss coefficient", U::None, "0")),
            req(num("kexit", "Exit loss coefficient", U::None, "0")),
            req(num("kavg", "Average loss coefficient", U::None, "0")),
            choice("gated", "Flap gate", YES_NO, "NO"),
            num("seepage", "Seepage rate", U::Rate, "0"),
        ],
        SectionKind::Subcatchments => required(
            vec![
                id("Name"),
                refer("gage", "Rain gage", R::Gage, "*"),
                refer("outlet", "Outlet", R::Outlet, "*"),
                num("area", "Area", U::Area, "1"),
                FieldDef { unit: U::Percent, ..num("imperv", "Imperviousness", U::Percent, "25") },
                num("width", "Width", U::Length, "100"),
                num("slope", "Slope", U::Percent, "0.5"),
                num("curb", "Curb length", U::Length, "0"),
                refer("snowpack", "Snow pack", R::Snowpack, ""),
            ],
            7,
        ),
        SectionKind::Subareas => required(
            vec![
                FieldDef {
                    required: true,
                    ..f("id", "Subcatchment", FieldType::Ref { to: R::Subcatchment }, U::None, "")
                },
                num("nimp", "N-Imperv", U::None, "0.01"),
                num("nperv", "N-Perv", U::None, "0.1"),
                num("simp", "Dstore-Imperv", U::Depth, "0.05"),
                num("sperv", "Dstore-Perv", U::Depth, "0.05"),
                num("pzero", "Zero-Imperv", U::Percent, "25"),
                choice("route", "Subarea routing", &["OUTLET", "IMPERVIOUS", "PERVIOUS"], "OUTLET"),
                num("prouted", "Percent routed", U::Percent, "100"),
            ],
            6,
        ),
        SectionKind::Infiltration => {
            let method = infiltration_method(t, ctx);
            let mut v = vec![FieldDef {
                required: true,
                ..f("id", "Subcatchment", FieldType::Ref { to: R::Subcatchment }, U::None, "")
            }];
            if method.contains("GREEN") {
                v.extend([
                    req(num("p1", "Suction head", U::Depth, "3.5")),
                    req(num("p2", "Conductivity", U::Rate, "0.5")),
                    req(num("p3", "Initial deficit", U::Fraction, "0.26")),
                ]);
            } else if method.contains("CURVE") {
                v.extend([
                    req(num("p1", "Curve number", U::None, "75")),
                    req(num("p2", "Conductivity (unused)", U::Rate, "0.5")),
                    req(num("p3", "Drying time", U::Days, "7")),
                ]);
            } else {
                v.extend([
                    req(num("p1", "Max infiltration rate", U::Rate, "3")),
                    req(num("p2", "Min infiltration rate", U::Rate, "0.5")),
                    req(num("p3", "Decay constant", U::PerHour, "4")),
                    req(num("p4", "Drying time", U::Days, "7")),
                    num("p5", "Max volume", U::Depth, "0"),
                ]);
            }
            v
        }
        SectionKind::Raingages => {
            let mut v = required(
                vec![
                    id("Name"),
                    choice("format", "Format", &["INTENSITY", "VOLUME", "CUMULATIVE"], "INTENSITY"),
                    f("interval", "Interval", FieldType::Time, U::None, "1:00"),
                    num("scf", "Snow catch factor", U::None, "1.0"),
                    choice("source", "Source", &["TIMESERIES", "FILE"], "TIMESERIES"),
                ],
                5,
            );
            if up(4) == "FILE" {
                v.extend([
                    req(text("file", "File", "")),
                    req(text("station", "Station", "*")),
                    req(choice("units", "Units", &["IN", "MM"], "MM")),
                ]);
            } else {
                v.push(req(refer("ts", "Time series", R::Timeseries, "*")));
            }
            v
        }
        SectionKind::Inflows => {
            let flow = up(1) == "FLOW" || up(1).is_empty();
            let mut v = vec![
                FieldDef { required: true, ..f("id", "Node", FieldType::Ref { to: R::Node }, U::None, "") },
                req(text("constituent", "Constituent", "FLOW")),
                req(refer("ts", "Time series", R::Timeseries, "")),
            ];
            if flow {
                v.push(choice("type", "Type", &["FLOW"], "FLOW"));
            } else {
                v.push(choice("type", "Type", &["CONCEN", "MASS"], "CONCEN"));
            }
            v.extend([
                num("mfactor", "Units factor", U::None, "1.0"),
                signed("sfactor", "Scale factor", U::None, "1.0"),
                signed("baseline", "Baseline", if flow { U::Flow } else { U::None }, "0"),
                refer("pattern", "Baseline pattern", R::Pattern, ""),
            ]);
            v
        }
        SectionKind::Dwf => vec![
            FieldDef { required: true, ..f("id", "Node", FieldType::Ref { to: R::Node }, U::None, "") },
            req(text("constituent", "Constituent", "FLOW")),
            req(signed("avg", "Average value", if up(1) == "FLOW" { U::Flow } else { U::None }, "0")),
            refer("pat1", "Time pattern 1", R::Pattern, ""),
            refer("pat2", "Time pattern 2", R::Pattern, ""),
            refer("pat3", "Time pattern 3", R::Pattern, ""),
            refer("pat4", "Time pattern 4", R::Pattern, ""),
        ],
        SectionKind::Rdii => required(
            vec![
                FieldDef { required: true, ..f("id", "Node", FieldType::Ref { to: R::Node }, U::None, "") },
                refer("uh", "Unit hydrograph", R::Hydrograph, "*"),
                num("area", "Sewershed area", U::Area, "0"),
            ],
            3,
        ),
        SectionKind::Coordinates | SectionKind::Symbols => required(
            vec![
                FieldDef { required: true, ..f("id", "Name", FieldType::Ref { to: R::Node }, U::None, "") },
                signed("x", "X", U::None, "0"),
                signed("y", "Y", U::None, "0"),
            ],
            3,
        ),
        _ => return None,
    };
    Some(v)
}

/// Number of tokens that identify a line of a section (the object ID, plus the
/// constituent for inflows).
pub fn key_len(kind: &SectionKind) -> usize {
    match kind {
        SectionKind::Inflows | SectionKind::Dwf | SectionKind::Tags => 2,
        _ => 1,
    }
}

/// Checks and normalises a value for a field (choices in upper case).
pub fn validate(def: &FieldDef, value: &str) -> Result<String, String> {
    let v = value.trim();
    if v.contains('"') {
        return Err("double quotes are not allowed".into());
    }
    if v.is_empty() {
        return if def.required && !def.default.is_empty() {
            Err(format!("{} is required", def.name))
        } else {
            Ok(String::new())
        };
    }
    match &def.ty {
        FieldType::Real => {
            let x: f64 = v.parse().map_err(|_| format!("{}: {v:?} is not a number", def.name))?;
            if !x.is_finite() {
                return Err(format!("{}: {v:?} is not a number", def.name));
            }
            if let Some(m) = def.min {
                if x < m {
                    return Err(format!("{} must be at least {m}", def.name));
                }
            }
            Ok(v.to_string())
        }
        FieldType::Choice { options } => options
            .iter()
            .find(|o| o.eq_ignore_ascii_case(v))
            .map(|o| o.to_string())
            .ok_or_else(|| format!("{}: {v:?} is not one of {}", def.name, options.join(", "))),
        FieldType::Time => swmm_inp::datetime::parse_time(v)
            .map(|_| v.to_string())
            .ok_or_else(|| format!("{}: {v:?} is not a time (H:MM or decimal hours)", def.name)),
        FieldType::Id | FieldType::Ref { .. } => {
            check_id(v).map_err(|e| format!("{}: {e}", def.name))?;
            Ok(v.to_string())
        }
        FieldType::Text => Ok(v.to_string()),
    }
}

/// An object name SWMM can read back: no spaces, quotes or `;`, not starting with `[`.
pub fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("the name is empty".into());
    }
    if id.chars().any(|c| c.is_whitespace() || c == '"' || c == ';') {
        return Err(format!("{id:?} contains a space, a quote or a semicolon"));
    }
    if id.starts_with('[') {
        return Err(format!("{id:?} starts with '['"));
    }
    Ok(())
}

/// Tokens of a new line with the required fields at their defaults.
pub fn default_tokens(kind: &SectionKind, key: &[&str], ctx: &Context) -> Option<Vec<String>> {
    let defs = layout(kind, key, ctx)?;
    let mut t: Vec<String> = Vec::new();
    for (i, d) in defs.iter().enumerate() {
        if i < key.len() {
            t.push(key[i].to_string());
        } else if d.required {
            t.push(d.default.to_string());
        } else {
            break;
        }
    }
    Some(t)
}

/// Tokens of a line for a new object: every field with a default, up to the first one
/// whose default is empty (the way the EPA GUI writes new objects).
pub fn new_line_tokens(kind: &SectionKind, key: &[&str], ctx: &Context) -> Option<Vec<String>> {
    let defs = layout(kind, key, ctx)?;
    let mut t: Vec<String> = Vec::new();
    for (i, d) in defs.iter().enumerate() {
        if i < key.len() {
            t.push(key[i].to_string());
        } else if !d.default.is_empty() {
            t.push(d.default.to_string());
        } else {
            break;
        }
    }
    Some(t)
}

/// New tokens of a line after setting field `index` to `value` (already validated).
///
/// Missing fields before it are filled with defaults. When the change alters the
/// layout, fields are matched by key; fields that are not required and had no value are
/// left out at the end of the line.
pub fn set_field(kind: &SectionKind, tokens: &[&str], index: usize, value: &str, ctx: &Context) -> Option<Vec<String>> {
    let old = layout(kind, tokens, ctx)?;
    // A trailing infiltration method (SWMM 5.2) stays last.
    let method = (*kind == SectionKind::Infiltration && tokens.len() > 1)
        .then(|| tokens.last().filter(|s| INFILTRATION_METHODS.iter().any(|m| m.eq_ignore_ascii_case(s))))
        .flatten()
        .map(|s| s.to_string());
    let body: Vec<&str> = if method.is_some() { tokens[..tokens.len() - 1].to_vec() } else { tokens.to_vec() };
    let def = old.get(index)?;
    let mut t: Vec<String> = body.iter().map(|s| s.to_string()).collect();
    while t.len() <= index {
        let d = old.get(t.len()).map_or("0", |d| d.default);
        t.push(d.to_string());
    }
    t[index] = if value.is_empty() && index + 1 < t.len() { def.default.to_string() } else { value.to_string() };
    if value.is_empty() && index + 1 == t.len() && !def.required {
        t.pop();
    }
    let probe: Vec<&str> = t.iter().map(String::as_str).collect();
    let new = layout(kind, &probe, ctx)?;
    let same = new.len() == old.len() && new.iter().zip(&old).all(|(a, b)| a.key == b.key);
    if !same {
        let values: std::collections::HashMap<&str, &str> =
            old.iter().zip(body.iter()).map(|(d, v)| (d.key, *v)).collect();
        let mut out = Vec::new();
        let mut last_needed = 0;
        for (i, d) in new.iter().enumerate() {
            let v = if d.key == def.key { Some(value) } else { values.get(d.key).copied() };
            if d.required || v.is_some() {
                last_needed = i + 1;
            }
            out.push(v.unwrap_or(d.default).to_string());
        }
        out.truncate(last_needed);
        t = out;
    }
    if let Some(m) = method {
        t.push(m);
    }
    Some(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Context {
        Context { infiltration: "HORTON".into() }
    }

    fn set(kind: SectionKind, line: &str, i: usize, v: &str) -> String {
        let t: Vec<&str> = line.split_whitespace().collect();
        set_field(&kind, &t, i, v, &ctx()).unwrap().join(" ")
    }

    #[test]
    fn outfall_type_change_carries_values() {
        let o = SectionKind::Outfalls;
        assert_eq!(set(o.clone(), "O1 97 FREE YES S1", 2, "FIXED"), "O1 97 FIXED 0 YES S1");
        assert_eq!(set(o.clone(), "O1 97 FIXED 98 NO", 2, "NORMAL"), "O1 97 NORMAL NO");
        assert_eq!(set(o.clone(), "O1 97 FREE", 4, "S2"), "O1 97 FREE NO S2");
        assert_eq!(set(o, "O1 97 FREE NO S2", 4, ""), "O1 97 FREE NO");
    }

    #[test]
    fn padding_and_simple_edits() {
        assert_eq!(set(SectionKind::Junctions, "J1 100", 4, "1.5"), "J1 100 0 0 1.5");
        assert_eq!(set(SectionKind::Conduits, "C1 A B 10 0.01 0 0", 4, "0.013"), "C1 A B 10 0.013 0 0");
        assert_eq!(set(SectionKind::Xsections, "C1 CIRCULAR 1 0 0 0 1", 1, "CUSTOM"), "C1 CUSTOM 1 * 1");
        assert_eq!(set(SectionKind::Xsections, "C1 CUSTOM 2 SH 1", 1, "RECT_CLOSED"), "C1 RECT_CLOSED 2 0 0 0 1");
        assert_eq!(set(SectionKind::Storage, "S 1 2 0 TABULAR C", 4, "FUNCTIONAL"), "S 1 2 0 FUNCTIONAL 1000 0 0");
        assert_eq!(
            set(SectionKind::Raingages, "RG INTENSITY 0:05 1.0 TIMESERIES TS", 4, "FILE"),
            "RG INTENSITY 0:05 1.0 FILE  * MM"
        );
        assert_eq!(set(SectionKind::Infiltration, "S1 3 0.5 4 7 0 HORTON", 2, "0.4"), "S1 3 0.4 4 7 0 HORTON");
        assert_eq!(set(SectionKind::Infiltration, "S1 3 0.5 4 7 HORTON", 5, "1"), "S1 3 0.5 4 7 1 HORTON");
    }

    #[test]
    fn layouts_and_validation() {
        let c = ctx();
        let l = layout(&SectionKind::Dividers, &["D", "1", "C1", "WEIR"], &c).unwrap();
        assert_eq!(l[4].name, "Min flow");
        assert_eq!(l.len(), 11);
        let g = layout(&SectionKind::Infiltration, &["S1", "3", "0.5", "0.2", "GREEN_AMPT"], &c).unwrap();
        assert_eq!(g[1].name, "Suction head");
        assert_eq!(Unit::Area.label(FlowUnits::Lps), "ha");
        assert_eq!(Unit::Flow.label(FlowUnits::Cfs), "CFS");
        let elev = &layout(&SectionKind::Junctions, &["J"], &c).unwrap()[1];
        assert_eq!(validate(elev, " -3.5 "), Ok("-3.5".into()));
        assert!(validate(elev, "abc").is_err());
        assert!(validate(elev, "").is_err());
        let depth = &layout(&SectionKind::Junctions, &["J"], &c).unwrap()[2];
        assert!(validate(depth, "-1").is_err());
        let ty = &layout(&SectionKind::Outfalls, &["O"], &c).unwrap()[2];
        assert_eq!(validate(ty, "fixed"), Ok("FIXED".into()));
        assert!(validate(ty, "x").is_err());
        assert!(check_id("a b").is_err() && check_id("J-1.2").is_ok());
        assert_eq!(
            default_tokens(&SectionKind::Conduits, &["C9"], &c).unwrap(),
            ["C9", "*", "*", "100", "0.01", "0", "0"]
        );
        assert_eq!(default_tokens(&SectionKind::Rdii, &["J1"], &c).unwrap(), ["J1", "*", "0"]);
    }
}
