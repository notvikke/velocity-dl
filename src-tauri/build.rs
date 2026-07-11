use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn resolve_cargo_target_dir(manifest_dir: &Path) -> PathBuf {
    let Some(raw_target_dir) = env::var_os("CARGO_TARGET_DIR") else {
        return manifest_dir.join("target");
    };

    let target_dir = PathBuf::from(raw_target_dir);
    if target_dir.is_absolute() {
        target_dir
    } else if let Some(workspace_dir) = manifest_dir.parent() {
        workspace_dir.join(target_dir)
    } else {
        manifest_dir.join(target_dir)
    }
}

fn ensure_dev_native_host_resource() {
    let manifest_dir = match env::var("CARGO_MANIFEST_DIR") {
        Ok(value) => PathBuf::from(value),
        Err(_) => return,
    };
    let cargo_target_dir = resolve_cargo_target_dir(&manifest_dir);

    let release_host = manifest_dir.join("target").join("release").join("vdl_native_host.exe");
    if release_host.exists() {
        return;
    }

    let debug_host = cargo_target_dir.join("debug").join("vdl_native_host.exe");
    let release_candidate = cargo_target_dir.join("release").join("vdl_native_host.exe");
    let source_host = if debug_host.exists() {
        debug_host
    } else if release_candidate.exists() {
        release_candidate
    } else {
        return;
    };

    if let Some(parent) = release_host.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::copy(&source_host, &release_host);
}

fn main() {
    ensure_dev_native_host_resource();
    tauri_build::build()
}
