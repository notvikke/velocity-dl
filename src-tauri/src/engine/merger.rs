use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;
use tokio::fs::{File, OpenOptions};
use tokio::io;

pub async fn merge_segments(output_path: PathBuf, num_segments: u32) -> Result<()> {
    merge_segments_to_file(&output_path, &output_path, num_segments).await
}

pub async fn merge_segments_to_file(
    temp_path: &PathBuf,
    final_path: &PathBuf,
    num_segments: u32,
) -> Result<()> {
    let mut final_file = if temp_path == final_path {
        OpenOptions::new()
            .write(true)
            .open(final_path)
            .await
            .context("Failed to open final output file for merging")?
    } else {
        File::create(final_path)
            .await
            .context("Failed to create final output file for merging")?
    };

    for i in 0..num_segments {
        let part_path = segment_part_path(temp_path, i as usize)?;
        let mut part_file = File::open(&part_path)
            .await
            .context(format!("Failed to open segment part {}", i))?;

        // Append to the final file
        io::copy(&mut part_file, &mut final_file)
            .await
            .context(format!("Failed to copy segment part {} to final file", i))?;

        // Remove the part file
        tokio::fs::remove_file(part_path).await?;
    }

    Ok(())
}

pub async fn merge_multi_track(
    ffmpeg_path: PathBuf,
    video_path: PathBuf,
    audio_path: PathBuf,
    output_path: PathBuf,
) -> Result<()> {
    let output = tokio::process::Command::new(ffmpeg_path)
        .arg("-i")
        .arg(&video_path)
        .arg("-i")
        .arg(&audio_path)
        .arg("-c:v")
        .arg("copy")
        .arg("-c:a")
        .arg("copy")
        .arg("-y") // Overwrite output
        .arg(&output_path)
        .output()
        .await?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow::anyhow!("FFmpeg failed: {}", err));
    }

    // Clean up temporary files
    let _ = tokio::fs::remove_file(video_path).await;
    let _ = tokio::fs::remove_file(audio_path).await;

    Ok(())
}

pub async fn preallocate_file(path: &PathBuf, size: u64) -> Result<()> {
    if size == 0 {
        return Ok(());
    }
    let file = File::create(path).await?;
    file.set_len(size).await?;
    Ok(())
}

fn segment_part_path(base_path: &PathBuf, segment_index: usize) -> Result<PathBuf> {
    let file_name = base_path
        .file_name()
        .ok_or_else(|| anyhow!("Invalid temp path (missing file name): {:?}", base_path))?
        .to_string_lossy();
    Ok(base_path.with_file_name(format!("{file_name}.vdl-part{segment_index}")))
}
