//! Estado do terminal hospedeiro e preferências da UI.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crossterm::event::{DisableBracketedPaste, DisableFocusChange, PopKeyboardEnhancementFlags};
use crossterm::queue;

/// Sequências que desfazem tudo o que a UI ligou no terminal hospedeiro.
pub fn restore_bytes(enhanced: bool) -> Vec<u8> {
    let mut out = Vec::new();
    if enhanced {
        let _ = queue!(out, PopKeyboardEnhancementFlags);
    }
    let _ = queue!(out, DisableBracketedPaste, DisableFocusChange);
    out
}

fn restore(enhanced: bool) {
    let mut stdout = io::stdout();
    let _ = stdout.write_all(&restore_bytes(enhanced));
    let _ = stdout.flush();
    ratatui::restore();
}

/// Restaura o terminal ao sair por qualquer caminho: retorno normal, `?` ou pânico.
pub struct TerminalGuard {
    enhanced: bool,
}

impl TerminalGuard {
    /// Chamar logo depois de ligar os modos; encadeia a restauração no hook de pânico.
    pub fn new(enhanced: bool) -> Self {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            restore(enhanced);
            previous(info);
        }));
        TerminalGuard { enhanced }
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore(self.enhanced);
    }
}

/// Desliga o raw mode ao sair do escopo (prompt antes da TUI).
pub struct RawModeGuard;

impl RawModeGuard {
    pub fn enable() -> io::Result<Self> {
        crossterm::terminal::enable_raw_mode()?;
        Ok(RawModeGuard)
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
    }
}

/// `~/.lisa/workspace/prefs.json`
pub fn prefs_path() -> PathBuf {
    crate::registry::lisa_home()
        .join("workspace")
        .join("prefs.json")
}

pub fn load_default_autonomy(path: &Path) -> bool {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| {
            v.get("default_autonomy")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false)
}

/// Falha silenciosa: é uma conveniência, não pode derrubar a UI.
pub fn save_default_autonomy(path: &Path, on: bool) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = serde_json::json!({ "default_autonomy": on }).to_string();
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_undoes_every_mode_the_ui_turned_on() {
        let bytes = String::from_utf8(restore_bytes(true)).unwrap_or_default();
        assert!(
            bytes.contains("\x1b[<1u"),
            "keyboard flags not popped: {bytes:?}"
        );
        assert!(
            bytes.contains("\x1b[?2004l"),
            "bracketed paste left on: {bytes:?}"
        );
        assert!(
            bytes.contains("\x1b[?1004l"),
            "focus reporting left on: {bytes:?}"
        );
    }

    #[test]
    fn restore_skips_the_keyboard_pop_when_flags_were_not_pushed() {
        let bytes = String::from_utf8(restore_bytes(false)).unwrap_or_default();
        assert!(!bytes.contains("\x1b[<1u"));
    }

    #[test]
    fn default_autonomy_round_trips_and_defaults_to_normal() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = dir.path().join("prefs.json");
        assert!(!load_default_autonomy(&path));
        save_default_autonomy(&path, true);
        assert!(load_default_autonomy(&path));
    }
}
