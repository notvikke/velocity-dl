const NONPERSISTENT_HLS_HOST: &str = "octopusmanifest.org";

fn manifest_host(url: &str) -> Option<&str> {
    let (_, after_scheme) = url.split_once("://")?;
    let authority = after_scheme.split(['/', '?', '#']).next()?;
    let host_and_port = authority.rsplit('@').next()?;
    host_and_port
        .split(':')
        .next()
        .filter(|host| !host.is_empty())
}

fn needs_nonpersistent_http(url: &str) -> bool {
    let Some(host) = manifest_host(url) else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    host == NONPERSISTENT_HLS_HOST || host.ends_with(&format!(".{NONPERSISTENT_HLS_HOST}"))
}

pub(crate) fn hls_input_args(url: &str, header_blob: Option<String>) -> Vec<String> {
    let mut args = vec!["-extension_picky".to_string(), "0".to_string()];
    if needs_nonpersistent_http(url) {
        args.push("-http_persistent".to_string());
        args.push("0".to_string());
    }
    if let Some(header_blob) = header_blob {
        args.push("-headers".to_string());
        args.push(header_blob);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::hls_input_args;

    #[test]
    fn hls_input_options_allow_disguised_media_segments() {
        let args = hls_input_args("https://cdn.example/video.m3u8", None);

        assert_eq!(args, vec!["-extension_picky".to_string(), "0".to_string()]);
    }

    #[test]
    fn hls_input_options_keep_browser_headers_after_compatibility_option() {
        let headers = "Referer: https://player.example/watch/1\r\n".to_string();

        let args = hls_input_args("https://cdn.example/video.m3u8", Some(headers));

        assert_eq!(&args[..3], ["-extension_picky", "0", "-headers"]);
        assert!(args[3].contains("Referer: https://player.example/watch/1"));
    }

    #[test]
    fn octopus_manifests_disable_persistent_hls_http() {
        let args = hls_input_args("https://octopusmanifest.org/id/playlist_vp9.m3u8", None);

        assert_eq!(
            args,
            vec![
                "-extension_picky".to_string(),
                "0".to_string(),
                "-http_persistent".to_string(),
                "0".to_string(),
            ]
        );
    }

    #[test]
    fn unrelated_manifest_hosts_keep_persistent_hls_http() {
        for url in [
            "https://cdn.example/master.m3u8",
            "https://octopusmanifest.org.evil.example/master.m3u8",
        ] {
            let args = hls_input_args(url, None);

            assert!(!args.iter().any(|arg| arg == "-http_persistent"));
        }
    }
}
