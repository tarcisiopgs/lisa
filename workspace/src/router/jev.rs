//! Cliente do Jev (TypeSafe). A chave vem do ambiente e nunca é gravada nem exibida.

use std::time::Duration;

use super::{Answers, RouteError};

pub const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
pub const KEY_VAR: &str = "TYPESAFE_API_KEY";
pub const TIMEOUT: Duration = Duration::from_secs(3);

/// Quem responde às perguntas do roteador; os testes da UI usam uma implementação falsa.
pub trait Decider: Send + Sync {
    fn ask(&self, task: &str) -> Result<Answers, RouteError>;
}

pub struct HttpJev {
    endpoint: String,
    key: Option<String>,
    agent: ureq::Agent,
}

impl std::fmt::Debug for HttpJev {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpJev")
            .field("endpoint", &self.endpoint)
            .field("key", &self.key.as_ref().map(|_| "<set>"))
            .finish()
    }
}

impl HttpJev {
    pub fn from_env() -> HttpJev {
        HttpJev::new(ENDPOINT.to_owned(), std::env::var(KEY_VAR).ok(), TIMEOUT)
    }

    pub fn new(endpoint: String, key: Option<String>, timeout: Duration) -> HttpJev {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            // O status vira `RouteError` aqui, não erro de transporte
            .http_status_as_error(false)
            .build()
            .into();
        HttpJev {
            endpoint,
            key: key.map(|k| k.trim().to_owned()).filter(|k| !k.is_empty()),
            agent,
        }
    }
}

impl Decider for HttpJev {
    fn ask(&self, task: &str) -> Result<Answers, RouteError> {
        let key = self.key.as_deref().ok_or(RouteError::NoKey)?;
        let body = super::request_body(task).to_string();
        let mut response = self
            .agent
            .post(&self.endpoint)
            .header("Authorization", format!("Bearer {key}"))
            .header("Content-Type", "application/json")
            .send(body)
            .map_err(transport)?;
        match response.status().as_u16() {
            200 => {}
            401 => return Err(RouteError::Unauthorized),
            429 => return Err(RouteError::RateLimited),
            529 => return Err(RouteError::Overloaded),
            _ => return Err(RouteError::BadResponse),
        }
        let text = response.body_mut().read_to_string().map_err(transport)?;
        let json = serde_json::from_str(&text).map_err(|_| RouteError::BadResponse)?;
        super::parse_answers(&json).ok_or(RouteError::BadResponse)
    }
}

fn transport(err: ureq::Error) -> RouteError {
    match err {
        ureq::Error::Timeout(_) => RouteError::Timeout,
        _ => RouteError::Network,
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{self, Receiver};
    use std::thread;

    use super::*;
    use crate::router::{Kind, request_body};

    const ANSWER: &str = r#"{"model":"jev-1.13.0","answers":{"depth":{"type":"noul","noul":0.82},"kind":{"type":"choice","choice":"investigation","confidence":0.93,"probabilities":{"visual_ui":0.0,"review":0.0,"investigation":0.95,"other":0.05}},"size":{"type":"score","score":2.78,"confidence":0.78,"probabilities":{"0":0.0,"1":0.0,"2":0.22,"3":0.78}}}}"#;

    /// Servidor de uma requisição só: devolve `status` e `body`, e entrega o que recebeu.
    fn server(status: u16, body: &'static str) -> (String, Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("{e}"));
        let addr = listener.local_addr().unwrap_or_else(|e| panic!("{e}"));
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut seen = Vec::new();
            let mut buf = [0u8; 4096];
            // Lê cabeçalhos e corpo (Content-Length) antes de responder
            loop {
                let Ok(n) = stream.read(&mut buf) else { return };
                if n == 0 {
                    break;
                }
                seen.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&seen);
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let len = text
                        .lines()
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            k.eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    if seen.len() >= head_end + 4 + len {
                        break;
                    }
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&seen).into_owned());
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        });
        (format!("http://{addr}/v1/systemone"), rx)
    }

    fn jev(endpoint: String) -> HttpJev {
        HttpJev::new(
            endpoint,
            Some("k-secret".to_owned()),
            Duration::from_secs(2),
        )
    }

    #[test]
    fn no_key_never_opens_a_connection() {
        let (endpoint, seen) = server(200, ANSWER);
        for key in [None, Some(String::new()), Some("  ".to_owned())] {
            let client = HttpJev::new(endpoint.clone(), key, Duration::from_secs(2));
            assert_eq!(client.ask("t"), Err(RouteError::NoKey));
        }
        assert!(seen.try_recv().is_err());
    }

    #[test]
    fn sends_bearer_key_and_the_request_body() {
        let (endpoint, seen) = server(200, ANSWER);
        let _ = jev(endpoint).ask("fix login");
        let request = seen
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|e| panic!("{e}"));
        let lower = request.to_lowercase();
        assert!(request.starts_with("POST /v1/systemone "), "{request}");
        assert!(
            lower.contains("authorization: bearer k-secret"),
            "{request}"
        );
        assert!(
            lower.contains("content-type: application/json"),
            "{request}"
        );
        let body = request.split("\r\n\r\n").nth(1).unwrap_or_default();
        let sent: serde_json::Value = serde_json::from_str(body).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(sent, request_body("fix login"));
    }

    #[test]
    fn a_documented_answer_becomes_answers() {
        let (endpoint, _seen) = server(200, ANSWER);
        let a = jev(endpoint).ask("t").unwrap_or_else(|e| panic!("{e:?}"));
        assert_eq!(a.kind, Kind::Investigation);
        assert_eq!(a.size_probs, [0.0, 0.0, 0.22, 0.78]);
    }

    #[test]
    fn status_codes_map_to_their_errors() {
        for (status, expected) in [
            (401, RouteError::Unauthorized),
            (429, RouteError::RateLimited),
            (529, RouteError::Overloaded),
            (500, RouteError::BadResponse),
            (422, RouteError::BadResponse),
        ] {
            let (endpoint, _seen) = server(status, "{}");
            assert_eq!(jev(endpoint).ask("t"), Err(expected), "{status}");
        }
    }

    #[test]
    fn a_silent_server_times_out() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("{e}"));
        let addr = listener.local_addr().unwrap_or_else(|e| panic!("{e}"));
        let client = HttpJev::new(
            format!("http://{addr}/v1/systemone"),
            Some("k".to_owned()),
            Duration::from_millis(200),
        );
        // Aceita no backlog e nunca responde
        assert_eq!(client.ask("t"), Err(RouteError::Timeout));
        drop(listener);
    }

    #[test]
    fn a_closed_port_is_a_network_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("{e}"));
        let addr = listener.local_addr().unwrap_or_else(|e| panic!("{e}"));
        drop(listener);
        assert_eq!(
            jev(format!("http://{addr}/v1/systemone")).ask("t"),
            Err(RouteError::Network)
        );
    }

    #[test]
    fn garbage_body_is_a_bad_response() {
        let (endpoint, _seen) = server(200, "<html>nope</html>");
        assert_eq!(jev(endpoint).ask("t"), Err(RouteError::BadResponse));
        let (endpoint, _seen) = server(200, r#"{"answers":{}}"#);
        assert_eq!(jev(endpoint).ask("t"), Err(RouteError::BadResponse));
    }

    #[test]
    fn the_key_never_shows_up_when_the_client_is_printed() {
        let printed = format!("{:?}", jev("http://x".to_owned()));
        assert!(!printed.contains("k-secret"), "{printed}");
    }
}
