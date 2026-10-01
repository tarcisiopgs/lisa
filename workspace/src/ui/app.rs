//! Estado e lógica da UI, sem terminal: teclas e mensagens do daemon viram ações.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use super::input::{encode_key, encode_paste};
use super::picker::{Outcome, Picker};
use crate::agents::{self, AgentId, Effort, MAX_PROMPT_BYTES};
use crate::protocol::work::AgentOption;
use crate::protocol::work::{
    AgentState, ClientMsg, Color, CursorPos, DaemonMsg, Line, Modes, PermissionWire, Snapshot,
    WorkspaceState, WorktreeView,
};
use crate::router::{self, Answers, RouteError, RouterConfig, Size};

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
    /// Consulta o roteador sobre a tarefa; a resposta volta por `App::on_route` com o mesmo id.
    Route {
        id: u64,
        task: String,
    },
    /// Toca o sino do terminal hospedeiro (atenção sem duplicar a notificação do sistema).
    Bell,
    /// Guarda a permissão escolhida como padrão para os próximos worktrees (R9).
    RememberAutonomy(bool),
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
    Task,
    Agent,
    Model,
    Effort,
    Permission,
}

/// Situação da sugestão do roteador para a tarefa digitada.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Idle,
    Pending {
        id: u64,
    },
    /// O agente vai pelo nome: a lista do daemon pode mudar de ordem.
    Suggested {
        agent: String,
        percent: u8,
        unsure: bool,
    },
    Failed(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewWorktree {
    pub project: String,
    pub name: String,
    /// Tarefa inicial; em branco, o agente sobe vazio como antes.
    pub task: String,
    pub agent: usize,
    /// Índice em `model_options` do agente; 0 é `default`, sem argumento de modelo.
    pub model: usize,
    pub effort: Option<Effort>,
    pub autonomy: bool,
    pub field: Field,
    pub pending: bool,
    pub error: Option<String>,
    pub route: Route,
    /// Tamanho e reforço de effort da última sugestão, para acompanhar a troca de agente.
    pub sized: Option<(Size, bool)>,
    /// Último texto enviado ao roteador.
    routed_task: Option<String>,
    touched_agent: bool,
    touched_model: bool,
}

/// Modelos que o diálogo oferece para um agente: `default` e os do catálogo conferido.
/// Vazio quando o agente não tem catálogo conferido.
pub fn model_options(agent: &str) -> Vec<&'static str> {
    let Some(catalog) = verified_catalog(agent) else {
        return Vec::new();
    };
    std::iter::once("default")
        .chain(catalog.models.iter().map(|m| m.id))
        .collect()
}

/// A tarefa é entregue a este agente no lançamento?
pub fn task_delivered(agent: &str) -> bool {
    verified_catalog(agent).is_some_and(|c| c.prompt.is_some())
}

/// Níveis de effort do modelo `index` do agente; vazio para `default` e modelos sem effort.
pub fn effort_options(agent: &str, index: usize) -> &'static [Effort] {
    selected_model(agent, index).map_or(&[], |m| m.efforts)
}

/// Aviso de custo do modelo `index`, quando o fornecedor documenta um.
pub fn cost_note(agent: &str, index: usize) -> Option<&'static str> {
    selected_model(agent, index)?.cost_note
}

fn verified_catalog(agent: &str) -> Option<&'static agents::ModelCatalog> {
    agents::catalog(AgentId::from_name(agent)?).filter(|c| c.verified)
}

fn selected_model(agent: &str, index: usize) -> Option<&'static agents::ModelSpec> {
    verified_catalog(agent)?.models.get(index.checked_sub(1)?)
}

/// Campos por onde o Tab passa, na ordem, para o agente e o modelo selecionados.
fn fields(d: &NewWorktree, agents: &[AgentOption]) -> Vec<Field> {
    let agent = agents.get(d.agent).map_or("", |a| a.name.as_str());
    let mut order = vec![Field::Name, Field::Task, Field::Agent];
    if !model_options(agent).is_empty() {
        order.push(Field::Model);
        if !effort_options(agent, d.model).is_empty() {
            order.push(Field::Effort);
        }
    }
    order.push(Field::Permission);
    order
}

/// Modelo e effort do agente selecionado para o tamanho sugerido; sem sugestão, `default`.
fn apply_size(d: &mut NewWorktree, agents: &[AgentOption]) {
    let agent = agents.get(d.agent).map_or("", |a| a.name.as_str());
    let chosen = d.sized.and_then(|(size, bump)| {
        let id = AgentId::from_name(agent)?;
        verified_catalog(agent)?;
        router::selection(id, size, bump)
    });
    let options = model_options(agent);
    match chosen
        .and_then(|(model, effort)| Some((options.iter().position(|m| *m == model)?, effort)))
    {
        Some((index, effort)) => {
            d.model = index;
            d.effort = effort;
        }
        None => {
            d.model = 0;
            d.effort = None;
        }
    }
    d.touched_model = false;
}

/// Vizinho de `current` em `items`, sem dar a volta.
fn step<T: Copy + PartialEq>(items: &[T], current: T, forward: bool) -> T {
    let Some(i) = items.iter().position(|x| *x == current) else {
        return items.first().copied().unwrap_or(current);
    };
    let j = if forward {
        (i + 1).min(items.len() - 1)
    } else {
        i.saturating_sub(1)
    };
    items[j]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dialog {
    NewWorktree(NewWorktree),
    AddProject(Picker),
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
    /// Permissão pré-selecionada ao criar um worktree (R9).
    default_autonomy: bool,
    router: RouterConfig,
    /// Id da última consulta ao roteador; respostas com outro id são descartadas.
    route_seq: u64,
    /// Onde o seletor de projetos abre quando não há projeto mapeado por perto.
    start_dir: PathBuf,
    home: Option<PathBuf>,
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
            default_autonomy: false,
            router: RouterConfig::default(),
            route_seq: 0,
            start_dir: PathBuf::from("/"),
            home: std::env::var_os("HOME").map(PathBuf::from),
        }
    }

    /// Diretório de onde a Lisa foi aberta e o HOME, para o seletor de projetos.
    pub fn set_dirs(&mut self, start: PathBuf, home: Option<PathBuf>) {
        self.start_dir = start;
        self.home = home;
    }

    pub fn set_default_autonomy(&mut self, autonomy: bool) {
        self.default_autonomy = autonomy;
    }

    pub fn set_router_config(&mut self, config: RouterConfig) {
        self.router = config;
    }

    /// Aviso da própria UI no rodapé (ex.: `router.toml` com algo ignorado).
    pub fn warn(&mut self, text: String) {
        self.set_notice(NoticeKind::Warn, text);
    }

    /// Resposta do roteador à consulta `id`. Só vale se o diálogo ainda espera por ela.
    pub fn on_route(&mut self, id: u64, result: Result<Answers, RouteError>) {
        let agents = self.workspace.agents.clone();
        let Some(Dialog::NewWorktree(d)) = self.dialog.as_mut() else {
            return;
        };
        if d.route != (Route::Pending { id }) {
            return;
        }
        // A tarefa mudou desde a consulta: a resposta é de outro texto, e a saída do
        // campo pede uma nova
        if d.routed_task.as_deref() != Some(d.task.trim()) {
            d.route = Route::Idle;
            d.routed_task = None;
            return;
        }
        let answers = match result {
            Ok(answers) => answers,
            Err(err) => {
                d.route = Route::Failed(err.reason());
                return;
            }
        };
        let usable: Vec<AgentId> = agents
            .iter()
            .filter(|a| a.available && verified_catalog(&a.name).is_some())
            .filter_map(|a| AgentId::from_name(&a.name))
            .collect();
        let decision = router::decide(&answers, &usable, &self.router);
        let Some(suggested) = decision.agent else {
            d.route = Route::Failed("no routable agent installed · choosing manually");
            return;
        };
        d.sized = Some((decision.size, decision.bump));
        // Quem mexeu no agente ou no modelo fica com a escolha; a sugestão vira só marca
        if !d.touched_agent
            && !d.touched_model
            && let Some(index) = agents.iter().position(|a| a.name == suggested.name())
        {
            d.agent = index;
            fix_autonomy(d, &agents);
        }
        if !d.touched_model {
            apply_size(d, &agents);
        }
        d.route = Route::Suggested {
            agent: suggested.name().to_owned(),
            percent: decision.percent,
            unsure: decision.unsure,
        };
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

    /// Mensagens para (re)conectar: o daemon esquece o foco quando a UI cai.
    pub fn attach_msgs(&self, env: Vec<(String, String)>) -> Vec<ClientMsg> {
        vec![
            self.attach_msg(env),
            ClientMsg::Focus {
                worktree: self.focused.clone(),
                window_focused: self.window_focused,
            },
        ]
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
        if let Some(Dialog::AddProject(picker)) = self.dialog.as_mut() {
            picker.paste(text);
            return Vec::new();
        }
        if let Some(dialog) = self.dialog.as_mut() {
            // Na tarefa, as quebras de linha coladas ficam, normalizadas
            let multiline = matches!(dialog, Dialog::NewWorktree(d) if d.field == Field::Task);
            if let Some(buf) = dialog_text(dialog) {
                let text = text.trim_end_matches(['\r', '\n']);
                if multiline {
                    buf.push_str(&text.replace("\r\n", "\n").replace('\r', "\n"));
                } else {
                    buf.push_str(text);
                }
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
        // O agente escolhido no diálogo vai pelo nome: a lista pode chegar em outra ordem
        let chosen_agent = match &self.dialog {
            Some(Dialog::NewWorktree(d)) => {
                self.workspace.agents.get(d.agent).map(|a| a.name.clone())
            }
            _ => None,
        };
        self.workspace = state;
        if let (Some(name), Some(Dialog::NewWorktree(d))) = (chosen_agent, self.dialog.as_mut())
            && let Some(index) = self.workspace.agents.iter().position(|a| a.name == name)
        {
            d.agent = index;
        }
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
            KeyCode::Char('p') => self.open_add_project(),
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

    /// Abre o seletor ao lado do último projeto mapeado; sem um, onde a Lisa foi aberta.
    fn open_add_project(&mut self) {
        let projects = &self.workspace.projects;
        let beside_last = projects
            .last()
            .and_then(|p| Path::new(&p.path).parent().map(Path::to_path_buf));
        let start = beside_last
            .into_iter()
            .chain([self.start_dir.clone()])
            .chain(self.home.clone())
            .find(|dir| dir.is_dir())
            .unwrap_or_else(|| PathBuf::from("/"));
        let added: Vec<PathBuf> = projects.iter().map(|p| PathBuf::from(&p.path)).collect();
        self.dialog = Some(Dialog::AddProject(Picker::open(
            &start,
            self.home.clone(),
            &added,
        )));
    }

    fn open_new_worktree(&mut self, project: String) {
        let agent = self
            .workspace
            .agents
            .iter()
            .position(|a| a.available)
            .unwrap_or(0);
        let supported = self
            .workspace
            .agents
            .get(agent)
            .is_some_and(|a| a.autonomy_supported);
        self.dialog = Some(Dialog::NewWorktree(NewWorktree {
            project,
            name: String::new(),
            task: String::new(),
            agent,
            model: 0,
            effort: None,
            autonomy: self.default_autonomy && supported,
            field: Field::Name,
            pending: false,
            error: None,
            route: Route::Idle,
            sized: None,
            routed_task: None,
            touched_agent: false,
            touched_model: false,
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
            Dialog::AddProject(picker) => match picker.on_key(key) {
                Outcome::Add(path) => {
                    self.dialog = None;
                    vec![Action::Send(ClientMsg::AddProject { path })]
                }
                Outcome::Stay => Vec::new(),
            },
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
                let agent_name = agents.get(d.agent).map_or("", |a| a.name.as_str());
                match (d.field, key.code) {
                    (_, KeyCode::Tab | KeyCode::BackTab) => {
                        let leaving_task = d.field == Field::Task;
                        let order = fields(d, &agents);
                        let here = order.iter().position(|f| *f == d.field).unwrap_or(0);
                        let next = if key.code == KeyCode::Tab {
                            (here + 1) % order.len()
                        } else {
                            (here + order.len() - 1) % order.len()
                        };
                        d.field = order[next];
                        if leaving_task {
                            return route_request(d, &mut self.route_seq).into_iter().collect();
                        }
                    }
                    (Field::Name, _) if edit_text(&mut d.name, key) => {}
                    (Field::Task, _) if edit_text(&mut d.task, key) => {}
                    (Field::Agent, KeyCode::Down | KeyCode::Char('j')) => {
                        if let Some(next) =
                            (d.agent + 1..agents.len()).find(|i| agents[*i].available)
                        {
                            d.agent = next;
                            d.touched_agent = true;
                            apply_size(d, &agents);
                        }
                        fix_autonomy(d, &agents);
                    }
                    (Field::Agent, KeyCode::Up | KeyCode::Char('k')) => {
                        if let Some(prev) = (0..d.agent).rev().find(|i| agents[*i].available) {
                            d.agent = prev;
                            d.touched_agent = true;
                            apply_size(d, &agents);
                        }
                        fix_autonomy(d, &agents);
                    }
                    (Field::Model, KeyCode::Left | KeyCode::Right) => {
                        let indices: Vec<usize> = (0..model_options(agent_name).len()).collect();
                        d.model = step(&indices, d.model, key.code == KeyCode::Right);
                        d.effort =
                            selected_model(agent_name, d.model).and_then(|m| m.default_effort);
                        d.touched_model = true;
                    }
                    (Field::Effort, KeyCode::Left | KeyCode::Right) => {
                        let levels = effort_options(agent_name, d.model);
                        if let Some(current) = d.effort.or(levels.first().copied()) {
                            d.effort = Some(step(levels, current, key.code == KeyCode::Right));
                            d.touched_model = true;
                        }
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
                        if d.task.len() > MAX_PROMPT_BYTES {
                            d.error = Some("task is too long (max 100,000 bytes)".into());
                            d.field = Field::Task;
                            return Vec::new();
                        }
                        d.pending = true;
                        d.error = None;
                        let autonomy = d.autonomy && agent.autonomy_supported;
                        let model = selected_model(&agent.name, d.model);
                        let task = d.task.trim();
                        let prompt = (!task.is_empty() && task_delivered(&agent.name))
                            .then(|| task.to_owned());
                        return vec![
                            Action::Send(ClientMsg::CreateWorktree {
                                project: d.project.clone(),
                                name: d.name.trim().to_owned(),
                                agent: agent.name.clone(),
                                permission: if autonomy {
                                    PermissionWire::FullAutonomy
                                } else {
                                    PermissionWire::Normal
                                },
                                model: model.map(|m| m.id.to_owned()),
                                effort: model.and(d.effort).map(|e| e.name().to_owned()),
                                prompt,
                            }),
                            Action::RememberAutonomy(autonomy),
                        ];
                    }
                    _ => {}
                }
                Vec::new()
            }
        }
    }
}

/// Ao sair do campo da tarefa: pede uma sugestão se o texto mudou desde a última.
fn route_request(d: &mut NewWorktree, seq: &mut u64) -> Option<Action> {
    let task = d.task.trim();
    if task.is_empty() {
        d.route = Route::Idle;
        d.sized = None;
        d.routed_task = None;
        return None;
    }
    // Tarefa grande demais é recusada ao criar; não vale a consulta
    if task.len() > MAX_PROMPT_BYTES || d.routed_task.as_deref() == Some(task) {
        return None;
    }
    *seq += 1;
    d.routed_task = Some(task.to_owned());
    d.route = Route::Pending { id: *seq };
    Some(Action::Route {
        id: *seq,
        task: task.to_owned(),
    })
}

fn fix_autonomy(d: &mut NewWorktree, agents: &[AgentOption]) {
    if !agents.get(d.agent).is_some_and(|a| a.autonomy_supported) {
        d.autonomy = false;
    }
}

/// Campo de texto do diálogo, se houver.
fn dialog_text(dialog: &mut Dialog) -> Option<&mut String> {
    match dialog {
        Dialog::BaseBranch { value, .. } => Some(value),
        Dialog::NewWorktree(d) if !d.pending => match d.field {
            Field::Name => Some(&mut d.name),
            Field::Task => Some(&mut d.task),
            _ => None,
        },
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
