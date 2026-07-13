use serde::{Deserialize, Serialize};

pub const CHROME_WEB_STORE_EXTENSION_ID: &str = "alnagakehjhbfkdianlkmcncefldpmhm";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionIdentityKind {
    ChromeWebStore,
    LocalUnpacked,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionIdentity {
    pub id: String,
    pub kind: ExtensionIdentityKind,
    pub installation_type: String,
    pub browser_channel: String,
    pub supported: bool,
    pub production: bool,
    pub recommended: bool,
}

pub fn normalize_extension_id(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    (normalized.len() == 32 && normalized.bytes().all(|byte| (b'a'..=b'p').contains(&byte)))
        .then_some(normalized)
}

pub fn extension_id_from_origin(origin: &str) -> Option<String> {
    let origin = origin.trim();
    let remainder = origin
        .strip_prefix("chrome-extension://")
        .or_else(|| origin.strip_prefix("edge-extension://"))?;
    let id = remainder.strip_suffix('/')?;
    if id.contains('/') {
        return None;
    }
    normalize_extension_id(id)
}

pub fn classify_extension_id(
    runtime_id: &str,
    configured_local_ids: &[String],
) -> ExtensionIdentity {
    let id = normalize_extension_id(runtime_id)
        .unwrap_or_else(|| runtime_id.trim().to_ascii_lowercase());
    let kind = if id == CHROME_WEB_STORE_EXTENSION_ID {
        ExtensionIdentityKind::ChromeWebStore
    } else if configured_local_ids
        .iter()
        .filter_map(|candidate| normalize_extension_id(candidate))
        .any(|candidate| candidate == id)
    {
        ExtensionIdentityKind::LocalUnpacked
    } else {
        ExtensionIdentityKind::Unsupported
    };

    match kind {
        ExtensionIdentityKind::ChromeWebStore => ExtensionIdentity {
            id,
            kind,
            installation_type: "chrome_web_store".to_string(),
            browser_channel: "chromium".to_string(),
            supported: true,
            production: true,
            recommended: true,
        },
        ExtensionIdentityKind::LocalUnpacked => ExtensionIdentity {
            id,
            kind,
            installation_type: "local_unpacked".to_string(),
            browser_channel: "chromium".to_string(),
            supported: true,
            production: false,
            recommended: false,
        },
        ExtensionIdentityKind::Unsupported => ExtensionIdentity {
            id,
            kind,
            installation_type: "unsupported".to_string(),
            browser_channel: "unknown".to_string(),
            supported: false,
            production: false,
            recommended: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_extension_id, extension_id_from_origin, normalize_extension_id,
        ExtensionIdentityKind, CHROME_WEB_STORE_EXTENSION_ID,
    };

    const LOCAL_ID: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const UNKNOWN_ID: &str = "cccccccccccccccccccccccccccccccc";

    #[test]
    fn extension_identity_classifies_the_web_store_id_as_recommended_production() {
        let identity = classify_extension_id(CHROME_WEB_STORE_EXTENSION_ID, &[]);

        assert_eq!(identity.kind, ExtensionIdentityKind::ChromeWebStore);
        assert!(identity.supported);
        assert!(identity.production);
        assert!(identity.recommended);
    }

    #[test]
    fn extension_identity_classifies_an_explicit_manifest_id_as_local_unpacked() {
        let identity = classify_extension_id(LOCAL_ID, &[LOCAL_ID.to_string()]);

        assert_eq!(identity.kind, ExtensionIdentityKind::LocalUnpacked);
        assert!(identity.supported);
        assert!(!identity.production);
        assert!(!identity.recommended);
    }

    #[test]
    fn extension_identity_rejects_an_unconfigured_id() {
        let identity = classify_extension_id(UNKNOWN_ID, &[LOCAL_ID.to_string()]);

        assert_eq!(identity.kind, ExtensionIdentityKind::Unsupported);
        assert!(!identity.supported);
    }

    #[test]
    fn extension_ids_are_trimmed_and_normalized_to_lowercase() {
        assert_eq!(
            normalize_extension_id(&format!(
                "  {}  ",
                CHROME_WEB_STORE_EXTENSION_ID.to_uppercase()
            ))
            .as_deref(),
            Some(CHROME_WEB_STORE_EXTENSION_ID)
        );
    }

    #[test]
    fn chromium_caller_origin_yields_the_normalized_extension_id() {
        assert_eq!(
            extension_id_from_origin(&format!(
                "chrome-extension://{}/",
                CHROME_WEB_STORE_EXTENSION_ID.to_uppercase()
            ))
            .as_deref(),
            Some(CHROME_WEB_STORE_EXTENSION_ID)
        );
        assert_eq!(
            extension_id_from_origin(&format!(
                "edge-extension://{CHROME_WEB_STORE_EXTENSION_ID}/"
            ))
            .as_deref(),
            Some(CHROME_WEB_STORE_EXTENSION_ID)
        );
    }

    #[test]
    fn malformed_or_non_extension_origins_are_rejected() {
        assert!(extension_id_from_origin("https://example.com/").is_none());
        assert!(extension_id_from_origin("chrome-extension://not-an-id/").is_none());
        assert!(extension_id_from_origin(&format!(
            "chrome-extension://{CHROME_WEB_STORE_EXTENSION_ID}/page"
        ))
        .is_none());
    }
}
