use std::time::{Duration, Instant};

pub struct SpeedCalculator {
    last_update: Instant,
    last_bytes: u64,
}

impl SpeedCalculator {
    pub fn new() -> Self {
        Self {
            last_update: Instant::now(),
            last_bytes: 0,
        }
    }

    pub fn calculate(&mut self, current_bytes: u64) -> (f64, Duration) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_update);

        if elapsed < Duration::from_millis(500) {
            return (0.0, Duration::from_secs(0)); // Don't calculate too often
        }

        let bytes_since_last = current_bytes - self.last_bytes;
        let speed = bytes_since_last as f64 / elapsed.as_secs_f64(); // bytes per second

        self.last_update = now;
        self.last_bytes = current_bytes;

        (speed, elapsed)
    }

    pub fn calculate_eta(&self, speed: f64, total_size: u64, current_bytes: u64) -> Duration {
        if speed <= 0.0 || total_size <= current_bytes {
            return Duration::from_secs(0);
        }
        let remaining = total_size.saturating_sub(current_bytes);
        Duration::from_secs_f64(remaining as f64 / speed)
    }
}
