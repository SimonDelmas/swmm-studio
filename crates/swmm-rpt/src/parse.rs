//! Reading the text of a report: banners, blocks, tables, key-value lines and messages.

use super::*;

pub(super) fn is_banner(t: &str) -> bool {
    t.len() >= 3 && t.bytes().all(|b| b == b'*')
}

/// A banner line, possibly followed by value headers (`*****    Volume   Depth`).
pub(super) fn is_banner_start(t: &str) -> bool {
    t.split_whitespace().next().is_some_and(is_banner)
}

/// Banner, title, banner.
pub(super) fn is_block_start(lines: &[&str], i: usize) -> bool {
    i + 2 < lines.len()
        && is_banner_start(lines[i].trim())
        && !is_banner_start(lines[i + 1].trim())
        && !lines[i + 1].trim().is_empty()
        && is_banner_start(lines[i + 2].trim())
}

/// Splits on runs of 2+ spaces.
pub(super) fn phrases(s: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && b[i] == b' ' {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let start = i;
        while i < b.len() && !(b[i] == b' ' && b.get(i + 1).is_none_or(|&c| c == b' ')) {
            i += 1;
        }
        out.push((start, &s[start..i]));
    }
    out
}

pub(super) fn parse_block(lines: &[&str], at: usize) -> (Block, usize) {
    // Banner, title line, banner: value headers can trail the three lines (continuity tables).
    let top = lines[at];
    let title_line = lines[at + 1];
    let title_phrases = phrases(title_line);
    let title = title_phrases.first().map_or("", |p| p.1).to_string();
    let trailing = |s: &str| phrases(s).into_iter().skip(1).map(|p| p.1.to_string()).collect::<Vec<_>>();
    let headers_top = trailing(top);
    let units = trailing(title_line);
    let value_headers = if units.is_empty() {
        headers_top
    } else if headers_top.len() == units.len() {
        headers_top.iter().zip(&units).map(|(h, u)| format!("{h} ({u})")).collect()
    } else {
        units
    };

    // Body: until the next banner or the end-of-run lines.
    let mut end = at + 3;
    while end < lines.len() {
        let t = lines[end].trim();
        // Messages written after a block (run-time errors) are not part of it.
        let message = parse_message(t, "ERROR").is_some() || parse_message(t, "WARNING").is_some();
        if is_block_start(lines, end) || t.starts_with("Analysis begun on:") || message {
            break;
        }
        end += 1;
    }
    let body_lines = &lines[at + 3..end];
    let body = parse_body(body_lines);
    (Block { title, value_headers, body }, end)
}

pub(super) fn is_dashes(t: &str) -> bool {
    t.len() >= 3 && t.bytes().all(|b| b == b'-')
}

pub(super) fn parse_body(lines: &[&str]) -> Body {
    let content: Vec<&str> = lines.iter().copied().filter(|l| !l.trim().is_empty()).collect();
    // Summary tables have their headings between two dashed lines; the tables of the
    // input summary (`INPUT YES`) have them above a single one.
    let dashes: Vec<usize> = content.iter().enumerate().filter(|(_, l)| is_dashes(l.trim())).map(|(i, _)| i).collect();
    let single = matches!(dashes[..], [d] if d > 0 && d + 1 < content.len());
    if dashes.len() >= 2 || single {
        return Body::Table(parse_table(lines));
    }
    let kv: Vec<Option<KeyValue>> = content.iter().map(|l| parse_key_value(l)).collect();
    if !kv.is_empty() && kv.iter().filter(|k| k.is_some()).count() * 2 >= kv.len() {
        return Body::KeyValues(kv.into_iter().flatten().collect());
    }
    Body::Text(content.iter().map(|l| l.trim().to_string()).collect())
}

/// `Total Precipitation ......   0.188   2.650` or `Minimum Time Step   :   37.57 sec`.
pub(super) fn parse_key_value(line: &str) -> Option<KeyValue> {
    let t = line.trim();
    let (key, rest) = if let Some(p) = t.find(" ..") {
        let rest = t[p..].trim_start_matches([' ', '.']);
        (&t[..p], rest)
    } else {
        let (k, v) = t.split_at(t.find(':')?);
        if !k.ends_with(' ') {
            return None;
        }
        (k, &v[1..])
    };
    Some(KeyValue { key: key.trim().to_string(), values: rest.split_whitespace().map(str::to_string).collect() })
}

pub(super) fn parse_table(lines: &[&str]) -> Table {
    let mut t = Table::default();
    let dashes: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| is_dashes(l.trim())).map(|(i, _)| i).collect();
    // Headings between two dashed lines (text before them is a note), or above a single one.
    let (notes, header, h1) = match dashes[..] {
        [h0, h1, ..] => (&lines[..h0], &lines[h0 + 1..h1], h1),
        [h1] => (&lines[..0], &lines[..h1], h1),
        [] => return t,
    };
    t.header = header.iter().filter(|l| !l.trim().is_empty()).map(|l| l.trim_end().to_string()).collect();
    t.notes = notes.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).map(str::to_string).collect();
    let data = || lines[h1 + 1..].iter().filter(|l| !l.trim().is_empty() && !is_dashes(l.trim()));
    // The fullest row gives the columns: rows with blank cells (no velocity for a pump…)
    // are laid on them, so that their values stay under their headings.
    let Some(template) = data().max_by_key(|l| l.split_whitespace().count()).copied() else {
        return t;
    };
    let columns = token_spans(template);
    let mut footer = false;
    for line in &lines[h1 + 1..] {
        if is_dashes(line.trim()) {
            footer = true;
        } else if !line.trim().is_empty() {
            let row = align_row(line, &columns);
            if footer {
                t.footer.push(row);
            } else {
                t.rows.push(row);
            }
        }
    }
    t.columns = column_names(&t.header, template);
    t
}

/// Character span `[start, end)` of each whitespace-separated token of a line.
pub(super) fn token_spans(line: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i > start {
            spans.push((start, i));
        }
    }
    spans
}

/// Cells of a table row. A row with fewer tokens than the table has columns has blank
/// cells: each token goes to the column it is printed under (the one it overlaps most,
/// else the one whose right edge is nearest, as numbers are right-aligned) and the other
/// cells are left empty. Rows that do not fit the columns are returned as their tokens.
pub(super) fn align_row(line: &str, columns: &[(usize, usize)]) -> Vec<String> {
    let tokens = token_spans(line);
    let plain = || tokens.iter().map(|&(a, z)| line[a..z].to_string()).collect::<Vec<_>>();
    if tokens.len() >= columns.len() {
        return plain();
    }
    let mut row = vec![String::new(); columns.len()];
    let mut next = 0;
    for &(a, z) in &tokens {
        let score = |&(s, e): &(usize, usize)| (z.min(e) as i64 - a.max(s) as i64, -(z as i64 - e as i64).abs());
        // Columns are filled from left to right.
        let Some(c) = (next..columns.len()).max_by_key(|&c| score(&columns[c])) else {
            return plain();
        };
        row[c] = line[a..z].to_string();
        next = c + 1;
    }
    row
}

/// Names each data column after the header phrases printed above it.
pub(super) fn column_names(header: &[String], sample: &str) -> Vec<String> {
    let spans = token_spans(sample);
    let overlap = |a: usize, z: usize, (s, e): (usize, usize)| z.min(e) as i64 - a.max(s) as i64;
    // Best overlap, else the column whose end is nearest.
    let best = |a: usize, z: usize| {
        spans
            .iter()
            .enumerate()
            .max_by_key(|(_, &span)| (overlap(a, z, span), -(z as i64 - span.1 as i64).abs()))
            .map(|(i, _)| i)
    };
    let mut names: Vec<Vec<&str>> = vec![Vec::new(); spans.len()];
    for h in header {
        for (pos, phrase) in phrases(h) {
            let (a, z) = (pos, pos + phrase.len());
            let words: Vec<(usize, &str)> = phrase
                .split(' ')
                .scan(pos, |at, w| {
                    let start = *at;
                    *at += w.len() + 1;
                    Some((start, w))
                })
                .collect();
            let covered = spans.iter().filter(|&&s| overlap(a, z, s) > 0).count();
            // `days hr:min` sits over two data tokens: one word per column.
            if covered > 1 && covered == words.len() {
                for (wa, w) in words {
                    if let Some(c) = best(wa, wa + w.len()) {
                        names[c].push(w);
                    }
                }
            } else if let Some(c) = best(a, z) {
                names[c].push(phrase);
            }
        }
    }
    names.into_iter().map(|w| w.join(" ")).collect()
}

pub(super) fn parse_message(t: &str, keyword: &str) -> Option<Message> {
    let rest = t.strip_prefix(keyword)?.strip_prefix(' ')?;
    let (code, text) = rest.split_once(':')?;
    let code = code.trim();
    if code.contains(' ') {
        return None;
    }
    let text = text.trim().to_string();
    let mut line = None;
    let mut section = None;
    if let Some(p) = text.find(" at line ") {
        let after = &text[p + 9..];
        line = after.split_whitespace().next().and_then(|n| n.parse().ok());
        if let Some((a, z)) = after.find('[').zip(after.find(']')).filter(|(a, z)| a < z) {
            section = Some(after[a + 1..z].to_string());
        }
    }
    Some(Message { code: code.to_string(), text, line, section, context: None })
}
