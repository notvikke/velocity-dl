use base64::{engine::general_purpose, Engine as _};
use log::{error, info};
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
        let url_str = url.as_str();
        if url_str.starts_with("vdl-detect://") {
            info!("Side-channel signal detected!");

            let encoded = url
                .query_pairs()
                .find_map(|(k, v)| if k == "d" { Some(v.into_owned()) } else { None });

            if let Some(encoded) = encoded {
                let decoded_url = urlencoding::decode(&encoded)
                    .unwrap_or(std::borrow::Cow::Borrowed(encoded.as_str()));

                let decoded_bytes = general_purpose::URL_SAFE_NO_PAD
                    .decode(decoded_url.as_ref())
                    .or_else(|_| general_purpose::STANDARD.decode(decoded_url.as_ref()));

                if let Ok(decoded_bytes) = decoded_bytes {
                    if let Ok(json_str) = String::from_utf8(decoded_bytes) {
                        if let Ok(capture) = serde_json::from_str::<SnifferCapture>(&json_str) {
                            info!("Successfully captured media via side-channel: {}", capture.url);
                            navigation_captured_flag
                                .store(true, std::sync::atomic::Ordering::Relaxed);
                            let _ = sniffer_handle.emit("media_detected", capture);
                            if let Some(window) = sniffer_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                            if let Some(sniffer_window) = sniffer_handle.get_webview_window(&nav_window_id) {
                                let _ = sniffer_window.close();
                            }
                        } else {
                            error!("Failed to parse sniffer JSON: {}", json_str);
                        }
                    }
                } else {
                    error!("Failed to decode base64 from side-channel: {}", decoded_url);
                }
            }
            return false;
        }
        true
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

                const reportCapture = (url, headers = {}, contentType = null) => {
                    if (!url || typeof url !== 'string') return;

                    const key = url;
                    if (_vdl_reported.has(key)) return;
                    _vdl_reported.add(key);

                    console.log("[VDL] Media detected:", url);

                    try {
                        const data = JSON.stringify({ url, headers, content_type: contentType });
                        const encoded = toBase64Url(data);
                        const reportUrl = "vdl-detect://capture?d=" + encodeURIComponent(encoded);

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

                const resolveMediaUrl = (mediaEl) => {
                    const src = mediaEl.currentSrc || mediaEl.src || mediaEl.getAttribute('src');
                    if (src && !src.startsWith('blob:')) return src;
                    if (_vdl_last_mpd) return _vdl_last_mpd;
                    if (_vdl_last_m3u8) return _vdl_last_m3u8;
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
                            smartReport(targetUrl, clickHeaders, null);
                            button.textContent = 'Captured';
                            setTimeout(() => { button.textContent = 'Download with VelocityDL'; }, 1400);
                        } else {
                            button.textContent = 'Play media first';
                            setTimeout(() => { button.textContent = 'Download with VelocityDL'; }, 1400);
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
    });

    Ok(())
}
