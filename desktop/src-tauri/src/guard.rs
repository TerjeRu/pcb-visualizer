// What the app's windows may do and where they may go.
//
// Native access (opening and closing panel windows) is granted at runtime to the one checked service
// origin, and every webview is held to a navigation rule, so another program listening on a loopback
// port cannot be loaded and gain the same access. Tauri calls the navigation hook for every load it can
// see; the check relies on that and on the service never redirecting.

use std::sync::Mutex;

use tauri::ipc::CapabilityBuilder;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url};

use crate::service::ServiceAddress;

/// The keys of `PANELS` in `app/js/core/layout.js`; a test keeps the two lists equal.
pub const PANELS: [&str; 11] = [
    "board",
    "inspector",
    "feed",
    "photo",
    "playbook",
    "wiki",
    "console",
    "timeline",
    "logic",
    "terminal",
    "assistant",
];

/// The native calls the app makes, each with the JavaScript that needs it (`app/js/shell.js`, `main.js`).
/// The constructor's `tauri://created` and `tauri://error` events stay inside the page and need none.
pub const PERMISSIONS: [&str; 5] = [
    // WebviewWindow.getByLabel lists windows (plugin:window|get_all_windows), not webviews
    "core:window:allow-get-all-windows",
    // new WebviewWindow(label, options)
    "core:webview:allow-create-webview-window",
    // setFocus() on a panel window and on the current window
    "core:window:allow-set-focus",
    // close() on a panel window
    "core:window:allow-close",
    // invoke("open_link", {url}): an external link in the system browser (links.rs)
    "allow-open-link",
];

/// The service the windows are allowed to show, or `None` while only the splash is.
pub struct Allowed(pub Mutex<Option<ServiceAddress>>);

pub fn window_labels() -> Vec<String> {
    std::iter::once("main".to_string())
        .chain(PANELS.iter().map(|panel| format!("panel-{panel}")))
        .collect()
}

/// Native access for the pages of exactly this origin, in the main and panel windows only. The app's own
/// pages (the splash) get none.
pub fn service_capability(address: &ServiceAddress) -> CapabilityBuilder {
    let origin = format!("http://{}:{}", address.host(), address.port());
    PERMISSIONS.iter().fold(
        CapabilityBuilder::new(format!("pcbv-service-{}", address.port()))
            .remote(format!("{origin}/*"))
            .local(false)
            .windows(window_labels()),
        |builder, permission| builder.permission(*permission),
    )
}

/// `^[a-z0-9][a-z0-9_-]{0,63}$`, the same rule as `SLUG_RE` in `app/js/session.js`.
fn board_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-')
}

fn service_query_allowed(url: &Url) -> bool {
    let mut seen: Vec<String> = Vec::new();
    for (key, value) in url.query_pairs() {
        if seen.iter().any(|earlier| *earlier == key) {
            return false;
        }
        let good = match key.as_ref() {
            "panel" => PANELS.contains(&value.as_ref()),
            "gen" => !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()),
            "board" => board_slug(&value),
            _ => false,
        };
        if !good {
            return false;
        }
        seen.push(key.into_owned());
    }
    true
}

/// Whether a webview may load `url`: the app's own splash, or the checked service's page with only the
/// query the app itself writes. The fragment is free: it carries the one-time code and in-page links
/// and never reaches a server.
pub fn navigation_allowed(url: &Url, service: Option<&ServiceAddress>) -> bool {
    if url.scheme() == "tauri"
        && url.host_str() == Some("localhost")
        && matches!(url.path(), "/" | "/index.html")
    {
        return true;
    }
    let Some(service) = service else { return false };
    url.scheme() == "http"
        && url.host_str() == Some(service.host())
        && url.port() == Some(service.port())
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && service_query_allowed(url)
}

/// Applies `navigation_allowed` to every webview, including the panel windows the page creates itself.
pub fn navigation_plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("pcbv-navigation")
        .on_navigation(|webview, url| {
            let allowed = webview.state::<Allowed>();
            let service = allowed.0.lock().unwrap();
            navigation_allowed(url, service.as_ref())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::parse_service_url;

    fn service() -> ServiceAddress {
        parse_service_url("http://127.0.0.1:8765").unwrap()
    }

    fn allowed(text: &str) -> bool {
        navigation_allowed(&Url::parse(text).unwrap(), Some(&service()))
    }

    #[test]
    fn panel_names_match_the_front_end() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../app/js/core/layout.js"
        ))
        .unwrap();
        let start = source
            .find("export const PANELS = {")
            .expect("PANELS in layout.js")
            + "export const PANELS = {".len();
        let body = &source[start
            ..source[start..]
                .find("\n};")
                .map(|end| start + end)
                .expect("end of PANELS")];
        let keys: Vec<&str> = body
            .lines()
            .filter_map(|line| line.strip_prefix("  "))
            .filter(|line| line.chars().next().is_some_and(|c| c.is_ascii_lowercase()))
            .filter_map(|line| line.split(':').next())
            .collect();
        assert_eq!(keys, PANELS);
    }

    #[test]
    fn window_labels_are_main_and_the_panels() {
        let labels = window_labels();
        assert_eq!(labels.len(), 12);
        assert_eq!(labels[0], "main");
        assert!(labels[1..]
            .iter()
            .all(|label| label.starts_with("panel-") && !label.contains('*')));
        assert!(labels.contains(&"panel-console".to_string()));
    }

    #[test]
    fn the_service_pages_and_the_splash_are_allowed() {
        for url in [
            "http://127.0.0.1:8765/",
            "http://127.0.0.1:8765/#code=abc",
            "http://127.0.0.1:8765/?panel=console&board=nimbus&gen=12#code=abc",
            "http://127.0.0.1:8765/#wiki/uart",
            "tauri://localhost/index.html",
            "tauri://localhost/",
            "tauri://localhost/?state=failed&reason=x",
        ] {
            assert!(allowed(url), "{url}");
        }
    }

    #[test]
    fn everything_else_is_refused() {
        for url in [
            "http://127.0.0.1:8766/",
            "http://localhost:8765/",
            "https://127.0.0.1:8765/",
            "http://127.0.0.1:8765/api/health",
            "http://127.0.0.1:8765/?panel=evil",
            "http://127.0.0.1:8765/?panel=console&panel=wiki",
            "http://127.0.0.1:8765/?gen=1x",
            "http://127.0.0.1:8765/?gen=",
            "http://127.0.0.1:8765/?board=../x",
            "http://127.0.0.1:8765/?board=Upper",
            "http://127.0.0.1:8765/?other=1",
            "http://user@127.0.0.1:8765/",
            "http://example.com/",
            "tauri://localhost/other",
            "about:blank",
            "data:text/html,x",
            "blob:http://127.0.0.1:8765/x",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            assert!(!allowed(url), "{url}");
        }
    }

    #[test]
    fn without_a_service_only_the_splash_is_allowed() {
        assert!(!navigation_allowed(
            &Url::parse("http://127.0.0.1:8765/").unwrap(),
            None
        ));
        assert!(navigation_allowed(
            &Url::parse("tauri://localhost/index.html").unwrap(),
            None
        ));
    }

    #[test]
    fn board_names_follow_the_front_end_rule() {
        assert!(board_slug("a") && board_slug("nimbus-n100") && board_slug(&"a".repeat(64)));
        assert!(
            !board_slug("")
                && !board_slug("-a")
                && !board_slug("_a")
                && !board_slug(&"a".repeat(65))
        );
    }

    #[test]
    fn the_capability_names_one_origin_and_the_listed_permissions() {
        use tauri::ipc::RuntimeCapability;
        use tauri::utils::acl::capability::CapabilityFile;
        let CapabilityFile::Capability(capability) = service_capability(&service()).build() else {
            panic!("a single capability");
        };
        let value = serde_json::to_value(capability).unwrap();
        assert_eq!(value["identifier"], "pcbv-service-8765");
        assert_eq!(value["local"], false);
        assert_eq!(
            value["remote"]["urls"],
            serde_json::json!(["http://127.0.0.1:8765/*"])
        );
        assert_eq!(value["windows"], serde_json::json!(window_labels()));
        assert_eq!(value["permissions"], serde_json::json!(PERMISSIONS));
        assert!(!value["permissions"].to_string().contains("default"));
        assert!(PERMISSIONS.contains(&"allow-open-link"));
    }
}
