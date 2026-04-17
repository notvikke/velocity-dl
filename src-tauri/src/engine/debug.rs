pub fn strategy_label(strategy: Option<&str>) -> &'static str {
    match strategy.unwrap_or("") {
        "direct_file" => "Direct",
        "hls_manifest" => "HLS",
        "dash_manifest" => "DASH",
        "metadata_extractor" => "Extractor",
        _ => "Unknown",
    }
}
