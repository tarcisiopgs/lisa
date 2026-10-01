//! Seletor de pastas do diálogo de adicionar projeto: lista um diretório por vez, filtra
//! pelo que é digitado e navega para dentro e para fora. É o único ponto da UI que lê o
//! sistema de arquivos, e só ao abrir ou trocar de pasta.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    /// Tem `.git`: pode virar projeto.
    pub repo: bool,
    /// Já está mapeado como projeto.
    pub added: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Stay,
    /// Caminho escolhido; o daemon valida o repositório.
    Add(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Picker {
    home: Option<PathBuf>,
    /// Projetos já mapeados, em caminho canônico.
    added: Vec<PathBuf>,
    /// Filtro da pasta listada ou, começando com `/` ou `~`, um caminho.
    query: String,
    listed: PathBuf,
    entries: Vec<Entry>,
    error: Option<String>,
    selected: usize,
}

/// Quão perto o nome está do filtro: igual, prefixo, trecho contíguo, subsequência.
fn rank(name: &str, filter: &str) -> Option<u8> {
    let name = name.to_lowercase();
    let filter = filter.to_lowercase();
    if filter.is_empty() || name == filter {
        return Some(0);
    }
    if name.starts_with(&filter) {
        return Some(1);
    }
    if name.contains(&filter) {
        return Some(2);
    }
    let mut chars = name.chars();
    filter.chars().all(|f| chars.any(|c| c == f)).then_some(3)
}

fn read(dir: &Path, added: &[PathBuf]) -> Result<Vec<Entry>, String> {
    let listing = std::fs::read_dir(dir).map_err(|e| match e.kind() {
        ErrorKind::NotFound => "no such folder".to_owned(),
        ErrorKind::PermissionDenied => "permission denied".to_owned(),
        _ => e.to_string(),
    })?;
    let mut entries: Vec<Entry> = listing
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|path| path.is_dir())
        .filter_map(|path| {
            let repo = path.join(".git").exists();
            Some(Entry {
                name: path.file_name()?.to_string_lossy().into_owned(),
                repo,
                added: repo && path.canonicalize().is_ok_and(|p| added.contains(&p)),
            })
        })
        .collect();
    entries.sort_by_key(|e| (!e.repo, e.name.to_lowercase()));
    Ok(entries)
}

impl Picker {
    pub fn open(start: &Path, home: Option<PathBuf>, added: &[PathBuf]) -> Self {
        let mut picker = Picker {
            home,
            added: added
                .iter()
                .map(|p| p.canonicalize().unwrap_or_else(|_| p.clone()))
                .collect(),
            query: String::new(),
            listed: PathBuf::new(),
            entries: Vec::new(),
            error: None,
            selected: 0,
        };
        picker.go(start.to_path_buf(), None);
        picker
    }

    // ---- Leitura (render) ----

    /// Pasta listada, com o HOME abreviado e a barra no fim.
    pub fn dir_label(&self) -> String {
        let home = self.home.as_deref();
        let shown = match home.and_then(|h| self.listed.strip_prefix(h).ok()) {
            Some(rest) if rest.as_os_str().is_empty() => "~".to_owned(),
            Some(rest) => format!("~/{}", rest.display()),
            None => self.listed.display().to_string(),
        };
        if shown.ends_with('/') {
            shown
        } else {
            format!("{shown}/")
        }
    }

    pub fn query(&self) -> &str {
        &self.query
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    /// Pastas que passam no filtro, as mais próximas dele primeiro. Ocultas só aparecem
    /// quando o filtro começa com ponto.
    pub fn visible(&self) -> Vec<&Entry> {
        let filter = self.filter();
        let hidden = filter.starts_with('.');
        let mut hits: Vec<(u8, &Entry)> = self
            .entries
            .iter()
            .filter(|e| hidden || !e.name.starts_with('.'))
            .filter_map(|e| Some((rank(&e.name, filter)?, e)))
            .collect();
        hits.sort_by_key(|(rank, _)| *rank);
        hits.into_iter().map(|(_, e)| e).collect()
    }

    /// Quantas pastas a listada mostra sem filtro; o diálogo se dimensiona por isso.
    pub fn total(&self) -> usize {
        self.entries
            .iter()
            .filter(|e| !e.name.starts_with('.'))
            .count()
    }

    pub fn current(&self) -> Option<&Entry> {
        self.visible().get(self.selected).copied()
    }

    // ---- Eventos ----

    pub fn on_key(&mut self, key: KeyEvent) -> Outcome {
        match key.code {
            KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.query.push(c);
                self.refresh();
            }
            KeyCode::Backspace if self.query.is_empty() => self.up(),
            KeyCode::Backspace => {
                self.query.pop();
                self.refresh();
            }
            KeyCode::Up => self.selected = self.selected.saturating_sub(1),
            KeyCode::Down => {
                self.selected = (self.selected + 1).min(self.visible().len().saturating_sub(1));
            }
            KeyCode::Right | KeyCode::Tab => self.enter(),
            KeyCode::Left => self.up(),
            KeyCode::Enter => return self.confirm(),
            _ => {}
        }
        Outcome::Stay
    }

    /// Um caminho colado substitui o filtro; qualquer outro texto entra nele.
    pub fn paste(&mut self, text: &str) {
        let text = text.trim();
        if text.starts_with(['/', '~']) {
            // Sem a barra do fim, a pasta colada fica selecionada em vez de aberta
            let path = text.trim_end_matches('/');
            self.query = if path.is_empty() { "/" } else { path }.to_owned();
        } else {
            self.query.push_str(text);
        }
        self.refresh();
    }

    fn confirm(&mut self) -> Outcome {
        match self.current() {
            Some(entry) if entry.added => Outcome::Stay,
            Some(entry) if entry.repo => {
                Outcome::Add(self.listed.join(&entry.name).display().to_string())
            }
            Some(_) => {
                self.enter();
                Outcome::Stay
            }
            // Caminho digitado que a lista não alcança: o daemon decide se serve
            None if self.is_path() => Outcome::Add(self.expand(&self.query).display().to_string()),
            None => Outcome::Stay,
        }
    }

    fn enter(&mut self) {
        if let Some(name) = self.current().map(|e| e.name.clone()) {
            self.go(self.listed.join(name), None);
        }
    }

    fn up(&mut self) {
        let from = self
            .listed
            .file_name()
            .map(|n| n.to_string_lossy().into_owned());
        if let Some(parent) = self.listed.parent().map(Path::to_path_buf) {
            self.go(parent, from.as_deref());
        }
    }

    /// Passa a listar `dir`, sem filtro, com `select` (ou a primeira pasta) selecionada.
    fn go(&mut self, dir: PathBuf, select: Option<&str>) {
        self.query.clear();
        self.load(dir);
        self.selected = select
            .and_then(|name| self.visible().iter().position(|e| e.name == name))
            .unwrap_or(0);
    }

    fn load(&mut self, dir: PathBuf) {
        match read(&dir, &self.added) {
            Ok(entries) => {
                self.entries = entries;
                self.error = None;
            }
            Err(reason) => {
                self.entries = Vec::new();
                self.error = Some(reason);
            }
        }
        self.listed = dir;
    }

    /// Depois de mexer no filtro: um caminho digitado pode apontar para outra pasta.
    fn refresh(&mut self) {
        if self.is_path() {
            let head = self
                .query
                .rfind('/')
                .map_or(self.query.as_str(), |i| &self.query[..=i]);
            let dir = self.expand(head);
            if dir != self.listed {
                self.load(dir);
            }
        }
        self.selected = 0;
    }

    fn is_path(&self) -> bool {
        self.query.starts_with(['/', '~'])
    }

    /// Parte do texto que filtra a lista: num caminho, o último segmento.
    fn filter(&self) -> &str {
        if !self.is_path() {
            return &self.query;
        }
        self.query.rfind('/').map_or("", |i| &self.query[i + 1..])
    }

    /// `~` no começo do caminho vira o HOME.
    fn expand(&self, path: &str) -> PathBuf {
        match (path.strip_prefix('~'), &self.home) {
            (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => {
                home.join(rest.trim_start_matches('/'))
            }
            _ => PathBuf::from(path),
        }
    }
}

#[cfg(test)]
#[path = "picker_tests.rs"]
mod tests;
