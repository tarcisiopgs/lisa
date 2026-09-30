//! Notificação do sistema operacional.

use std::process::{Command, Stdio};

pub trait SystemNotifier: Send + Sync {
    fn notify(&self, title: &str, body: &str);
}

/// `osascript` no macOS, `notify-send` no Linux. Falha silenciosa: a UI ainda
/// avisa pelo terminal quando está conectada.
#[derive(Debug, Default)]
pub struct OsNotifier;

/// Escapa texto para uma string AppleScript entre aspas duplas.
fn applescript_quote(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

impl SystemNotifier for OsNotifier {
    fn notify(&self, title: &str, body: &str) {
        let mut cmd = if cfg!(target_os = "macos") {
            let script = format!(
                "display notification {} with title {}",
                applescript_quote(body),
                applescript_quote(title)
            );
            let mut c = Command::new("osascript");
            c.args(["-e", &script]);
            c
        } else {
            let mut c = Command::new("notify-send");
            c.args(["--app-name=Lisa", title, body]);
            c
        };
        let _ = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|mut child| std::thread::spawn(move || child.wait()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applescript_strings_escape_quotes_and_backslashes() {
        assert_eq!(applescript_quote(r#"say "hi" \o/"#), r#""say \"hi\" \\o/""#);
    }
}
