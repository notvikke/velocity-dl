use std::path::{Path, PathBuf};

pub fn candidate_artifact_paths(final_output_path: &Path, has_audio_track: bool) -> Vec<PathBuf> {
    let mut out = vec![final_output_path.to_path_buf()];
    if has_audio_track {
        out.push(final_output_path.with_extension("vdl-temp-video"));
        out.push(final_output_path.with_extension("vdl-temp-audio"));
    }
    out
}

pub fn matches_artifact_family(entry_path: &Path, artifact_path: &Path) -> bool {
    if entry_path == artifact_path {
        return true;
    }
    let Some(entry_name) = entry_path.file_name().and_then(|v| v.to_str()) else {
        return false;
    };
    let Some(artifact_name) = artifact_path.file_name().and_then(|v| v.to_str()) else {
        return false;
    };
    entry_name.starts_with(&format!("{artifact_name}.vdl-part"))
}

#[cfg(test)]
mod tests {
    use super::{candidate_artifact_paths, matches_artifact_family};
    use std::path::Path;

    #[test]
    fn multi_track_candidates_include_temp_tracks() {
        let target = Path::new(r"C:\Downloads\movie.mp4");
        let candidates = candidate_artifact_paths(target, true);

        assert_eq!(candidates[0], target);
        assert!(candidates.iter().any(|path| path.ends_with("movie.vdl-temp-video")));
        assert!(candidates.iter().any(|path| path.ends_with("movie.vdl-temp-audio")));
    }

    #[test]
    fn artifact_family_matches_segment_parts_only_for_same_base_file() {
        let artifact = Path::new(r"C:\Downloads\movie.mp4");

        assert!(matches_artifact_family(
            Path::new(r"C:\Downloads\movie.mp4.vdl-part0"),
            artifact
        ));
        assert!(!matches_artifact_family(
            Path::new(r"C:\Downloads\movie-two.mp4.vdl-part0"),
            artifact
        ));
    }
}
