use base64::{engine::general_purpose, Engine as _};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SnifferCapture {
    pub url: String,
    pub headers: HashMap<String, String>,
    pub content_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SnifferClosedEvent {
    window_id: String,
    captured: bool,
}

fn decode_capture_navigation(url: &tauri::Url) -> Result<Option<SnifferCapture>, String> {
    if url.scheme() != "vdl-detect" {
        return Ok(None);
    }

    let encoded = url
        .query_pairs()
        .find_map(|(key, value)| (key == "d").then(|| value.into_owned()))
        .ok_or_else(|| "Deep Sniff submission did not include a media payload.".to_string())?;
    let decoded_bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(encoded.as_bytes())
        .or_else(|_| general_purpose::STANDARD.decode(encoded.as_bytes()))
        .map_err(|_| "Deep Sniff submission payload could not be decoded.".to_string())?;
    let mut capture: SnifferCapture = serde_json::from_slice(&decoded_bytes)
        .map_err(|_| "Deep Sniff submission payload was malformed.".to_string())?;

    capture.url = capture.url.trim().to_string();
    let media_url = tauri::Url::parse(&capture.url)
        .map_err(|_| "Deep Sniff could not resolve a valid media URL.".to_string())?;
    if !matches!(media_url.scheme(), "http" | "https") {
        return Err("Deep Sniff can only submit HTTP or HTTPS media URLs.".to_string());
    }

    Ok(Some(capture))
}

pub async fn start_sniffer<R: Runtime>(app: AppHandle<R>, url: String) -> tauri::Result<()> {
    let window_id = format!("sniffer-{}", Uuid::new_v4());
    let parsed_url = url
        .parse()
        .map_err(|e| tauri::Error::Anyhow(anyhow::anyhow!("Invalid sniffer URL: {e}")))?;
    info!(
        "Starting bulletproof sniffer for URL: {} with ID: {}",
        url, window_id
    );

    let sniffer_handle = app.clone();
    let nav_window_id = window_id.clone();
    let captured_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let navigation_captured_flag = captured_flag.clone();
    let window = WebviewWindowBuilder::new(
        &app,
        &window_id,
        WebviewUrl::External(parsed_url),
    )
    .title("VelocityDL - Deep Sniff & Cookie Sniffer")
    .inner_size(1000.0, 800.0)
    .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36")
    .visible(true)
    .on_navigation(move |url| {
        let capture = match decode_capture_navigation(url) {
            Ok(None) => return true,
            Ok(Some(capture)) => capture,
            Err(message) => {
                error!("[Deep Sniff] Rejected capture handoff: {message}");
                let _ = sniffer_handle.emit("sniffer_error", message);
                if let Some(window) = sniffer_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                return false;
            }
        };

        if navigation_captured_flag.swap(true, std::sync::atomic::Ordering::AcqRel) {
            info!("[Deep Sniff] Ignored duplicate capture handoff");
            return false;
        }

        info!("[Deep Sniff] Accepted capture handoff");
        let dispatch_handle = sniffer_handle.clone();
        let dispatch_window_id = nav_window_id.clone();
        let dispatch_captured_flag = navigation_captured_flag.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(auth_manager) =
                dispatch_handle.try_state::<crate::auth::store::AuthManager>()
            {
                match auth_manager.load_webview_cookies(&dispatch_handle).await {
                    Ok(()) => info!("[Deep Sniff] Refreshed WebView2 cookies before handoff"),
                    Err(error) => warn!(
                        "[Deep Sniff] Could not refresh WebView2 cookies before handoff: {error}"
                    ),
                }
            }

            if let Err(error) = dispatch_handle.emit("media_detected", capture) {
                error!("[Deep Sniff] Failed to emit media_detected: {error}");
                dispatch_captured_flag.store(false, std::sync::atomic::Ordering::Release);
                let _ = dispatch_handle.emit(
                    "sniffer_error",
                    "Deep Sniff resolved the media URL but could not submit it to VelocityDL. Please try again.",
                );
                if let Some(window) = dispatch_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                return;
            }

            info!("[Deep Sniff] Delivered capture to the main download flow");
            if let Some(sniffer_window) =
                dispatch_handle.get_webview_window(&dispatch_window_id)
            {
                let _ = sniffer_window.close();
            }
        });

        false
    })
    .initialization_script(
        r#"
            (function() {
                console.log("[VDL] Bulletproof Sniffer v3 Active - MPD/HLS/Content-Type Aware");

                const _vdl_manifests = new Set();
                const _vdl_reported = new Set();
                let _vdl_last_mpd = null;
                let _vdl_last_m3u8 = null;
                const _vdl_buttonMap = new WeakMap();

                const ensureOverlayRoot = () => {
                    let root = document.getElementById('vdl-floating-download-root');
                    if (!root) {
                        root = document.createElement('div');
                        root.id = 'vdl-floating-download-root';
                        root.style.position = 'fixed';
                        root.style.left = '0';
                        root.style.top = '0';
                        root.style.width = '100%';
                        root.style.height = '100%';
                        root.style.zIndex = '2147483646';
                        root.style.pointerEvents = 'none';
                        document.documentElement.appendChild(root);
                    }
                    return root;
                };

                const toBase64Url = (text) => {
                    const bytes = new TextEncoder().encode(text);
                    let binary = '';
                    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
                };

                const buildCaptureUrl = (url, headers = {}, contentType = null) => {
                    const data = JSON.stringify({ url, headers, content_type: contentType });
                    return "vdl-detect://capture?d=" + encodeURIComponent(toBase64Url(data));
                };

                const reportCapture = (url, headers = {}, contentType = null) => {
                    if (!url || typeof url !== 'string') return;

                    const key = url;
                    if (_vdl_reported.has(key)) return;
                    _vdl_reported.add(key);

                    try {
                        const reportUrl = buildCaptureUrl(url, headers, contentType);

                        let iframe = document.getElementById('vdl-sniffer-bridge');
                        if (!iframe) {
                            iframe = document.createElement('iframe');
                            iframe.id = 'vdl-sniffer-bridge';
                            iframe.style.display = 'none';
                            document.body.appendChild(iframe);
                        }
                        iframe.src = reportUrl;
                    } catch (e) {
                        console.error("[VDL] Failed to report media:", e);
                    }
                };

                const submitCapture = (url, headers = {}, contentType = null) => {
                    if (!url || typeof url !== 'string') return false;
                    try {
                        console.log("[VDL] Deep Sniff button submitting media");
                        window.location.href = buildCaptureUrl(url, headers, contentType);
                        return true;
                    } catch (e) {
                        console.error("[VDL] Failed to submit Deep Sniff capture:", e);
                        return false;
                    }
                };

                const MEDIA_EXTENSIONS = ['.m3u8', '.mpd', '.m4s', '.ts', '.mp4', '.webm', '.mkv', '.mp3', '.m4a', '.aac', '.flac', '.opus'];
                const MEDIA_CONTENT_TYPES = [
                    'video/', 'audio/', 'application/dash+xml', 'application/x-mpegurl',
                    'application/vnd.apple.mpegurl', 'application/octet-stream'
                ];

                const isMediaUrl = (url) => {
                    if (!url || typeof url !== 'string') return false;
                    const u = url.toLowerCase().split('?')[0];
                    return MEDIA_EXTENSIONS.some(ext => u.includes(ext)) ||
                           u.includes("googlevideo.com/videoplayback") ||
                           u.includes("manifest") || u.includes("playlist");
                };

                const isManifestUrl = (url) => {
                    if (!url || typeof url !== 'string') return false;
                    const u = url.toLowerCase();
                    return u.includes('.mpd') || u.includes('.m3u8') ||
                           u.includes('manifest') || u.includes('playlist');
                };

                const isChunkUrl = (url) => {
                    if (!url || typeof url !== 'string') return false;
                    const u = url.toLowerCase();
                    return u.includes('.m4s') || u.includes('.ts') || u.includes('seg-') || u.includes('chunk');
                };

                const isMediaContentType = (ct) => {
                    if (!ct) return false;
                    const lower = ct.toLowerCase();
                    return MEDIA_CONTENT_TYPES.some(t => lower.includes(t));
                };

                const smartReport = (url, headers = {}, contentType = null) => {
                    if (isManifestUrl(url)) {
                        _vdl_manifests.add(url);
                        if (url.includes('.mpd')) _vdl_last_mpd = url;
                        if (url.includes('.m3u8')) _vdl_last_m3u8 = url;
                        reportCapture(url, headers, contentType);
                    } else if (isChunkUrl(url)) {
                        if (_vdl_last_mpd) {
                            reportCapture(_vdl_last_mpd, headers, 'application/dash+xml');
                        } else if (_vdl_last_m3u8) {
                            reportCapture(_vdl_last_m3u8, headers, 'application/x-mpegurl');
                        } else {
                            reportCapture(url, headers, contentType);
                        }
                    } else {
                        reportCapture(url, headers, contentType);
                    }
                };

                const normalizeHttpMediaUrl = (value) => {
                    if (!value || typeof value !== 'string' || value.startsWith('blob:')) return null;
                    try {
                        const resolved = new URL(value, location.href);
                        return resolved.protocol === 'http:' || resolved.protocol === 'https:'
                            ? resolved.href
                            : null;
                    } catch (e) {
                        return null;
                    }
                };

                const resolveMediaUrl = (mediaEl) => {
                    const candidates = [
                        mediaEl.currentSrc,
                        mediaEl.src,
                        mediaEl.getAttribute('src'),
                        mediaEl.getAttribute('data-src'),
                    ];
                    for (const candidate of candidates) {
                        const resolved = normalizeHttpMediaUrl(candidate);
                        if (resolved) return resolved;
                    }

                    const sourceEl = mediaEl.querySelector('source[src], source[data-src]');
                    if (sourceEl) {
                        const resolvedSource = normalizeHttpMediaUrl(
                            sourceEl.src || sourceEl.getAttribute('src') || sourceEl.getAttribute('data-src')
                        );
                        if (resolvedSource) return resolvedSource;
                    }

                    const mpd = normalizeHttpMediaUrl(_vdl_last_mpd);
                    if (mpd) return mpd;
                    const m3u8 = normalizeHttpMediaUrl(_vdl_last_m3u8);
                    if (m3u8) return m3u8;
                    return null;
                };

                const updateButtonPosition = (mediaEl, buttonEl) => {
                    if (!mediaEl || !buttonEl || !document.body.contains(mediaEl)) return;
                    const rect = mediaEl.getBoundingClientRect();
                    const visible = rect.width > 120 && rect.height > 70;
                    if (!visible || rect.bottom < 0 || rect.top > window.innerHeight) {
                        buttonEl.style.display = 'none';
                        return;
                    }
                    buttonEl.style.display = 'inline-flex';
                    buttonEl.style.left = `${Math.max(4, rect.right - 148)}px`;
                    buttonEl.style.top = `${Math.max(4, rect.top + 8)}px`;
                };

                const ensureFloatingButton = (mediaEl) => {
                    if (!mediaEl || _vdl_buttonMap.has(mediaEl)) return;
                    const root = ensureOverlayRoot();
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.textContent = 'Download with VelocityDL';
                    button.style.position = 'fixed';
                    button.style.pointerEvents = 'auto';
                    button.style.padding = '6px 8px';
                    button.style.borderRadius = '6px';
                    button.style.border = '1px solid rgba(79,158,255,0.55)';
                    button.style.background = 'rgba(17,24,39,0.86)';
                    button.style.color = '#e5e7eb';
                    button.style.fontSize = '11px';
                    button.style.fontFamily = 'Segoe UI, sans-serif';
                    button.style.cursor = 'pointer';
                    button.style.boxShadow = '0 2px 10px rgba(0,0,0,0.35)';
                    button.title = 'Capture this media stream';

                    button.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const targetUrl = resolveMediaUrl(mediaEl);
                        if (targetUrl) {
                            const clickHeaders = {
                                Referer: location.href,
                                Origin: location.origin,
                                'User-Agent': navigator.userAgent,
                            };
                            const submitted = submitCapture(targetUrl, clickHeaders, null);
                            button.textContent = submitted ? 'Submitting…' : 'Capture failed';
                        } else {
                            button.textContent = 'Play media first';
                        }
                    });

                    root.appendChild(button);
                    _vdl_buttonMap.set(mediaEl, button);
                    updateButtonPosition(mediaEl, button);
                };

                const updateAllButtonPositions = () => {
                    document.querySelectorAll('video, audio').forEach((mediaEl) => {
                        const btn = _vdl_buttonMap.get(mediaEl);
                        if (btn) updateButtonPosition(mediaEl, btn);
                    });
                };

                const originalFetch = window.fetch;
                window.fetch = async function(input, init) {
                    const url = typeof input === 'string' ? input : (input ? input.url : null);
                    const headers = {};
                    if (init && init.headers) {
                        if (init.headers instanceof Headers) {
                            for (let [k, v] of init.headers) headers[k] = v;
                        } else if (typeof init.headers === 'object') {
                            Object.assign(headers, init.headers);
                        }
                    }

                    if (isMediaUrl(url)) smartReport(url, headers);

                    const response = await originalFetch.apply(this, arguments);
                    try {
                        const ct = response.headers.get('content-type');
                        if (isMediaContentType(ct) && url && !isChunkUrl(url)) {
                            smartReport(url, headers, ct);
                        }
                    } catch (e) {}

                    return response;
                };

                const originalOpen = XMLHttpRequest.prototype.open;
                const originalSend = XMLHttpRequest.prototype.send;
                const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

                XMLHttpRequest.prototype.open = function(method, url) {
                    this._vdl_url = url;
                    this._vdl_headers = {};
                    return originalOpen.apply(this, arguments);
                };

                XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
                    if (this._vdl_headers) this._vdl_headers[name] = value;
                    return originalSetRequestHeader.apply(this, arguments);
                };

                XMLHttpRequest.prototype.send = function() {
                    if (isMediaUrl(this._vdl_url)) {
                        smartReport(this._vdl_url, this._vdl_headers || {});
                    }

                    this.addEventListener('load', function() {
                        try {
                            const ct = this.getResponseHeader('content-type');
                            if (isMediaContentType(ct) && this._vdl_url) {
                                smartReport(this._vdl_url, this._vdl_headers || {}, ct);
                            }
                        } catch (e) {}
                    });

                    return originalSend.apply(this, arguments);
                };

                const checkMediaElements = () => {
                    document.querySelectorAll('video, audio, source, embed, object').forEach(el => {
                        const src = el.currentSrc || el.src || el.getAttribute('src') || el.getAttribute('data-src');
                        if (src && isMediaUrl(src) && !src.startsWith('blob:')) {
                            smartReport(src);
                        }
                    });
                    document.querySelectorAll('video, audio').forEach((mediaEl) => ensureFloatingButton(mediaEl));
                    updateAllButtonPositions();
                };

                const onMediaLifecycle = (event) => {
                    const el = event.target;
                    if (!el) return;
                    const src = el.currentSrc || el.src || (el.getAttribute && el.getAttribute('src'));
                    if (src && isMediaUrl(src) && !src.startsWith('blob:')) {
                        smartReport(src);
                    }
                };

                document.addEventListener('play', onMediaLifecycle, true);
                document.addEventListener('loadedmetadata', onMediaLifecycle, true);
                window.addEventListener('scroll', updateAllButtonPositions, true);
                window.addEventListener('resize', updateAllButtonPositions);

                if (document.readyState === 'complete' || document.readyState === 'interactive') {
                    checkMediaElements();
                } else {
                    document.addEventListener('DOMContentLoaded', checkMediaElements);
                }

                const observer = new MutationObserver((mutations) => {
                    for (const mutation of mutations) {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType === 1) {
                                const el = node;
                                if (['VIDEO', 'AUDIO', 'SOURCE', 'EMBED', 'OBJECT'].includes(el.tagName)) {
                                    const src = el.currentSrc || el.src || el.getAttribute('src');
                                    if (src && isMediaUrl(src) && !src.startsWith('blob:')) {
                                        smartReport(src);
                                    }
                                }
                                el.querySelectorAll && el.querySelectorAll('video, audio, source, embed, object').forEach(child => {
                                    const s = child.currentSrc || child.src || child.getAttribute('src');
                                    if (s && isMediaUrl(s) && !s.startsWith('blob:')) {
                                        smartReport(s);
                                    }
                                });
                            }
                        }
                    }
                });
                observer.observe(document.documentElement, { childList: true, subtree: true });

                setInterval(checkMediaElements, 1500);
            })();
        "#,
    )
    .build()?;

    // When the sniffer window is closed, we should automatically try to
    // load the cookies from the SQLite DB because the user might have logged in.
    let close_handle = app.clone();
    let close_window_id = window_id.clone();
    let close_captured_flag = captured_flag.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            let h = close_handle.clone();
            let was_captured = close_captured_flag.load(std::sync::atomic::Ordering::Relaxed);
            let close_event = SnifferClosedEvent {
                window_id: close_window_id.clone(),
                captured: was_captured,
            };
            let _ = h.emit("sniffer_closed", close_event);
            if !was_captured {
                tauri::async_runtime::spawn(async move {
                    info!("Sniffer window closing. Attempting to refresh cookies from SQLite...");
                    if let Some(auth_manager) = h.try_state::<crate::auth::store::AuthManager>() {
                        if let Err(e) = auth_manager.load_webview_cookies(&h).await {
                            error!("Failed to load webview cookies: {}", e);
                        } else {
                            info!("Successfully refreshed cookies from WebView2 SQLite DB.");
                        }
                    }
                });
            }
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::decode_capture_navigation;
    use base64::{engine::general_purpose, Engine as _};
    use serde_json::json;

    fn capture_navigation(payload: serde_json::Value) -> tauri::Url {
        let encoded = general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string());
        tauri::Url::parse(&format!("vdl-detect://capture?d={encoded}"))
            .expect("valid capture navigation")
    }

    #[test]
    fn decodes_capture_navigation_with_request_context() {
        let navigation = capture_navigation(json!({
            "url": "https://cdn.example.test/vídeo.mp4?token=abc",
            "headers": {
                "Referer": "https://media.example.test/watch",
                "User-Agent": "VelocityDL Test"
            },
            "content_type": "video/mp4"
        }));

        let capture = decode_capture_navigation(&navigation)
            .expect("capture should decode")
            .expect("capture navigation should produce a payload");

        assert_eq!(capture.url, "https://cdn.example.test/vídeo.mp4?token=abc");
        assert_eq!(
            capture.headers.get("Referer").map(String::as_str),
            Some("https://media.example.test/watch")
        );
        assert_eq!(capture.content_type.as_deref(), Some("video/mp4"));
    }

    #[test]
    fn ignores_normal_page_navigation() {
        let navigation = tauri::Url::parse("https://media.example.test/watch").unwrap();
        assert!(decode_capture_navigation(&navigation).unwrap().is_none());
    }

    #[test]
    fn rejects_non_http_media_urls() {
        for media_url in [
            "blob:https://media.example.test/id",
            "file:///C:/private/video.mp4",
            "javascript:alert(1)",
        ] {
            let navigation = capture_navigation(json!({
                "url": media_url,
                "headers": {},
                "content_type": null
            }));
            let error = decode_capture_navigation(&navigation)
                .expect_err("non-HTTP capture must be rejected");
            assert!(error.contains("HTTP"), "unexpected error: {error}");
        }
    }
}
