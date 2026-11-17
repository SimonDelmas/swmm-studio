//! Dates and times written as text: ISO (`2024-01-31 12:00`, `2024-01-31T12:00:00Z`) or with
//! the day or the month first (`31/01/2024 12:00`, `01/31/2024 12:00`, `31.01.24`).

use chrono::{NaiveDate, NaiveDateTime, NaiveTime, TimeDelta};
use serde::{Deserialize, Serialize};

/// Order of the day and the month in dates that do not start with the year.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DateOrder {
    /// Found from the values (day first when nothing tells).
    #[default]
    Auto,
    /// `31/01/2024`.
    Dmy,
    /// `01/31/2024`.
    Mdy,
}

/// The three numbers of a date and the text after it.
fn date_parts(s: &str) -> Option<([&str; 3], &str)> {
    let s = s.trim();
    let end = s.find(|c: char| c == ' ' || c == 'T' || c == 't').unwrap_or(s.len());
    let (date, rest) = s.split_at(end);
    let mut it = date.split(['/', '-', '.']);
    let parts = [it.next()?, it.next()?, it.next()?];
    if it.next().is_some()
        || parts.iter().any(|p| p.is_empty() || p.len() > 4 || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some((parts, rest))
}

/// `HH:MM[:SS[.fff]]`, with an optional time zone (`Z`, `+02:00`), which is dropped: times
/// are taken as written, like the model's clock.
fn time_of_day(s: &str) -> Option<TimeDelta> {
    let s = s.trim().trim_start_matches(['T', 't']).trim();
    if s.is_empty() {
        return Some(TimeDelta::zero());
    }
    let s = s.trim_end_matches(['Z', 'z']);
    // A zone offset after the time: `12:00:00+02:00`, `12:00-0500`.
    let s = match s.char_indices().skip(1).find(|&(_, c)| c == '+' || c == '-') {
        Some((i, _)) => &s[..i],
        None => s,
    };
    let mut it = s.trim().split(':');
    let h: i64 = it.next()?.trim().parse().ok()?;
    let m: i64 = it.next().map_or(Some(0), |x| x.trim().parse().ok())?;
    let sec: f64 = it.next().map_or(Some(0.0), |x| x.trim().parse().ok())?;
    if it.next().is_some() || !(0..=24).contains(&h) || !(0..60).contains(&m) || !(0.0..61.0).contains(&sec) {
        return None;
    }
    Some(TimeDelta::hours(h) + TimeDelta::minutes(m) + TimeDelta::milliseconds((sec * 1000.0).round() as i64))
}

fn year(s: &str) -> Option<i32> {
    let y: i32 = s.parse().ok()?;
    Some(if s.len() <= 2 { 2000 + y } else { y })
}

/// Parses a date and time; `order` says how to read a date that does not start with the
/// year (`Auto` reads it day first).
pub fn parse(s: &str, order: DateOrder) -> Option<NaiveDateTime> {
    let (p, rest) = date_parts(s)?;
    let n = |x: &str| x.parse::<u32>().ok();
    let date = if p[0].len() == 4 {
        NaiveDate::from_ymd_opt(year(p[0])?, n(p[1])?, n(p[2])?)?
    } else {
        let (d, m) = match order {
            DateOrder::Mdy => (p[1], p[0]),
            DateOrder::Dmy | DateOrder::Auto => (p[0], p[1]),
        };
        NaiveDate::from_ymd_opt(year(p[2])?, n(m)?, n(d)?)?
    };
    date.and_time(NaiveTime::MIN).checked_add_signed(time_of_day(rest)?)
}

/// What the values of a column of dates tell about their order: `Mdy` when one has a
/// second number above 12, `Dmy` when one has a first number above 12 (or when none tells).
/// The flag is true when nothing tells (and some dates do not start with the year).
pub fn detect_order<'a>(values: impl IntoIterator<Item = &'a str>) -> (DateOrder, bool) {
    let (mut day_first, mut month_first, mut seen) = (false, false, false);
    for v in values {
        let Some((p, _)) = date_parts(v) else { continue };
        if p[0].len() == 4 {
            continue;
        }
        seen = true;
        let (a, b) = (p[0].parse::<u32>().unwrap_or(0), p[1].parse::<u32>().unwrap_or(0));
        day_first |= a > 12;
        month_first |= b > 12;
        if day_first || month_first {
            break;
        }
    }
    match (day_first, month_first) {
        (false, true) => (DateOrder::Mdy, false),
        (true, _) => (DateOrder::Dmy, false),
        (false, false) => (DateOrder::Dmy, seen),
    }
}

/// Words of a column title that name a date or a time.
pub fn is_time_name(name: &str) -> bool {
    let n = name.to_lowercase();
    ["date", "time", "heure", "horodat", "timestamp", "datetime", "instant", "temps"].iter().any(|w| n.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(h, mi, s).unwrap()
    }

    #[test]
    fn formats() {
        let a = dt(2024, 1, 31, 12, 30, 0);
        for s in [
            "2024-01-31 12:30",
            "2024-01-31T12:30:00",
            "2024-01-31T12:30:00Z",
            "2024-01-31T12:30:00+02:00",
            "2024/01/31 12:30:00.000",
            "31/01/2024 12:30",
            "31-01-2024 12:30:00",
            "31.01.24 12:30",
        ] {
            assert_eq!(parse(s, DateOrder::Auto), Some(a), "{s}");
        }
        assert_eq!(parse("01/31/2024 12:30", DateOrder::Mdy), Some(a));
        assert_eq!(parse("01/31/2024 12:30", DateOrder::Dmy), None);
        assert_eq!(parse("2024-01-31", DateOrder::Auto), Some(dt(2024, 1, 31, 0, 0, 0)));
        assert_eq!(parse("31/01/2024 24:00", DateOrder::Auto), Some(dt(2024, 2, 1, 0, 0, 0)));
        for bad in ["", "12.5", "1.234", "abc", "2024-13-01", "2024-01-01 25:00", "2024-01-01 xx"] {
            assert_eq!(parse(bad, DateOrder::Auto), None, "{bad}");
        }
    }

    #[test]
    fn order() {
        assert_eq!(detect_order(["01/02/2024", "13/02/2024"]), (DateOrder::Dmy, false));
        assert_eq!(detect_order(["01/02/2024", "02/13/2024"]), (DateOrder::Mdy, false));
        assert_eq!(detect_order(["01/02/2024", "2024-05-30"]), (DateOrder::Dmy, true));
        assert_eq!(detect_order(["2024-05-30"]), (DateOrder::Dmy, false));
    }
}
