//! Date and time strings as accepted by SWMM's input parser (`datetime.c`).

use chrono::{NaiveDate, NaiveDateTime, NaiveTime, TimeDelta};

const MONTHS: [&str; 12] = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/// Parses a date in SWMM's input format: `MM/DD/YYYY`, also with `-` separators or a
/// three-letter month name (`Jan/01/1998`).
pub fn parse_date(s: &str) -> Option<NaiveDate> {
    let mut parts = s.trim().split(['/', '-']);
    let (m, d, y) = (parts.next()?, parts.next()?, parts.next()?);
    let month = match m.parse::<u32>() {
        Ok(m) => m,
        Err(_) => {
            let m = m.get(..3)?.to_ascii_uppercase();
            MONTHS.iter().position(|x| *x == m)? as u32 + 1
        }
    };
    NaiveDate::from_ymd_opt(y.trim().parse().ok()?, month, d.trim().parse().ok()?)
}

/// Parses a time of day or duration: `HH:MM:SS`, `HH:MM`, `HH` or decimal hours (`1.5`).
///
/// Returned as a duration because SWMM allows values past 24 h (e.g. `REPORT_STEP 36:00:00`).
pub fn parse_time(s: &str) -> Option<TimeDelta> {
    let s = s.trim();
    if !s.contains(':') {
        let hours: f64 = s.parse().ok()?;
        return (hours >= 0.0).then(|| TimeDelta::milliseconds((hours * 3_600_000.0).round() as i64));
    }
    let mut it = s.split(':');
    let h: i64 = it.next()?.trim().parse().ok()?;
    let m: i64 = it.next().map_or(Some(0), |x| x.trim().parse().ok())?;
    let sec: i64 = it.next().map_or(Some(0), |x| x.trim().parse().ok())?;
    (h >= 0 && m >= 0 && sec >= 0).then(|| TimeDelta::seconds(h * 3600 + m * 60 + sec))
}

/// Combines a date string and an optional time string.
pub fn parse_datetime(date: &str, time: Option<&str>) -> Option<NaiveDateTime> {
    let d = parse_date(date)?.and_time(NaiveTime::MIN);
    match time {
        Some(t) => Some(d + parse_time(t)?),
        None => Some(d),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        let d = NaiveDate::from_ymd_opt(1998, 1, 2).unwrap();
        assert_eq!(parse_date("01/02/1998"), Some(d));
        assert_eq!(parse_date("1/2/1998"), Some(d));
        assert_eq!(parse_date("Jan-02-1998"), Some(d));
        assert_eq!(parse_date("13/02/1998"), None);
        assert_eq!(parse_date("nonsense"), None);
    }

    #[test]
    fn times() {
        assert_eq!(parse_time("00:15:00"), Some(TimeDelta::minutes(15)));
        assert_eq!(parse_time("0:01"), Some(TimeDelta::minutes(1)));
        assert_eq!(parse_time("1.5"), Some(TimeDelta::minutes(90)));
        assert_eq!(parse_time("36:00:00"), Some(TimeDelta::hours(36)));
        assert_eq!(parse_time("x"), None);
    }
}
