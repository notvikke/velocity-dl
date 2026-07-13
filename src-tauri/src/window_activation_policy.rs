use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

#[derive(Default)]
pub struct NewDownloadRevealState {
    generation: AtomicU64,
    pending_download_id: Mutex<Option<String>>,
}

impl NewDownloadRevealState {
    pub(crate) fn enqueue(&self, download_id: String) -> u64 {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        *self
            .pending_download_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(download_id);
        generation
    }

    pub(crate) fn take_if_current(&self, generation: u64) -> Option<String> {
        if self.generation.load(Ordering::Acquire) != generation {
            return None;
        }
        self.pending_download_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }
}

pub fn should_reveal_for_new_download(reveal_on_accept: bool, origin: Option<&str>) -> bool {
    reveal_on_accept
        && origin.is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "browser_takeover" | "sniff_capture"
            )
        })
}

#[cfg(test)]
mod tests {
    use super::{should_reveal_for_new_download, NewDownloadRevealState};

    #[test]
    fn only_explicit_external_accepts_request_foreground_attention() {
        assert!(should_reveal_for_new_download(
            true,
            Some("browser_takeover")
        ));
        assert!(should_reveal_for_new_download(true, Some("sniff_capture")));
        assert!(!should_reveal_for_new_download(
            false,
            Some("browser_takeover")
        ));
        assert!(!should_reveal_for_new_download(true, Some("manual")));
        assert!(!should_reveal_for_new_download(true, None));
    }

    #[test]
    fn rapid_downloads_collapse_to_the_last_download_id() {
        let state = NewDownloadRevealState::default();
        let first_generation = state.enqueue("first".to_string());
        let second_generation = state.enqueue("second".to_string());

        assert_eq!(state.take_if_current(first_generation), None);
        assert_eq!(
            state.take_if_current(second_generation),
            Some("second".to_string())
        );
        assert_eq!(state.take_if_current(second_generation), None);
    }
}
