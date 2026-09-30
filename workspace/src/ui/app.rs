//! Estado e lógica da UI, sem terminal: teclas e mensagens do daemon viram ações.

use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use super::input::{encode_key, encode_paste};
use crate::protocol::work::{
    AgentState, ClientMsg, Color, CursorPos, DaemonMsg, Line, Modes, PermissionWire, Snapshot,
    WorkspaceState, WorktreeView,
};

/// Largura da lateral completa, sem o separador.
pub const SIDEBAR_WIDTH: u16 = 28;
/// Largura do trilho de glifos em terminais estreitos, sem o separador.
pub const RAIL_WIDTH: u16 = 3;
/// Abaixo desta largura a lateral vira trilho.
pub const WIDE_MIN: u16 = 100;
/// Tamanho mínimo utilizável.
pub const MIN_COLS: u16 = 60;
pub const MIN_ROWS: u16 = 12;
/// Quanto tempo um aviso fica no rodapé.
const NOTICE_TTL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    Pane,
    Sidebar,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Send(ClientMsg),
    /// Toca o sino do terminal hospedeiro (atenção sem duplicar a notificação do sistema).
    Bell,
    Quit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Row {
    Project {
        slug: String,
    },
    Worktree {
        id: String,
    },
    /// Projeto sem worktrees.
    Empty {
        project: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Name,
    Agent,
    Permission,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewWorktree {
    pub project: String,
    pub name: String,
    pub agent: usize,
    pub autonomy: bool,
    pub field: Field,
    pub pending: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dialog {
    NewWorktree(NewWorktree),
    AddProject {
        path: String,
    },
    BaseBranch {
        project: String,
        value: String,
    },
    ConfirmRemove {
        id: String,
        sent: bool,
        refused: Option<String>,
    },
    Help,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeKind {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone)]
pub struct Notice {
    pub kind: NoticeKind,
    pub text: String,
    at: Instant,
}

#[derive(Debug)]
pub struct App {
    cols: u16,
    rows: u16,
    workspace: WorkspaceState,
    collapsed: Vec<String>,
    selected: usize,
    zone: Zone,
    focused: Option<String>,
    screen: Option<Snapshot>,
    dialog: Option<Dialog>,
    notice: Option<Notice>,
    window_focused: bool,
    exit_message: Option<String>,
}

/// `~` no começo do caminho vira o HOME.
fn expand_home(path: &str) -> String {
    match (path.strip_prefix('~'), std::env::var("HOME")) {
        (Some(rest), Ok(home)) if rest.is_empty() || rest.starts_with('/') => {
            format!("{home}{rest}")
        }
        _ => path.to_owned(),
    }
}

impl App {
    pub fn new(cols: u16, rows: u16) -> Self {
        App {
            cols,
            rows,
            workspace: WorkspaceState::default(),
            collapsed: Vec::new(),
            selected: 0,
            zone: Zone::Sidebar,
            focused: None,
            screen: None,
            dialog: None,
            notice: None,
            window_focused: false,
            exit_message: None,
        }
    }

    // ---- Leitura (render) ----

    pub fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    pub fn wide(&self) -> bool {
        self.cols >= WIDE_MIN
    }

    /// Tamanho do painel do agente.
    pub fn pane_size(&self) -> (u16, u16) {
        let side = if self.wide() {
            SIDEBAR_WIDTH
        } else {
            RAIL_WIDTH
        } + 1;
        (
            self.cols.saturating_sub(side).max(1),
            self.rows.saturating_sub(1).max(1),
        )
    }

    pub fn workspace(&self) -> &WorkspaceState {
        &self.workspace
    }

    pub fn zone(&self) -> Zone {
        self.zone
    }

    pub fn focused(&self) -> Option<&str> {
        self.focused.as_deref()
    }

    pub fn focused_view(&self) -> Option<&WorktreeView> {
        let id = self.focused.as_deref()?;
        self.workspace.worktrees.iter().find(|w| w.id == id)
    }

    pub fn screen(&self) -> Option<&Snapshot> {
        self.screen.as_ref()
    }

    pub fn dialog(&self) -> Option<&Dialog> {
        self.dialog.as_ref()
    }

    pub fn notice(&self) -> Option<&Notice> {
        self.notice.as_ref().filter(|n| n.at.elapsed() < NOTICE_TTL)
    }

    pub fn exit_message(&self) -> Option<&str> {
        self.exit_message.as_deref()
    }

    pub fn is_collapsed(&self, slug: &str) -> bool {
        self.collapsed.iter().any(|c| c == slug)
    }

    pub fn rows(&self) -> Vec<Row> {
        let mut rows = Vec::new();
        for p in &self.workspace.projects {
            rows.push(Row::Project {
                slug: p.slug.clone(),
            });
            if self.is_collapsed(&p.slug) {
                continue;
            }
            let mut any = false;
            for w in self
                .workspace
                .worktrees
                .iter()
                .filter(|w| w.project == p.slug)
            {
                rows.push(Row::Worktree { id: w.id.clone() });
                any = true;
            }
            if !any {
                rows.push(Row::Empty {
                    project: p.slug.clone(),
                });
            }
        }
        rows
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    pub fn selected_row(&self) -> Option<Row> {
        self.rows().get(self.selected).cloned()
    }

    pub fn select_row(&mut self, index: usize) {
        let len = self.rows().len();
        self.selected = index.min(len.saturating_sub(1));
    }

    pub fn worktree(&self, id: &str) -> Option<&WorktreeView> {
        self.workspace.worktrees.iter().find(|w| w.id == id)
    }

    /// Projeto da linha selecionada.
    fn selected_project(&self) -> Option<String> {
        match self.selected_row()? {
            Row::Project { slug } => Some(slug),
            Row::Empty { project } => Some(project),
            Row::Worktree { id } => self.worktree(&id).map(|w| w.project.clone()),
        }
    }

    fn selected_worktree(&self) -> Option<WorktreeView> {
        match self.selected_row()? {
            Row::Worktree { id } => self.worktree(&id).cloned(),
            _ => None,
        }
    }

    fn modes(&self) -> Modes {
        self.screen.as_ref().map(|s| s.modes).unwrap_or_default()
    }

    fn set_notice(&mut self, kind: NoticeKind, text: impl Into<String>) {
        self.notice = Some(Notice {
            kind,
            text: text.into(),
            at: Instant::now(),
        });
    }

    fn focus_msg(&self) -> Action {
        Action::Send(ClientMsg::Focus {
            worktree: self.focused.clone(),
            window_focused: self.window_focused,
        })
    }

    // ---- Eventos ----

    pub fn attach_msg(&self, env: Vec<(String, String)>) -> ClientMsg {
        let (cols, rows) = self.pane_size();
        ClientMsg::Attach { cols, rows, env }
    }

    pub fn on_resize(&mut self, cols: u16, rows: u16) -> Vec<Action> {
        self.cols = cols;
        self.rows = rows;
        let (cols, rows) = self.pane_size();
        vec![Action::Send(ClientMsg::Resize { cols, rows })]
    }

    pub fn on_focus(&mut self, focused: bool) -> Vec<Action> {
        if self.window_focused == focused {
            return Vec::new();
        }
        self.window_focused = focused;
        vec![self.focus_msg()]
    }

    pub fn on_paste(&mut self, text: &str) -> Vec<Action> {
        if let Some(dialog) = self.dialog.as_mut() {
            if let Some(buf) = dialog_text(dialog) {
                buf.push_str(text.trim_end_matches(['\r', '\n']));
            }
            return Vec::new();
        }
        match (self.zone, self.focused.clone()) {
            (Zone::Pane, Some(pane)) => {
                vec![Action::Send(ClientMsg::Input {
                    pane,
                    bytes: encode_paste(text, &self.modes()),
                })]
            }
            _ => Vec::new(),
        }
    }

    pub fn on_daemon(&mut self, msg: DaemonMsg) -> Vec<Action> {
        match msg {
            DaemonMsg::Pong => Vec::new(),
            DaemonMsg::State(state) => self.on_state(state),
            DaemonMsg::Snapshot { pane, snapshot } => {
                if self.focused.as_deref() == Some(pane.as_str()) {
                    self.screen = Some(snapshot);
                }
                Vec::new()
            }
            DaemonMsg::Diff { pane, diff } => {
                if self.focused.as_deref() == Some(pane.as_str())
                    && let Some(screen) = self.screen.as_mut()
                {
                    screen.apply(&diff);
                }
                Vec::new()
            }
            DaemonMsg::Notice(text) => {
                self.set_notice(NoticeKind::Warn, text);
                Vec::new()
            }
            DaemonMsg::Error(text) => {
                if let Some(Dialog::NewWorktree(d)) = self.dialog.as_mut()
                    && d.pending
                {
                    d.pending = false;
                    d.error = Some(text);
                } else {
                    self.set_notice(NoticeKind::Error, text);
                }
                Vec::new()
            }
            DaemonMsg::RemovalRefused { id, reason } => {
                match self.dialog.as_mut() {
                    Some(Dialog::ConfirmRemove {
                        id: open, refused, ..
                    }) if *open == id => *refused = Some(reason),
                    _ => self.set_notice(NoticeKind::Error, format!("remove refused: {reason}")),
                }
                Vec::new()
            }
            DaemonMsg::Alert { body, .. } => {
                self.set_notice(NoticeKind::Info, body);
                vec![Action::Bell]
            }
            DaemonMsg::AttachedElsewhere => {
                self.exit_message = Some(
                    "Lisa Workspace was opened in another terminal; this one detached.".into(),
                );
                vec![Action::Quit]
            }
        }
    }

    fn on_state(&mut self, state: WorkspaceState) -> Vec<Action> {
        let selected_before = self.selected_row();
        self.workspace = state;
        let mut actions = Vec::new();

        // Worktree recém-criado: fecha o diálogo e abre no painel
        let created = match &self.dialog {
            Some(Dialog::NewWorktree(d)) if d.pending => self
                .workspace
                .worktrees
                .iter()
                .find(|w| w.project == d.project && w.name == d.name.trim())
                .map(|w| w.id.clone()),
            _ => None,
        };
        if let Some(id) = created {
            self.dialog = None;
            actions.extend(self.open(&id));
            return actions;
        }
        if let Some(Dialog::ConfirmRemove { id, sent: true, .. }) = &self.dialog
            && self.worktree(id).is_none()
        {
            self.dialog = None;
        }
        if let Some(id) = self.focused.clone()
            && self.worktree(&id).is_none()
        {
            self.focused = None;
            self.screen = None;
            self.zone = Zone::Sidebar;
        }
        // Mantém a mesma linha selecionada quando ela ainda existe
        let rows = self.rows();
        self.selected = selected_before
            .and_then(|r| rows.iter().position(|x| *x == r))
            .unwrap_or_else(|| self.selected.min(rows.len().saturating_sub(1)));
        actions
    }

    /// Abre o worktree no painel e informa o foco ao daemon.
    fn open(&mut self, id: &str) -> Vec<Action> {
        if self.focused.as_deref() != Some(id) {
            self.screen = None;
        }
        self.focused = Some(id.to_owned());
        self.zone = Zone::Pane;
        if let Some(i) = self
            .rows()
            .iter()
            .position(|r| matches!(r, Row::Worktree { id: w } if w == id))
        {
            self.selected = i;
        }
        vec![self.focus_msg()]
    }

    pub fn on_key(&mut self, key: KeyEvent) -> Vec<Action> {
        let mut actions = Vec::new();
        if !self.window_focused {
            self.window_focused = true;
            actions.push(self.focus_msg());
        }
        if self.dialog.is_some() {
            actions.extend(self.on_dialog_key(key));
            return actions;
        }
        let prefix =
            key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('a');
        match self.zone {
            Zone::Pane if prefix => self.zone = Zone::Sidebar,
            Zone::Pane => {
                if let Some(pane) = self.focused.clone() {
                    let bytes = encode_key(key, &self.modes());
                    if !bytes.is_empty() {
                        actions.push(Action::Send(ClientMsg::Input { pane, bytes }));
                    }
                }
            }
            Zone::Sidebar if prefix => {
                if let Some(pane) = self.focused.clone() {
                    self.zone = Zone::Pane;
                    actions.push(Action::Send(ClientMsg::Input {
                        pane,
                        bytes: vec![1],
                    }));
                }
            }
            Zone::Sidebar => actions.extend(self.on_sidebar_key(key)),
        }
        actions
    }

    fn on_sidebar_key(&mut self, key: KeyEvent) -> Vec<Action> {
        let len = self.rows().len();
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.selected = self.selected.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') => {
                self.selected = (self.selected + 1).min(len.saturating_sub(1));
            }
            KeyCode::Tab => self.jump_to_attention(),
            KeyCode::Esc => {
                if self.focused.is_some() {
                    self.zone = Zone::Pane;
                }
            }
            KeyCode::Enter => match self.selected_row() {
                Some(Row::Worktree { id }) => return self.open(&id),
                Some(Row::Project { slug }) => {
                    if self.is_collapsed(&slug) {
                        self.collapsed.retain(|c| *c != slug);
                    } else {
                        self.collapsed.push(slug);
                    }
                }
                _ => {}
            },
            KeyCode::Char('n') => match self.selected_project() {
                Some(project) => self.open_new_worktree(project),
                None => self.set_notice(NoticeKind::Info, "add a project first (p)"),
            },
            KeyCode::Char('p') => {
                self.dialog = Some(Dialog::AddProject {
                    path: String::new(),
                })
            }
            KeyCode::Char('b') => {
                if let Some(project) = self.selected_project() {
                    let value = self
                        .workspace
                        .projects
                        .iter()
                        .find(|p| p.slug == project)
                        .map(|p| p.base_branch.clone())
                        .unwrap_or_default();
                    self.dialog = Some(Dialog::BaseBranch { project, value });
                }
            }
            KeyCode::Char('d') => {
                if let Some(w) = self.selected_worktree() {
                    self.dialog = Some(Dialog::ConfirmRemove {
                        id: w.id,
                        sent: false,
                        refused: None,
                    });
                }
            }
            KeyCode::Char('r') => {
                if let Some(w) = self.selected_worktree() {
                    if w.running {
                        self.set_notice(NoticeKind::Info, "the agent is running; s stops it");
                    } else if !w.broken {
                        return vec![Action::Send(ClientMsg::RestartAgent { id: w.id })];
                    }
                }
            }
            KeyCode::Char('s') => {
                if let Some(w) = self.selected_worktree().filter(|w| w.running) {
                    return vec![Action::Send(ClientMsg::StopAgent { id: w.id })];
                }
            }
            KeyCode::Char('?') => self.dialog = Some(Dialog::Help),
            KeyCode::Char('q') => return vec![Action::Quit],
            _ => {}
        }
        Vec::new()
    }

    /// Próximo worktree em "precisa de você" ou "terminou", circular.
    fn jump_to_attention(&mut self) {
        let rows = self.rows();
        let n = rows.len();
        for step in 1..=n {
            let i = (self.selected + step) % n;
            if let Row::Worktree { id } = &rows[i]
                && self
                    .worktree(id)
                    .is_some_and(|w| matches!(w.state, AgentState::NeedsYou | AgentState::Done))
            {
                self.selected = i;
                return;
            }
        }
    }

    fn open_new_worktree(&mut self, project: String) {
        let agent = self
            .workspace
            .agents
            .iter()
            .position(|a| a.available)
            .unwrap_or(0);
        self.dialog = Some(Dialog::NewWorktree(NewWorktree {
            project,
            name: String::new(),
            agent,
            autonomy: false,
            field: Field::Name,
            pending: false,
            error: None,
        }));
    }

    fn on_dialog_key(&mut self, key: KeyEvent) -> Vec<Action> {
        let agents = self.workspace.agents.clone();
        let Some(dialog) = self.dialog.as_mut() else {
            return Vec::new();
        };
        if key.code == KeyCode::Esc {
            let busy = matches!(dialog, Dialog::NewWorktree(d) if d.pending);
            if !busy {
                self.dialog = None;
            }
            return Vec::new();
        }
        match dialog {
            Dialog::Help => {
                self.dialog = None;
                Vec::new()
            }
            Dialog::AddProject { path } => {
                if edit_text(path, key) {
                    return Vec::new();
                }
                if key.code == KeyCode::Enter && !path.trim().is_empty() {
                    let path = expand_home(path.trim());
                    self.dialog = None;
                    return vec![Action::Send(ClientMsg::AddProject { path })];
                }
                Vec::new()
            }
            Dialog::BaseBranch { project, value } => {
                if edit_text(value, key) {
                    return Vec::new();
                }
                if key.code == KeyCode::Enter && !value.trim().is_empty() {
                    let msg = ClientMsg::SetBaseBranch {
                        project: project.clone(),
                        base: value.trim().to_owned(),
                    };
                    self.dialog = None;
                    return vec![Action::Send(msg)];
                }
                Vec::new()
            }
            Dialog::ConfirmRemove { id, sent, refused } => match key.code {
                KeyCode::Char('y') if !*sent => {
                    *sent = true;
                    vec![Action::Send(ClientMsg::RemoveWorktree {
                        id: id.clone(),
                        force: false,
                    })]
                }
                KeyCode::Char('f') if refused.is_some() => {
                    *refused = None;
                    vec![Action::Send(ClientMsg::RemoveWorktree {
                        id: id.clone(),
                        force: true,
                    })]
                }
                KeyCode::Char('n') => {
                    self.dialog = None;
                    Vec::new()
                }
                _ => Vec::new(),
            },
            Dialog::NewWorktree(d) => {
                if d.pending {
                    return Vec::new();
                }
                match (d.field, key.code) {
                    (_, KeyCode::Tab) => {
                        d.field = match d.field {
                            Field::Name => Field::Agent,
                            Field::Agent => Field::Permission,
                            Field::Permission => Field::Name,
                        };
                    }
                    (_, KeyCode::BackTab) => {
                        d.field = match d.field {
                            Field::Name => Field::Permission,
                            Field::Agent => Field::Name,
                            Field::Permission => Field::Agent,
                        };
                    }
                    (Field::Name, _) if edit_text(&mut d.name, key) => {}
                    (Field::Agent, KeyCode::Down | KeyCode::Char('j')) => {
                        if let Some(next) =
                            (d.agent + 1..agents.len()).find(|i| agents[*i].available)
                        {
                            d.agent = next;
                        }
                        fix_autonomy(d, &agents);
                    }
                    (Field::Agent, KeyCode::Up | KeyCode::Char('k')) => {
                        if let Some(prev) = (0..d.agent).rev().find(|i| agents[*i].available) {
                            d.agent = prev;
                        }
                        fix_autonomy(d, &agents);
                    }
                    (Field::Permission, KeyCode::Char(' ') | KeyCode::Left | KeyCode::Right) => {
                        let supported = agents.get(d.agent).is_some_and(|a| a.autonomy_supported);
                        d.autonomy = supported && !d.autonomy;
                    }
                    (_, KeyCode::Enter) => {
                        let Some(agent) = agents.get(d.agent).filter(|a| a.available) else {
                            d.error = Some("no installed agent to run".into());
                            return Vec::new();
                        };
                        if d.name.trim().is_empty() {
                            d.error = Some("give the worktree a name".into());
                            d.field = Field::Name;
                            return Vec::new();
                        }
                        d.pending = true;
                        d.error = None;
                        return vec![Action::Send(ClientMsg::CreateWorktree {
                            project: d.project.clone(),
                            name: d.name.trim().to_owned(),
                            agent: agent.name.clone(),
                            permission: if d.autonomy {
                                PermissionWire::FullAutonomy
                            } else {
                                PermissionWire::Normal
                            },
                        })];
                    }
                    _ => {}
                }
                Vec::new()
            }
        }
    }
}

fn fix_autonomy(d: &mut NewWorktree, agents: &[crate::protocol::work::AgentOption]) {
    if !agents.get(d.agent).is_some_and(|a| a.autonomy_supported) {
        d.autonomy = false;
    }
}

/// Campo de texto do diálogo, se houver.
fn dialog_text(dialog: &mut Dialog) -> Option<&mut String> {
    match dialog {
        Dialog::AddProject { path } => Some(path),
        Dialog::BaseBranch { value, .. } => Some(value),
        Dialog::NewWorktree(d) if d.field == Field::Name && !d.pending => Some(&mut d.name),
        _ => None,
    }
}

/// Edição simples de texto; `true` quando a tecla foi consumida.
fn edit_text(buf: &mut String, key: KeyEvent) -> bool {
    match key.code {
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            buf.push(c);
            true
        }
        KeyCode::Backspace => {
            buf.pop();
            true
        }
        _ => false,
    }
}

/// Uma linha em branco do tamanho dado, usada quando ainda não há tela.
pub fn blank_screen(cols: u16, rows: u16) -> Snapshot {
    let cell = crate::protocol::work::Cell {
        ch: ' ',
        fg: Color::Default,
        bg: Color::Default,
        attrs: 0,
    };
    Snapshot {
        cols,
        rows,
        lines: (0..rows)
            .map(|_| Line {
                cells: vec![cell; usize::from(cols)],
            })
            .collect(),
        cursor: CursorPos {
            row: 0,
            col: 0,
            visible: false,
        },
        title: String::new(),
        modes: Modes::default(),
    }
}

#[cfg(test)]
#[path = "app_tests.rs"]
mod tests;
