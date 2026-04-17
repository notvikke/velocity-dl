#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaStrategy {
    DirectFile,
    HlsManifest,
    DashManifest,
    MetadataExtractor,
}

impl MediaStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaStrategy::DirectFile => "direct_file",
            MediaStrategy::HlsManifest => "hls_manifest",
            MediaStrategy::DashManifest => "dash_manifest",
            MediaStrategy::MetadataExtractor => "metadata_extractor",
        }
    }
}

pub fn classify_media_strategy(url: &str) -> MediaStrategy {
    let lower = url
        .split('#')
        .next()
        .unwrap_or(url)
        .split('?')
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();

    if lower.ends_with(".m3u8") {
        MediaStrategy::HlsManifest
    } else if lower.ends_with(".mpd") {
        MediaStrategy::DashManifest
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
                | "exe"
                | "msi"
                | "msix"
                | "msixbundle"
                | "appx"
                | "appxbundle"
                | "zip"
                | "rar"
                | "7z"
                | "tar"
                | "gz"
                | "bz2"
                | "xz"
                | "iso"
                | "img"
                | "dmg"
                | "pkg"
                | "deb"
                | "rpm"
                | "apk"
                | "ipa"
                | "jar"
                | "pdf"
                | "doc"
                | "docx"
                | "xls"
                | "xlsx"
                | "ppt"
                | "pptx"
                | "csv"
                | "json"
                | "xml"
                | "txt"
                | "rtf"
                | "epub"
        )
    ) || lower.contains("googlevideo.com")
        || lower.contains("videoplayback")
    {
        MediaStrategy::DirectFile
    } else {
        MediaStrategy::MetadataExtractor
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_media_strategy, MediaStrategy};

    #[test]
    fn strategy_classification_regression_examples() {
        let cases = [
            (
                "https://cdn.example.com/video.mp4",
                MediaStrategy::DirectFile,
                "direct mp4 should stay direct",
            ),
            (
                "https://cdn.example.com/archive/tool.exe",
                MediaStrategy::DirectFile,
                "generic downloadable files should stay direct",
            ),
            (
                "https://stream.example.com/master.m3u8?token=abc",
                MediaStrategy::HlsManifest,
                "m3u8 manifests should stay hls",
            ),
            (
                "https://stream.example.com/manifest.mpd",
                MediaStrategy::DashManifest,
                "mpd manifests should stay dash",
            ),
            (
                "https://rr2---sn-ab5l6n7s.googlevideo.com/videoplayback?id=123",
                MediaStrategy::DirectFile,
                "googlevideo playback URLs should stay direct",
            ),
            (
                "https://media.example.com/watch/alpha",
                MediaStrategy::MetadataExtractor,
                "watch pages should remain metadata-driven",
            ),
            (
                "https://player.example.net/embed/12345",
                MediaStrategy::MetadataExtractor,
                "embed pages should not be treated as direct media",
            ),
            (
                "https://portal.example.org/video/episode-1",
                MediaStrategy::MetadataExtractor,
                "watch pages should remain metadata-driven",
            ),
        ];

        for (url, expected, reason) in cases {
            assert_eq!(classify_media_strategy(url), expected, "{reason}: {url}");
        }
    }
}
