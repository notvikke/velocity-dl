use std::env;
use std::fs;
use std::path::PathBuf;

fn ensure_dev_native_host_resource() {
    let manifest_dir = match env::var("CARGO_MANIFEST_DIR") {
        Ok(value) => PathBuf::from(value),
        Err(_) => return,
    };

    let release_host = manifest_dir.join("target").join("release").join("vdl_native_host.exe");
    if release_host.exists() {
        return;
    }

    let debug_host = manifest_dir.join("target").join("debug").join("vdl_native_host.exe");
    if !debug_host.exists() {
        return;
    }

    if let Some(parent) = release_host.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::copy(&debug_host, &release_host);
}

fn main() {
    ensure_dev_native_host_resource();
    tauri_build::build()
}
