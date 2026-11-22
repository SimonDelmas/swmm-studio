//! Checks of a table before it is written.

use super::{Table, CURVE_TYPES, MONTHS, RESPONSES};
use crate::edit::EditResult;
use crate::schema::{check_id, table_fields, FieldDef, RefKind};

/// Checks parameters against their fields (count, numbers, smallest values, names).
fn check_values(what: &str, defs: &[FieldDef], values: &[&String]) -> EditResult<()> {
    if values.len() != defs.len() {
        return Err(format!("{what}: {} values expected, not {}", defs.len(), values.len()));
    }
    for (d, v) in defs.iter().zip(values) {
        if v.trim().is_empty() && !d.required {
            continue;
        }
        crate::schema::validate(d, v).map_err(|e| format!("{what}: {e}"))?;
    }
    Ok(())
}

fn num_check(label: &str, v: &str) -> EditResult<()> {
    if v.trim().parse::<f64>().map(f64::is_finite).unwrap_or(false) {
        Ok(())
    } else {
        Err(format!("{label}: {v:?} is not a number"))
    }
}

/// Checks the values of a table before writing it.
pub fn validate(t: &Table) -> EditResult<()> {
    check_id(t.name())?;
    match t {
        Table::Curve(c) => {
            if !CURVE_TYPES.contains(&c.curve_type.as_str()) {
                return Err(format!("unknown curve type {:?}", c.curve_type));
            }
            for (i, p) in c.points.iter().enumerate() {
                num_check(&format!("row {}", i + 1), &p[0])?;
                num_check(&format!("row {}", i + 1), &p[1])?;
            }
        }
        Table::Timeseries(ts) => {
            if let Some(f) = &ts.file {
                if f.trim().is_empty() {
                    return Err("the file name is empty".into());
                }
                if let Err(e) = crate::schema::check_text(f) {
                    return Err(format!("file name: {e}"));
                }
            }
            for (i, r) in ts.rows.iter().enumerate() {
                let row = format!("row {}", i + 1);
                if !r.date.trim().is_empty() && swmm_inp::datetime::parse_date(&r.date).is_none() {
                    return Err(format!("{row}: {:?} is not a date (MM/DD/YYYY)", r.date));
                }
                if swmm_inp::datetime::parse_time(&r.time).is_none() {
                    return Err(format!("{row}: {:?} is not a time (H:MM or decimal hours)", r.time));
                }
                num_check(&row, &r.value)?;
            }
        }
        Table::Pattern(p) => {
            let want = match p.pattern_type.as_str() {
                "MONTHLY" => 12,
                "DAILY" => 7,
                "HOURLY" | "WEEKEND" => 24,
                other => return Err(format!("unknown pattern type {other:?}")),
            };
            if p.factors.len() != want {
                return Err(format!("a {} pattern needs {want} factors, not {}", p.pattern_type, p.factors.len()));
            }
            for (i, v) in p.factors.iter().enumerate() {
                num_check(&format!("factor {}", i + 1), v)?;
            }
        }
        Table::Hydrograph(h) => {
            check_id(&h.gage).map_err(|e| format!("rain gage: {e}"))?;
            for r in &h.rows {
                if !MONTHS.iter().any(|m| m.eq_ignore_ascii_case(&r.month)) {
                    return Err(format!("unknown month {:?}", r.month));
                }
                if !RESPONSES.iter().any(|m| m.eq_ignore_ascii_case(&r.response)) {
                    return Err(format!("unknown response {:?}", r.response));
                }
                let row = format!("{} {}", r.month, r.response);
                for v in [&r.r, &r.t, &r.k] {
                    num_check(&row, v)?;
                }
                for v in [&r.dmax, &r.drecov, &r.dinit] {
                    if !v.trim().is_empty() {
                        num_check(&row, v)?;
                    }
                }
            }
        }
        Table::Aquifer(a) => {
            let defs = table_fields(RefKind::Aquifer, "");
            let values: Vec<&String> = a.values.iter().chain([&a.pattern]).collect();
            check_values("aquifer", &defs, &values)?;
        }
        Table::Snowpack(p) => {
            for (label, surface, values) in [
                ("plowable area", "PLOWABLE", &p.plowable),
                ("impervious area", "IMPERVIOUS", &p.impervious),
                ("pervious area", "PERVIOUS", &p.pervious),
            ] {
                let v: Vec<&String> = values.iter().collect();
                check_values(label, &table_fields(RefKind::Snowpack, surface), &v)?;
            }
            let v: Vec<&String> = p.removal.iter().chain([&p.subcatchment]).collect();
            check_values("snow removal", &table_fields(RefKind::Snowpack, "REMOVAL"), &v)?;
        }
        Table::Transect(t) => {
            for (label, v) in [
                ("left bank roughness", &t.n_left),
                ("right bank roughness", &t.n_right),
                ("channel roughness", &t.n_channel),
                ("left bank station", &t.x_left),
                ("right bank station", &t.x_right),
                ("meander modifier", &t.lfactor),
                ("stations factor", &t.wfactor),
                ("elevation offset", &t.eoffset),
            ] {
                num_check(label, v)?;
            }
            for (i, p) in t.points.iter().enumerate() {
                num_check(&format!("station {}", i + 1), &p[0])?;
                num_check(&format!("station {}", i + 1), &p[1])?;
            }
        }
    }
    Ok(())
}
