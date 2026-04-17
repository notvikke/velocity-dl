use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub start: u64,
    pub end: u64,
    pub current: u64,
    pub finished: bool,
}

impl Segment {
    pub fn new(start: u64, end: u64) -> Self {
        Self {
            start,
            end,
            current: start,
            finished: false,
        }
    }

    pub fn remaining(&self) -> u64 {
        if self.finished {
            0
        } else {
            self.end - self.current + 1
        }
    }
}

pub fn calculate_segments(total_size: u64, num_segments: u32) -> Vec<Segment> {
    if num_segments == 0 {
        return vec![];
    }
    if total_size == 0 {
        return vec![Segment::new(0, 0)];
    }

    let effective_segments = num_segments.min(total_size as u32).max(1);
    let mut segments = Vec::with_capacity(effective_segments as usize);
    let segment_size = total_size / effective_segments as u64;
    let remainder = total_size % effective_segments as u64;
    let mut current_start = 0;

    for i in 0..effective_segments {
        let extra = u64::from(i < remainder as u32);
        let segment_len = segment_size + extra;
        let end = current_start + segment_len - 1;

        segments.push(Segment::new(current_start, end));
        current_start = end + 1;
    }

    segments
}
