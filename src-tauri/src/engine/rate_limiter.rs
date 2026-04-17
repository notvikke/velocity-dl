use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

#[derive(Clone)]
pub struct GlobalSpeedLimiter {
    inner: Arc<Mutex<LimiterState>>,
}

struct LimiterState {
    bytes_per_second: Option<f64>,
    available_bytes: f64,
    last_refill: Instant,
}

impl GlobalSpeedLimiter {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(LimiterState {
                bytes_per_second: None,
                available_bytes: 0.0,
                last_refill: Instant::now(),
            })),
        }
    }

    pub async fn set_limit_mb(&self, speed_limit_mb: u32) {
        let mut state = self.inner.lock().await;
        state.bytes_per_second = if speed_limit_mb == 0 {
            None
        } else {
            Some(speed_limit_mb as f64 * 1024.0 * 1024.0)
        };
        state.available_bytes = state.bytes_per_second.unwrap_or(0.0);
        state.last_refill = Instant::now();
    }

    pub async fn acquire(&self, bytes: usize) {
        if bytes == 0 {
            return;
        }

        let requested = bytes as f64;
        loop {
            let wait_for = {
                let mut state = self.inner.lock().await;
                let Some(bytes_per_second) = state.bytes_per_second else {
                    return;
                };

                let now = Instant::now();
                let elapsed = now.duration_since(state.last_refill).as_secs_f64();
                if elapsed > 0.0 {
                    let burst_cap = bytes_per_second.max(requested);
                    state.available_bytes =
                        (state.available_bytes + elapsed * bytes_per_second).min(burst_cap);
                    state.last_refill = now;
                }

                if state.available_bytes >= requested {
                    state.available_bytes -= requested;
                    return;
                }

                let missing = requested - state.available_bytes;
                Duration::from_secs_f64((missing / bytes_per_second).max(0.005))
            };

            sleep(wait_for).await;
        }
    }
}
