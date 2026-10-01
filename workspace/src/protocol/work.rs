//! Mensagens de trabalho. Evoluem com `PROTOCOL_VERSION`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientMsg {
    Ping,
    /// Evento de hook de agente (`lisa-workspace hook`).
    HookEvent {
        pane: String,
        event: String,
        payload: String,
    },
    /// A UI se apresenta: tamanho do painel do agente e ambiente do terminal dela.
    Attach {
        cols: u16,
        rows: u16,
        env: Vec<(String, String)>,
    },
    /// Worktree selecionado e se a janela do terminal tem foco (R15).
    Focus {
        worktree: Option<String>,
        window_focused: bool,
    },
    Input {
        pane: String,
        bytes: Vec<u8>,
    },
    /// Novo tamanho do painel do agente.
    Resize {
        cols: u16,
        rows: u16,
    },
    AddProject {
        path: String,
    },
    SetBaseBranch {
        project: String,
        base: String,
    },
    CreateWorktree {
        project: String,
        name: String,
        agent: String,
        permission: PermissionWire,
        /// Id do catálogo; `None` deixa o padrão da CLI.
        model: Option<String>,
        effort: Option<String>,
        /// Tarefa inicial, entregue só neste lançamento.
        prompt: Option<String>,
    },
    RemoveWorktree {
        id: String,
        force: bool,
    },
    StopAgent {
        id: String,
    },
    RestartAgent {
        id: String,
    },
    /// Cria um grupo com os repositórios dos caminhos (tudo ou nada).
    AddGroup {
        name: String,
        paths: Vec<String>,
    },
    /// Desfaz o grupo; os repositórios viram projetos soltos.
    DissolveGroup {
        group: String,
    },
    /// Novo nome: apelido do projeto, nome do grupo, ou nome e branch do worktree.
    Rename {
        target: RenameTarget,
        name: String,
    },
}

/// O que um `Rename` renomeia, pelo slug ou id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum RenameTarget {
    Project(String),
    Group(String),
    Worktree(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DaemonMsg {
    Pong,
    /// Outra UI se conectou; esta deve sair.
    AttachedElsewhere,
    Error(String),
    State(WorkspaceState),
    Snapshot {
        pane: String,
        snapshot: Snapshot,
    },
    Diff {
        pane: String,
        diff: SnapshotDiff,
    },
    /// Aviso que não impede a operação (ex.: fetch offline, resume que falhou).
    Notice(String),
    RemovalRefused {
        id: String,
        reason: String,
    },
    /// Agente entrou em "precisa de você" ou "terminou" sem o usuário olhar: a UI
    /// repassa ao terminal hospedeiro (OSC 777/9 e BEL).
    Alert {
        pane: String,
        title: String,
        body: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionWire {
    Normal,
    FullAutonomy,
}

/// Os quatro estados do indicador (R10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentState {
    Working,
    NeedsYou,
    Done,
    Idle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectView {
    pub slug: String,
    pub name: String,
    pub path: String,
    pub base_branch: String,
    /// Slug do grupo; `None` em projeto solto.
    pub group: Option<String>,
    /// Marca do repositório dentro do grupo; vazia em projeto solto.
    pub tag: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupView {
    pub slug: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeView {
    pub id: String,
    pub project: String,
    pub name: String,
    pub branch: String,
    pub agent: Option<String>,
    pub autonomy: bool,
    pub state: AgentState,
    pub running: bool,
    pub exit_code: Option<u32>,
    pub broken: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentOption {
    pub name: String,
    pub available: bool,
    pub autonomy_supported: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceState {
    pub projects: Vec<ProjectView>,
    pub worktrees: Vec<WorktreeView>,
    pub agents: Vec<AgentOption>,
    pub groups: Vec<GroupView>,
}

// ---- Tela ----

pub const ATTR_BOLD: u16 = 1;
pub const ATTR_ITALIC: u16 = 1 << 1;
pub const ATTR_UNDERLINE: u16 = 1 << 2;
pub const ATTR_INVERSE: u16 = 1 << 3;
pub const ATTR_DIM: u16 = 1 << 4;
pub const ATTR_STRIKE: u16 = 1 << 5;
pub const ATTR_WIDE: u16 = 1 << 6;
pub const ATTR_WIDE_SPACER: u16 = 1 << 7;
pub const ATTR_HIDDEN: u16 = 1 << 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Color {
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cell {
    pub ch: char,
    pub fg: Color,
    pub bg: Color,
    pub attrs: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Line {
    pub cells: Vec<Cell>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorPos {
    pub row: u16,
    pub col: u16,
    pub visible: bool,
}

/// Modos do painel que mudam como a UI codifica input.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Modes {
    pub app_cursor: bool,
    pub bracketed_paste: bool,
    pub mouse_report: bool,
    pub sgr_mouse: bool,
    pub focus_events: bool,
    pub alt_screen: bool,
    /// Flags do protocolo de teclado Kitty ativas (bits 0..=4).
    pub kitty_flags: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub cols: u16,
    pub rows: u16,
    pub lines: Vec<Line>,
    pub cursor: CursorPos,
    pub title: String,
    pub modes: Modes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotDiff {
    pub lines: Vec<(u16, Line)>,
    pub cursor: CursorPos,
    pub title: String,
    pub modes: Modes,
}

impl Snapshot {
    /// Linhas que mudaram desde `prev`; `None` quando o tamanho mudou (mandar snapshot inteiro).
    pub fn diff(&self, prev: &Snapshot) -> Option<SnapshotDiff> {
        if (self.cols, self.rows) != (prev.cols, prev.rows) || self.lines.len() != prev.lines.len()
        {
            return None;
        }
        let lines = self
            .lines
            .iter()
            .zip(&prev.lines)
            .enumerate()
            .filter(|(_, (now, before))| now != before)
            .filter_map(|(i, (now, _))| u16::try_from(i).ok().map(|i| (i, now.clone())))
            .collect();
        Some(SnapshotDiff {
            lines,
            cursor: self.cursor,
            title: self.title.clone(),
            modes: self.modes,
        })
    }

    pub fn apply(&mut self, diff: &SnapshotDiff) {
        for (i, line) in &diff.lines {
            if let Some(slot) = self.lines.get_mut(usize::from(*i)) {
                slot.clone_from(line);
            }
        }
        self.cursor = diff.cursor;
        self.title.clone_from(&diff.title);
        self.modes = diff.modes;
    }
}
