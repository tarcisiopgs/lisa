//! Hooks do Claude Code injetados por sessão com `--settings`, sem tocar na
//! configuração do usuário nem no repositório.

use std::io;
use std::path::{Path, PathBuf};

/// Eventos do Claude Code que a Lisa escuta.
pub const CLAUDE_EVENTS: [&str; 4] = ["SessionStart", "UserPromptSubmit", "Notification", "Stop"];

/// Aspas simples de shell para um caminho.
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

/// JSON de settings com um hook por evento chamando `lisa-workspace hook <evento>`.
pub fn claude_settings_json(exe: &Path) -> String {
    let hooks: serde_json::Map<String, serde_json::Value> = CLAUDE_EVENTS
        .iter()
        .map(|event| {
            let command = format!("{} hook {event}", shell_quote(exe));
            (
                (*event).to_owned(),
                serde_json::json!([{ "matcher": "", "hooks": [{ "type": "command", "command": command }] }]),
            )
        })
        .collect();
    serde_json::to_string_pretty(&serde_json::json!({ "hooks": hooks })).unwrap_or_default()
}

/// Grava (ou reescreve) o arquivo de settings e devolve o caminho.
pub fn write_claude_settings(dir: &Path, exe: &Path) -> io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("claude-settings.json");
    std::fs::write(&path, claude_settings_json(exe))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_event_calls_the_hook_subcommand_with_the_quoted_binary() {
        let json = claude_settings_json(Path::new("/opt/lisa/bin/lisa-workspace"));
        for event in CLAUDE_EVENTS {
            assert!(
                json.contains(&format!(
                    "\"command\": \"'/opt/lisa/bin/lisa-workspace' hook {event}\""
                )),
                "{event} missing in {json}"
            );
        }
    }

    #[test]
    fn single_quotes_in_the_path_are_escaped() {
        assert_eq!(shell_quote(Path::new("/a'b")), r#"'/a'\''b'"#);
    }
}
