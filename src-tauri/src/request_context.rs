use reqwest::header::{HeaderMap, HeaderName, HeaderValue, COOKIE, REFERER, USER_AGENT};
use std::collections::HashMap;

pub const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

pub fn merge_request_headers(
    headers: Option<&HashMap<String, String>>,
    cookie_header: Option<&str>,
) -> HashMap<String, String> {
    let mut merged = HashMap::new();

    if let Some(headers) = headers {
        for (key, value) in headers {
            let trimmed_key = key.trim();
            let trimmed_value = value.trim();
            if trimmed_key.is_empty() || trimmed_value.is_empty() {
                continue;
            }
            merged.insert(trimmed_key.to_string(), trimmed_value.to_string());
        }
    }

    if !has_header(&merged, "User-Agent") {
        merged.insert("User-Agent".to_string(), DEFAULT_USER_AGENT.to_string());
    }

    if !has_header(&merged, "Origin") {
        if let Some(referer) = header_value(&merged, "Referer") {
            if let Ok(parsed) = url::Url::parse(referer) {
                merged.insert("Origin".to_string(), parsed.origin().ascii_serialization());
            }
        }
    }

    if !has_header(&merged, "Cookie") {
        if let Some(cookie_header) = cookie_header.map(str::trim).filter(|value| !value.is_empty()) {
            merged.insert("Cookie".to_string(), cookie_header.to_string());
        }
    }

    merged
}

pub fn to_headermap(headers: Option<&HashMap<String, String>>) -> HeaderMap {
    let mut map = HeaderMap::new();
    if let Some(headers) = headers {
        for (key, value) in headers {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(key.as_bytes()),
                HeaderValue::from_str(value),
            ) {
                map.insert(name, value);
            }
        }
    }
    map
}

pub fn add_cookie_to_headermap(headers: &mut HeaderMap, cookie_header: Option<&str>) {
    if headers.contains_key(COOKIE) {
        return;
    }
    if let Some(cookie_header) = cookie_header.map(str::trim).filter(|value| !value.is_empty()) {
        if let Ok(value) = HeaderValue::from_str(cookie_header) {
            headers.insert(COOKIE, value);
        }
    }
}

pub fn ensure_default_runtime_headers(headers: &mut HeaderMap) {
    if !headers.contains_key(USER_AGENT) {
        if let Ok(value) = HeaderValue::from_str(DEFAULT_USER_AGENT) {
            headers.insert(USER_AGENT, value);
        }
    }

    if !headers.contains_key("origin") {
        if let Some(referer) = headers.get(REFERER).and_then(|value| value.to_str().ok()) {
            if let Ok(parsed) = url::Url::parse(referer) {
                if let Ok(origin) = HeaderValue::from_str(&parsed.origin().ascii_serialization()) {
                    headers.insert("origin", origin);
                }
            }
        }
    }
}

pub fn build_ffmpeg_header_blob(headers: Option<&HashMap<String, String>>) -> Option<String> {
    let mut merged = merge_request_headers(headers, None);
    merged.remove("X-VDL-Raw-Media-Url");

    let mut lines = merged
        .into_iter()
        .filter_map(|(key, value)| {
            let key = key.trim().to_string();
            let value = value.trim().to_string();
            if key.is_empty() || value.is_empty() {
                None
            } else {
                Some(format!("{key}: {value}"))
            }
        })
        .collect::<Vec<_>>();

    lines.sort_unstable();

    if lines.is_empty() {
        None
    } else {
        Some(format!("{}\r\n", lines.join("\r\n")))
    }
}

fn has_header(headers: &HashMap<String, String>, target: &str) -> bool {
    headers.keys().any(|key| key.eq_ignore_ascii_case(target))
}

fn header_value<'a>(headers: &'a HashMap<String, String>, target: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(target))
        .map(|(_, value)| value.as_str())
}

#[cfg(test)]
mod tests {
    use super::{
        add_cookie_to_headermap, build_ffmpeg_header_blob, ensure_default_runtime_headers,
        merge_request_headers, to_headermap, DEFAULT_USER_AGENT,
    };
    use reqwest::header::{COOKIE, ORIGIN, REFERER, USER_AGENT};
    use std::collections::HashMap;

    #[test]
    fn merge_request_headers_adds_defaults_and_cookie() {
        let mut headers = HashMap::new();
        headers.insert("Referer".to_string(), "https://media.example.com/watch/alpha".to_string());

        let merged = merge_request_headers(Some(&headers), Some("sid=abc"));

        assert_eq!(merged.get("Cookie").map(String::as_str), Some("sid=abc"));
        assert_eq!(
            merged.get("Origin").map(String::as_str),
            Some("https://media.example.com")
        );
        assert_eq!(
            merged.get("User-Agent").map(String::as_str),
            Some(DEFAULT_USER_AGENT)
        );
    }

    #[test]
    fn merge_request_headers_preserves_existing_cookie() {
        let mut headers = HashMap::new();
        headers.insert("Cookie".to_string(), "existing=1".to_string());

        let merged = merge_request_headers(Some(&headers), Some("sid=abc"));

        assert_eq!(merged.get("Cookie").map(String::as_str), Some("existing=1"));
    }

    #[test]
    fn runtime_headermap_adds_user_agent_origin_and_cookie() {
        let mut headers = HashMap::new();
        headers.insert("Referer".to_string(), "https://cdn.example.com/video".to_string());

        let mut map = to_headermap(Some(&headers));
        add_cookie_to_headermap(&mut map, Some("sid=abc"));
        ensure_default_runtime_headers(&mut map);

        assert_eq!(map.get(COOKIE).and_then(|value| value.to_str().ok()), Some("sid=abc"));
        assert_eq!(
            map.get(ORIGIN).and_then(|value| value.to_str().ok()),
            Some("https://cdn.example.com")
        );
        assert_eq!(
            map.get(USER_AGENT).and_then(|value| value.to_str().ok()),
            Some(DEFAULT_USER_AGENT)
        );
        assert_eq!(
            map.get(REFERER).and_then(|value| value.to_str().ok()),
            Some("https://cdn.example.com/video")
        );
    }

    #[test]
    fn ffmpeg_header_blob_redacts_internal_marker_and_keeps_origin() {
        let mut headers = HashMap::new();
        headers.insert("Referer".to_string(), "https://media.example.com/watch/alpha".to_string());
        headers.insert("X-VDL-Raw-Media-Url".to_string(), "https://raw.example.com/v.m3u8".to_string());

        let blob = build_ffmpeg_header_blob(Some(&headers)).expect("header blob");

        assert!(blob.contains("Referer: https://media.example.com/watch/alpha"));
        assert!(blob.contains("Origin: https://media.example.com"));
        assert!(blob.contains(&format!("User-Agent: {DEFAULT_USER_AGENT}")));
        assert!(!blob.contains("X-VDL-Raw-Media-Url"));
    }
}
