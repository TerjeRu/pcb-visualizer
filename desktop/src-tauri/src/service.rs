// Finding and talking to the local pcbv service.
//
// `service.json` is a file on disk, so nothing in it is trusted until it has been checked: the address
// must be plain HTTP to this machine, the token must be made of URL-safe characters only. The network
// functions take a `ServiceAddress`, which can only be made by the check, so an unchecked address cannot
// reach them. Every exchange has a 2 second deadline and a 64 KiB size limit, and redirects are never
// followed.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::Url;

const MAX_FILE_BYTES: u64 = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const DEADLINE: Duration = Duration::from_secs(2);
const IPV4_LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
const IPV6_LOOPBACK: IpAddr = IpAddr::V6(Ipv6Addr::LOCALHOST);

#[derive(Deserialize)]
struct ServiceFile {
    url: String,
    token: String,
}

/// An address that passed `parse_service_url`.
#[derive(Clone, Debug)]
pub struct ServiceAddress {
    url: Url,
    host: String,
    port: u16,
    ips: &'static [IpAddr],
}

/// A checked address with a checked token.
pub type Service = (ServiceAddress, String);

pub fn runtime_dir() -> PathBuf {
    match std::env::var_os("XDG_RUNTIME_DIR") {
        Some(dir) => PathBuf::from(dir).join("pcbv"),
        None => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".cache/pcbv"),
    }
}

impl ServiceAddress {
    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

/// Accepts only `http://127.0.0.1:PORT`, `http://[::1]:PORT` and `http://localhost:PORT`, with an
/// explicit port other than 0 and 80, no credentials, path `/`, no query and no fragment. The error
/// names the rule that failed.
pub fn parse_service_url(text: &str) -> Result<ServiceAddress, String> {
    let url = Url::parse(text).map_err(|_| "the address is not a URL".to_string())?;
    if url.scheme() != "http" {
        return Err("the address is not plain http".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("the address has a user name or password".into());
    }
    // `Url` writes every host in one canonical form (`127.1` becomes `127.0.0.1`, `[0:0::1]` becomes
    // `[::1]`, names are lower-cased), so an exact match on it is a match on the parsed host. Tauri does
    // not re-export the `url` crate's `Host` type. `localhost` maps to both loopback addresses directly:
    // a name lookup has no deadline.
    let (host, ips): (String, &'static [IpAddr]) = match url.host_str() {
        Some("127.0.0.1") => ("127.0.0.1".into(), &[IPV4_LOOPBACK]),
        Some("[::1]") => ("[::1]".into(), &[IPV6_LOOPBACK]),
        Some("localhost") => ("localhost".into(), &[IPV4_LOOPBACK, IPV6_LOOPBACK]),
        _ => return Err("the host is not 127.0.0.1, [::1] or localhost".into()),
    };
    let port = match url.port() {
        Some(port) if port != 0 => port,
        _ => return Err("the address has no usable port".into()),
    };
    if url.path() != "/" {
        return Err("the address has a path".into());
    }
    if url.query().is_some() {
        return Err("the address has a query".into());
    }
    if url.fragment().is_some() {
        return Err("the address has a fragment".into());
    }
    Ok(ServiceAddress {
        url,
        host,
        port,
        ips,
    })
}

/// The service makes tokens with `secrets.token_urlsafe(32)`; the same rule holds for one-time codes.
fn valid_token(token: &str) -> bool {
    (16..=256).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The advertised address and token from `service.json`, or `None` when the file is missing, too big,
/// not JSON, or fails either check. Nothing touches the network.
pub fn read_info() -> Option<Service> {
    read_info_from(&runtime_dir().join("service.json"))
}

fn read_info_from(path: &Path) -> Option<Service> {
    // Opening a FIFO with no writer blocks for ever, so only a regular file is opened. Swapping the file
    // between the two checks needs write access to the user's own runtime directory.
    if !std::fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return None;
    }
    let file: ServiceFile = serde_json::from_slice(&bytes).ok()?;
    let address = parse_service_url(&file.url).ok()?;
    valid_token(&file.token).then_some((address, file.token))
}

/// One HTTP/1.0 exchange on a loopback address. Returns the body of a 200 answer. Stops at the deadline,
/// at the size limit, and on any other status (redirects included).
fn exchange(address: &ServiceAddress, request: &str) -> Option<Vec<u8>> {
    let started = Instant::now();
    let mut stream = connect_loopback(address, started)?;
    stream.set_write_timeout(Some(remaining(started)?)).ok()?;
    stream.write_all(request.as_bytes()).ok()?;

    let mut response = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        stream.set_read_timeout(Some(remaining(started)?)).ok()?;
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                response.extend_from_slice(&chunk[..n]);
                if response.len() > MAX_RESPONSE_BYTES {
                    return None;
                }
            }
            Err(_) => return None,
        }
    }

    let split = response.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&response[..split]).ok()?;
    let mut status = head.lines().next()?.split_whitespace();
    let version = status.next()?;
    if !(version == "HTTP/1.0" || version == "HTTP/1.1") || status.next()? != "200" {
        return None;
    }
    Some(response[split + 4..].to_vec())
}

fn remaining(started: Instant) -> Option<Duration> {
    DEADLINE
        .checked_sub(started.elapsed())
        .filter(|left| !left.is_zero())
}

fn connect_loopback(address: &ServiceAddress, started: Instant) -> Option<TcpStream> {
    for ip in address.ips {
        if let Ok(stream) =
            TcpStream::connect_timeout(&SocketAddr::new(*ip, address.port), remaining(started)?)
        {
            return Some(stream);
        }
    }
    None
}

fn host_header(address: &ServiceAddress) -> String {
    format!("{}:{}", address.host, address.port)
}

/// The protocol number the app speaks; `pcbv` refuses a service that answers another one.
const PROTOCOL: u64 = 2;

#[derive(Debug, PartialEq, Eq)]
pub enum Health {
    Ready,
    Incompatible,
    Down,
}

/// GET /api/health: `Ready` for a 200 answer whose JSON body says `"ok": true` and `"protocol": 2` (the
/// integer). The same answer with another or no protocol is `Incompatible`; everything else is `Down`.
pub fn probe(address: &ServiceAddress) -> Health {
    let request = format!(
        "GET /api/health HTTP/1.0\r\nHost: {}\r\nConnection: close\r\n\r\n",
        host_header(address)
    );
    let Some(body) = exchange(address, &request) else {
        return Health::Down;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) else {
        return Health::Down;
    };
    if value.get("ok") != Some(&serde_json::Value::Bool(true)) {
        return Health::Down;
    }
    match value.get("protocol").and_then(serde_json::Value::as_u64) {
        Some(PROTOCOL) => Health::Ready,
        _ => Health::Incompatible,
    }
}

/// POST /api/session/code with the advertised token. The window then opens with the one-time code, so
/// the token itself never appears in a navigation URL.
pub fn mint_code(address: &ServiceAddress, token: &str) -> Option<String> {
    if !valid_token(token) {
        return None;
    }
    let request = format!(
        "POST /api/session/code HTTP/1.0\r\nHost: {}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}",
        host_header(address)
    );
    let body = exchange(address, &request)?;
    let value: serde_json::Value = serde_json::from_slice(&body).ok()?;
    let code = value.get("code")?.as_str()?;
    valid_token(code).then(|| code.to_owned())
}

/// The window address: the checked URL, with the one-time code in the fragment when there is one. The
/// fragment is never sent to the server or logged.
pub fn app_url(address: &ServiceAddress, code: Option<&str>) -> Url {
    let mut url = address.url.clone();
    if let Some(code) = code {
        url.set_fragment(Some(&format!("code={code}")));
    }
    url
}

pub enum Running {
    Ready(Service),
    Incompatible,
    Absent,
}

/// The service named in `service.json`, when the file passes the checks and the service answers.
pub fn running_service() -> Running {
    let Some((address, token)) = read_info() else {
        return Running::Absent;
    };
    match probe(&address) {
        Health::Ready => Running::Ready((address, token)),
        Health::Incompatible => Running::Incompatible,
        Health::Down => Running::Absent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::thread;

    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyz012345-_ABCDEF";

    #[test]
    fn accepts_loopback_addresses() {
        for text in [
            "http://127.0.0.1:8765",
            "http://127.0.0.1:8765/",
            "http://[::1]:8765",
            "http://localhost:8765",
        ] {
            assert!(parse_service_url(text).is_ok(), "{text} should be accepted");
        }
    }

    #[test]
    fn refuses_other_addresses() {
        for text in [
            "https://127.0.0.1:8765",
            "ftp://127.0.0.1:21",
            "http://user:pw@127.0.0.1:8765",
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://127.0.0.1:80",
            "http://127.0.0.2:8765",
            "http://10.0.0.1:8765",
            "http://example.com:8765",
            "http://localhost.:8765",
            "http://0.0.0.0:8765",
            "http://[::ffff:127.0.0.1]:8765",
            "http://[::2]:8765",
            "http://127.0.0.1:8765/app",
            "http://127.0.0.1:8765/?x=1",
            "http://127.0.0.1:8765/?",
            "http://127.0.0.1:8765/#code=1",
            "http://127.0.0.1:99999",
            "not a url",
        ] {
            assert!(parse_service_url(text).is_err(), "{text} should be refused");
        }
    }

    #[test]
    fn error_text_never_holds_the_token() {
        let error = parse_service_url(&format!("http://user:{TOKEN}@127.0.0.1:8765")).unwrap_err();
        assert!(!error.contains(TOKEN));
    }

    #[test]
    fn token_length_and_characters() {
        assert!(!valid_token(&"a".repeat(15)));
        assert!(valid_token(&"a".repeat(16)));
        assert!(valid_token(&"a".repeat(256)));
        assert!(!valid_token(&"a".repeat(257)));
        for bad in [
            "aaaaaaaaaaaaaaa\r\n",
            "aaaaaaaaaaaaaaaa aaaa",
            "aaaaaaaaaaaaaaaa:aaaa",
            "aaaaaaaaaaaaaaaaaaaaé",
        ] {
            assert!(!valid_token(bad), "{bad:?} should be refused");
        }
    }

    fn scratch_file(contents: &[u8]) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let name = format!(
            "pcbv-service-test-{}-{}.json",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn read_text(text: &str) -> Option<Service> {
        let path = scratch_file(text.as_bytes());
        let result = read_info_from(&path);
        let _ = std::fs::remove_file(path);
        result
    }

    #[test]
    fn reads_a_good_file_and_refuses_bad_ones() {
        let good = format!(r#"{{"url": "http://127.0.0.1:8765", "token": "{TOKEN}"}}"#);
        let (address, token) = read_text(&good).expect("good file");
        assert_eq!(address.port, 8765);
        assert_eq!(token, TOKEN);

        assert!(read_text(&format!(
            r#"{{"url": "http://example.com:8765", "token": "{TOKEN}"}}"#
        ))
        .is_none());
        assert!(read_text(r#"{"url": "http://127.0.0.1:8765", "token": "short"}"#).is_none());
        assert!(read_text(
            r#"{"url": "http://127.0.0.1:8765", "token": "bad token bad token bad\r\nX: y"}"#
        )
        .is_none());
        assert!(read_text("not json").is_none());

        let mut big = good.into_bytes();
        big.resize(65_537, b' ');
        let path = scratch_file(&big);
        assert!(read_info_from(&path).is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_fifo_is_refused_without_blocking() {
        let path = scratch_file(b"");
        std::fs::remove_file(&path).unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .unwrap()
            .success());
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader_path = path.clone();
        thread::spawn(move || {
            let _ = sender.send(read_info_from(&reader_path).is_none());
        });
        let refused = receiver.recv_timeout(Duration::from_secs(2));
        let _ = std::fs::remove_file(&path);
        assert_eq!(refused, Ok(true), "reading a FIFO must be refused at once");
    }

    /// Answers one connection with `reply` (or never, when `None`) and returns the address to reach it.
    fn serve_once(reply: Option<Vec<u8>>) -> ServiceAddress {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer);
                match reply {
                    Some(bytes) => {
                        let _ = stream.write_all(&bytes);
                    }
                    None => thread::sleep(Duration::from_secs(6)),
                }
            }
        });
        parse_service_url(&format!("http://127.0.0.1:{port}")).unwrap()
    }

    fn reply(status: &str, extra: &str, body: &[u8]) -> Option<Vec<u8>> {
        let mut bytes = format!(
            "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        bytes.extend_from_slice(body);
        Some(bytes)
    }

    #[test]
    fn health_needs_200_ok_true_and_protocol_2() {
        let health =
            |status: &str, extra: &str, body: &[u8]| probe(&serve_once(reply(status, extra, body)));
        assert_eq!(
            health("200 OK", "", br#"{"ok":true,"protocol":2}"#),
            Health::Ready
        );
        for body in [
            &br#"{"ok":true}"#[..],
            br#"{"ok":true,"protocol":1}"#,
            br#"{"ok":true,"protocol":"2"}"#,
            br#"{"ok":true,"protocol":2.0}"#,
        ] {
            assert_eq!(
                health("200 OK", "", body),
                Health::Incompatible,
                "{}",
                String::from_utf8_lossy(body)
            );
        }
        assert_eq!(
            health("200 OK", "", br#"{"ok":false,"protocol":2}"#),
            Health::Down
        );
        assert_eq!(health("200 OK", "", b"hello"), Health::Down);
        assert_eq!(
            health(
                "302 Found",
                "Location: http://example.com/\r\n",
                br#"{"ok":true,"protocol":2}"#
            ),
            Health::Down
        );
        let mut big = br#"{"ok":true,"protocol":2,"pad":""#.to_vec();
        big.resize(70_000, b'x');
        big.extend_from_slice(b"\"}");
        assert_eq!(health("200 OK", "", &big), Health::Down);
    }

    #[test]
    fn a_silent_listener_is_unhealthy_within_the_deadline() {
        let address = serve_once(None);
        let started = Instant::now();
        assert_eq!(probe(&address), Health::Down);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_dripping_answer_is_cut_off_at_the_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer);
                for byte in b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" {
                    if stream.write_all(&[*byte]).is_err() {
                        return;
                    }
                    thread::sleep(Duration::from_millis(500));
                }
            }
        });
        let address = parse_service_url(&format!("http://127.0.0.1:{port}")).unwrap();
        let started = Instant::now();
        assert_eq!(probe(&address), Health::Down);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn mints_only_well_formed_codes() {
        let good = r#"{"code":"abcdefghijklmnopqrstuvwxyz012345"}"#;
        assert_eq!(
            mint_code(&serve_once(reply("200 OK", "", good.as_bytes())), TOKEN).as_deref(),
            Some("abcdefghijklmnopqrstuvwxyz012345")
        );
        assert!(mint_code(
            &serve_once(reply(
                "200 OK",
                "",
                br#"{"code":"abcdefghijklmnop/qrstuvwxyz"}"#
            )),
            TOKEN
        )
        .is_none());
        let long = format!(r#"{{"code":"{}"}}"#, "a".repeat(300));
        assert!(mint_code(&serve_once(reply("200 OK", "", long.as_bytes())), TOKEN).is_none());
        assert!(mint_code(
            &serve_once(reply("401 Unauthorized", "", good.as_bytes())),
            TOKEN
        )
        .is_none());
        assert!(mint_code(
            &serve_once(reply(
                "302 Found",
                "Location: http://example.com/\r\n",
                good.as_bytes()
            )),
            TOKEN
        )
        .is_none());
        let mut big = good.as_bytes().to_vec();
        big.resize(70_000, b' ');
        assert!(mint_code(&serve_once(reply("200 OK", "", &big)), TOKEN).is_none());
    }

    #[test]
    fn a_bad_token_is_never_sent() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let address = parse_service_url(&format!("http://127.0.0.1:{port}")).unwrap();
        assert!(mint_code(&address, "x\r\nInjected: yes").is_none());
        listener.set_nonblocking(true).unwrap();
        let error = listener
            .accept()
            .expect_err("mint_code must not connect with a bad token");
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
    }

    #[test]
    fn localhost_is_reached_without_a_name_lookup() {
        let address = parse_service_url("http://LocalHost:8765").unwrap();
        assert_eq!(address.ips, &[IPV4_LOOPBACK, IPV6_LOOPBACK]);
        assert_eq!(host_header(&address), "localhost:8765");
        assert_eq!(
            host_header(&parse_service_url("http://[0:0::1]:8765").unwrap()),
            "[::1]:8765"
        );
        assert_eq!(
            host_header(&parse_service_url("http://127.1:8765").unwrap()),
            "127.0.0.1:8765"
        );
    }

    #[test]
    fn window_address_carries_the_code_in_the_fragment() {
        let address = parse_service_url("http://127.0.0.1:8765").unwrap();
        assert_eq!(
            app_url(&address, Some("abc")).as_str(),
            "http://127.0.0.1:8765/#code=abc"
        );
        assert_eq!(app_url(&address, None).as_str(), "http://127.0.0.1:8765/");
    }
}
