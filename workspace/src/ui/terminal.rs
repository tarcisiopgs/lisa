//! Estado do terminal hospedeiro e preferências da UI.

use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crossterm::event::{DisableBracketedPaste, DisableFocusChange, PopKeyboardEnhancementFlags};
use crossterm::queue;
use serde::{Deserialize, Serialize};

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

/// Preferências da UI nesta máquina. Lidas e gravadas inteiras, para uma não apagar a outra.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    pub default_autonomy: bool,
    pub sidebar_width: Option<u16>,
    /// Slug do grupo → slug do último projeto em que um worktree foi criado.
    pub last_repo: BTreeMap<String, String>,
}

impl Prefs {
    /// Arquivo ausente ou ilegível vira o padrão.
    pub fn load(path: &Path) -> Prefs {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Falha silenciosa: é uma conveniência, não pode derrubar a UI.
    pub fn save(&self, path: &Path) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let Ok(body) = serde_json::to_vec(self) else {
            return;
        };
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, body).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
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

    fn prefs_file() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = dir.path().join("prefs.json");
        (dir, path)
    }

    #[test]
    fn prefs_round_trip_and_default_when_missing() {
        let (_dir, path) = prefs_file();
        assert_eq!(Prefs::load(&path), Prefs::default());
        let prefs = Prefs {
            default_autonomy: true,
            sidebar_width: Some(34),
            last_repo: BTreeMap::from([("acme".to_owned(), "acme-api".to_owned())]),
        };
        prefs.save(&path);
        assert_eq!(Prefs::load(&path), prefs);
    }

    #[test]
    fn a_prefs_file_from_the_previous_version_keeps_its_autonomy() {
        let (_dir, path) = prefs_file();
        std::fs::write(&path, r#"{"default_autonomy":true}"#).unwrap_or_else(|e| panic!("{e}"));
        let prefs = Prefs::load(&path);
        assert!(prefs.default_autonomy);
        assert_eq!(prefs.sidebar_width, None);
        assert!(prefs.last_repo.is_empty());
    }

    #[test]
    fn saving_one_preference_keeps_the_others() {
        let (_dir, path) = prefs_file();
        Prefs {
            default_autonomy: true,
            sidebar_width: None,
            last_repo: BTreeMap::from([("acme".to_owned(), "acme-api".to_owned())]),
        }
        .save(&path);
        let mut prefs = Prefs::load(&path);
        prefs.sidebar_width = Some(40);
        prefs.save(&path);
        let again = Prefs::load(&path);
        assert!(again.default_autonomy);
        assert_eq!(again.sidebar_width, Some(40));
        assert_eq!(again.last_repo.len(), 1);
    }

    #[test]
    fn an_unreadable_prefs_file_falls_back_to_the_defaults() {
        let (_dir, path) = prefs_file();
        std::fs::write(&path, "not json").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(Prefs::load(&path), Prefs::default());
    }
}
