// Links to other sites open in the system browser, through `xdg-open`.
//
// The page asks first (app/js/core/links.js); this command still checks the address itself, because the
// window that calls it shows a page from the service.

use std::process::{Command, Stdio};
use std::thread;

use tauri::Url;

const MAX_URL_BYTES: usize = 2048;

/// An `http` or `https` address with a host, no user name or password, at most 2048 bytes long.
pub fn link_allowed(text: &str) -> Result<Url, String> {
    if text.len() > MAX_URL_BYTES {
        return Err(format!("The link is longer than {MAX_URL_BYTES} bytes."));
    }
    let url = Url::parse(text).map_err(|_| "The link is not a web address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http and https links can be opened.".into());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("The link has no host.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("A link with a user name or password is not opened.".into());
    }
    Ok(url)
}

#[tauri::command]
pub fn open_link(url: String) -> Result<(), String> {
    let url = link_allowed(&url)?;
    let mut child = Command::new("xdg-open")
        .arg(url.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("The system browser could not be started (xdg-open): {error}"))?;
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_addresses_are_allowed() {
        for good in [
            "http://example.com",
            "https://example.com/a?b=c#d",
            "https://[::1]:8443/x",
            "http://127.0.0.1:8080/",
        ] {
            assert!(link_allowed(good).is_ok(), "{good}");
        }
    }

    #[test]
    fn other_schemes_are_refused() {
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com/",
            "tauri://localhost",
            "mailto:a@b.c",
            "data:text/html,x",
            "xdg-open://x",
        ] {
            assert!(link_allowed(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn text_that_is_not_an_address_is_refused() {
        for bad in [
            "",
            "example.com",
            "//example.com",
            "http://",
            "https://:80/",
            "not a url",
            "-o /tmp/x",
        ] {
            assert!(link_allowed(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_user_name_or_password_is_refused() {
        for bad in [
            "https://user@example.com/",
            "https://user:pw@example.com/",
            "https://:pw@example.com/",
        ] {
            assert!(link_allowed(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_length_limit_is_2048_bytes() {
        let at_limit = format!(
            "https://example.com/{}",
            "a".repeat(2048 - "https://example.com/".len())
        );
        assert_eq!(at_limit.len(), 2048);
        assert!(link_allowed(&at_limit).is_ok());
        assert!(link_allowed(&format!("{at_limit}a")).is_err());
    }
}
