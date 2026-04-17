use serde::Deserialize;
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use url::Url;
use velocitydl_lib::protocols::strategy::{classify_media_strategy, MediaStrategy};

#[derive(Debug, Clone)]
struct ProbeRow {
    label: String,
    url: String,
    expected_strategy: Option<String>,
    skip: bool,
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JsonProbeRow {
    label: Option<String>,
    site_name: Option<String>,
    name: Option<String>,
    url: Option<String>,
    test_url: Option<String>,
    expected_strategy: Option<String>,
    strategy: Option<String>,
    note: Option<String>,
    skip: Option<bool>,
    skip_reason: Option<String>,
}

#[derive(Debug)]
struct ClassificationDetails {
    strategy: MediaStrategy,
    reason: &'static str,
    normalized_url: String,
    host: Option<String>,
}

#[derive(Debug, Default)]
struct Summary {
    total: usize,
    passed: usize,
    failed: usize,
    skipped: usize,
    by_strategy: BTreeMap<&'static str, usize>,
}

#[derive(Debug, Default)]
struct Cli {
    input: Option<PathBuf>,
    urls: Vec<String>,
}

#[derive(Debug, Default)]
struct CsvHeader {
    label: Option<usize>,
    url: Option<usize>,
    expected_strategy: Option<usize>,
    skip: Option<usize>,
    note: Option<usize>,
}

fn print_usage() {
    eprintln!(
        "Usage:\n  cargo run --bin strategy_probe -- --input <file.csv|file.json>\n  cargo run --bin strategy_probe -- <url1> <url2> ...\n\nInput formats:\n  CSV rows may use headers like label,url,expected_strategy,skip,note\n  JSON may be an array of objects or an object with rows/items/targets arrays\n"
    );
}

fn parse_cli() -> Result<Cli, String> {
    let mut cli = Cli::default();
    let mut args = env::args().skip(1).peekable();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            "--input" | "-i" => {
                let next = args
                    .next()
                    .ok_or_else(|| "--input requires a file path".to_string())?;
                cli.input = Some(PathBuf::from(next));
            }
            "--" => {
                cli.urls.extend(args);
                break;
            }
            _ if arg.starts_with('-') => {
                return Err(format!("Unknown flag '{}'", arg));
            }
            _ => cli.urls.push(arg),
        }
    }

    Ok(cli)
}

fn normalize_header(input: &str) -> String {
    input
        .trim()
        .trim_matches('"')
        .to_ascii_lowercase()
        .replace(['-', ' '], "_")
}

fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut chars = line.chars().peekable();
    let mut in_quotes = false;

    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                if in_quotes && chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ',' if !in_quotes => {
                fields.push(field.trim().to_string());
                field.clear();
            }
            _ => field.push(ch),
        }
    }

    fields.push(field.trim().to_string());
    fields
}

fn parse_bool(input: &str) -> bool {
    matches!(
        input.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "yes" | "y"
    )
}

fn header_for_row(cols: &[String]) -> Option<CsvHeader> {
    let mut header = CsvHeader::default();
    let mut seen = false;

    for (idx, col) in cols.iter().enumerate() {
        match normalize_header(col).as_str() {
            "label" | "name" | "site_name" => {
                header.label = Some(idx);
                seen = true;
            }
            "url" | "test_url" => {
                header.url = Some(idx);
                seen = true;
            }
            "expected_strategy" | "strategy" => {
                header.expected_strategy = Some(idx);
                seen = true;
            }
            "skip" => {
                header.skip = Some(idx);
                seen = true;
            }
            "note" | "skip_reason" => {
                header.note = Some(idx);
                seen = true;
            }
            _ => {}
        }
    }

    if seen {
        Some(header)
    } else {
        None
    }
}

fn csv_value(cols: &[String], idx: Option<usize>) -> Option<String> {
    idx.and_then(|i| cols.get(i)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn row_from_csv_cols(cols: &[String], header: Option<&CsvHeader>, fallback_label: String) -> Result<ProbeRow, String> {
    if let Some(header) = header {
        let url = csv_value(cols, header.url)
            .ok_or_else(|| "CSV row is missing a url/test_url column".to_string())?;
        let label = csv_value(cols, header.label).unwrap_or_else(|| fallback_label.clone());
        let expected_strategy = csv_value(cols, header.expected_strategy);
        let skip = csv_value(cols, header.skip)
            .map(|v| parse_bool(&v))
            .unwrap_or(false);
        let note = csv_value(cols, header.note);

        Ok(ProbeRow {
            label,
            url,
            expected_strategy,
            skip,
            note,
        })
    } else {
        let url = cols
            .get(1)
            .cloned()
            .or_else(|| cols.get(0).cloned())
            .ok_or_else(|| "CSV row is missing a url".to_string())?;
        let label = cols
            .get(0)
            .cloned()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| fallback_label.clone());
        let expected_strategy = cols.get(2).cloned().filter(|s| !s.trim().is_empty());
        let skip = cols.get(3).map(|v| parse_bool(v)).unwrap_or(false);
        let note = cols.get(4).cloned().filter(|s| !s.trim().is_empty());

        Ok(ProbeRow {
            label,
            url,
            expected_strategy,
            skip,
            note,
        })
    }
}

fn parse_csv_rows(content: &str) -> Result<Vec<ProbeRow>, String> {
    let mut rows = Vec::new();
    let mut lines = content.lines().enumerate().peekable();
    let mut header: Option<CsvHeader> = None;

    while let Some((line_idx, line)) = lines.next() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let cols = parse_csv_line(trimmed);
        if line_idx == 0 {
            header = header_for_row(&cols);
            if header.is_some() {
                continue;
            }
        }

        let fallback_label = format!("row {}", rows.len() + 1);
        rows.push(row_from_csv_cols(&cols, header.as_ref(), fallback_label)?);
    }

    Ok(rows)
}

fn parse_json_rows(content: &str) -> Result<Vec<ProbeRow>, String> {
    let value: serde_json::Value =
        serde_json::from_str(content).map_err(|e| format!("Failed to parse JSON input: {}", e))?;

    let items = if let Some(array) = value.as_array() {
        array.clone()
    } else if let Some(array) = value.get("rows").and_then(|v| v.as_array()) {
        array.clone()
    } else if let Some(array) = value.get("items").and_then(|v| v.as_array()) {
        array.clone()
    } else if let Some(array) = value.get("targets").and_then(|v| v.as_array()) {
        array.clone()
    } else {
        vec![value]
    };

    let mut rows = Vec::new();
    for (idx, item) in items.into_iter().enumerate() {
        let parsed: JsonProbeRow = serde_json::from_value(item)
            .map_err(|e| format!("Failed to parse JSON row {}: {}", idx + 1, e))?;
        let url = parsed
            .url
            .or(parsed.test_url)
            .ok_or_else(|| format!("JSON row {} is missing url/test_url", idx + 1))?;
        let label = parsed
            .label
            .or(parsed.site_name)
            .or(parsed.name)
            .unwrap_or_else(|| format!("row {}", idx + 1));
        let expected_strategy = parsed.expected_strategy.or(parsed.strategy);
        let note = parsed.note.or(parsed.skip_reason);

        rows.push(ProbeRow {
            label,
            url,
            expected_strategy,
            skip: parsed.skip.unwrap_or(false),
            note,
        });
    }

    Ok(rows)
}

fn load_rows(cli: &Cli) -> Result<Vec<ProbeRow>, String> {
    let mut rows = Vec::new();

    if let Some(input) = &cli.input {
        let content = fs::read_to_string(input)
            .map_err(|e| format!("Failed to read input '{}': {}", input.display(), e))?;
        let trimmed = content.trim_start();
        let mut file_rows = if input
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("json"))
            .unwrap_or(false)
            || trimmed.starts_with('[')
            || trimmed.starts_with('{')
        {
            parse_json_rows(&content)?
        } else {
            parse_csv_rows(&content)?
        };
        rows.append(&mut file_rows);
    }

    for (idx, url) in cli.urls.iter().enumerate() {
        rows.push(ProbeRow {
            label: format!("url {}", idx + 1),
            url: url.clone(),
            expected_strategy: None,
            skip: false,
            note: None,
        });
    }

    Ok(rows)
}

fn parse_expected_strategy(input: &str) -> Option<MediaStrategy> {
    match input.trim().to_ascii_lowercase().replace('-', "_").as_str() {
        "direct" | "direct_file" | "file" => Some(MediaStrategy::DirectFile),
        "hls" | "hls_manifest" | "m3u8" => Some(MediaStrategy::HlsManifest),
        "dash" | "dash_manifest" | "mpd" => Some(MediaStrategy::DashManifest),
        "metadata" | "metadata_extractor" | "extractor" => Some(MediaStrategy::MetadataExtractor),
        _ => None,
    }
}

fn classify_details(url: &str) -> ClassificationDetails {
    let normalized_url = url
        .split('#')
        .next()
        .unwrap_or(url)
        .split('?')
        .next()
        .unwrap_or(url)
        .to_string();
    let lower = normalized_url.to_ascii_lowercase();
    let host = Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|s| s.to_string()));

    let strategy = classify_media_strategy(url);
    let reason = if lower.ends_with(".m3u8") {
        "hls manifest (.m3u8)"
    } else if lower.ends_with(".mpd") {
        "dash manifest (.mpd)"
    } else if matches!(
        lower.rsplit('.').next(),
        Some(
            "mp4"
                | "mkv"
                | "webm"
                | "mov"
                | "m4v"
                | "mp3"
                | "m4a"
                | "aac"
                | "flac"
                | "wav"
                | "ogg"
                | "opus"
                | "ts"
                | "m4s"
                | "weba"
        )
    ) || lower.contains("googlevideo.com")
        || lower.contains("videoplayback")
    {
        "direct media file or known stream host"
    } else {
        "fallback metadata extractor"
    };

    ClassificationDetails {
        strategy,
        reason,
        normalized_url,
        host,
    }
}

fn format_expected(expected: Option<&str>) -> String {
    expected.unwrap_or("n/a").to_string()
}

fn print_row(row: &ProbeRow, details: &ClassificationDetails) -> bool {
    let expected = row.expected_strategy.as_deref().and_then(parse_expected_strategy);
    let expected_label = format_expected(row.expected_strategy.as_deref());
    let actual_label = details.strategy.as_str();
    let host_label = details.host.as_deref().unwrap_or("n/a");
    let mut status = "[INFO]";
    let mut ok = true;

    if row.skip {
        status = "[SKIP]";
    } else if let Some(expected_strategy) = expected {
        if expected_strategy == details.strategy {
            status = "[PASS]";
        } else {
            status = "[FAIL]";
            ok = false;
        }
    }

    println!(
        "{} {} | expected={} | actual={} | host={} | reason={} | url={}",
        status,
        row.label,
        expected_label,
        actual_label,
        host_label,
        details.reason,
        row.url
    );

    if let Some(note) = &row.note {
        println!("    note={}", note.replace('\r', " ").replace('\n', " "));
    }
    println!("    normalized_url={}", details.normalized_url);

    ok
}

fn main() -> Result<(), String> {
    let cli = parse_cli()?;
    let rows = load_rows(&cli)?;

    if rows.is_empty() {
        println!("No rows supplied.");
        return Ok(());
    }

    let mut summary = Summary::default();
    for row in rows {
        if row.skip {
            summary.skipped += 1;
            println!("[SKIP] {} | url={}", row.label, row.url);
            if let Some(note) = &row.note {
                println!("    note={}", note.replace('\r', " ").replace('\n', " "));
            }
            continue;
        }

        summary.total += 1;
        let details = classify_details(&row.url);
        *summary.by_strategy.entry(details.strategy.as_str()).or_insert(0) += 1;
        if print_row(&row, &details) {
            summary.passed += 1;
        } else {
            summary.failed += 1;
        }
    }

    println!(
        "Summary: checked={} pass={} fail={} skipped={}",
        summary.total, summary.passed, summary.failed, summary.skipped
    );
    for (strategy, count) in summary.by_strategy {
        println!("  {}={}", strategy, count);
    }

    if summary.failed > 0 {
        Err(format!("{} row(s) failed strategy validation", summary.failed))
    } else {
        Ok(())
    }
}
