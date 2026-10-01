//! O Workspace dentro do daemon: registro, sessões e o fluxo de telas para a UI.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::thread;
use std::time::{Duration, Instant};

use super::notify::{OsNotifier, SystemNotifier};
use super::{SessionHost, UiSink};
use crate::agents::{self, AgentId, Effort, LaunchOptions, Permission, SessionMode};
use crate::git::{self, RemovalBlock};
use crate::protocol::work::{
    AgentOption, AgentState, ClientMsg, DaemonMsg, GroupView, PermissionWire, ProjectView,
    RenameTarget, Snapshot, WorkspaceState, WorktreeView,
};
use crate::registry::{Registry, RegistryError, execute_plan};
use crate::session::hooks::write_claude_settings;
use crate::session::launch::{LaunchRequest, build_launch};
use crate::session::pty::Launch;
use crate::session::signals::{OscScanner, TitleKind, classify_title};
use crate::session::state::{Signal, Tracker, Transition};
use crate::session::{PaneEvent, SessionManager};

/// Linhas de scrollback por agente (meta de memória da especificação).
pub const SCROLLBACK: usize = 2_000;
/// Intervalo mínimo entre envios de tela para a UI (coalescência).
const FRAME: Duration = Duration::from_millis(25);
/// Janela em que um resume que falha cai para sessão nova.
const RESUME_WINDOW: Duration = Duration::from_secs(3);
/// Silêncio que marca "terminou" em agentes sem outros sinais (KTD12).
pub const DEFAULT_SILENCE: Duration = Duration::from_secs(20);
const NOTIFY_TITLE: &str = "Lisa";

const PERMISSION_NORMAL: &str = "normal";
const PERMISSION_FULL: &str = "full";

#[derive(Debug, Default, Clone)]
struct Focus {
    worktree: Option<String>,
    window_focused: bool,
}

struct Inner {
    registry: Mutex<Registry>,
    state_file: PathBuf,
    sessions: SessionManager,
    ui: Mutex<Option<UiSink>>,
    env: Mutex<Vec<(String, String)>>,
    size: Mutex<(u16, u16)>,
    focus: Mutex<Focus>,
    /// Última tela enviada por painel, base dos diffs.
    last_sent: Mutex<HashMap<String, Snapshot>>,
    dirty: Mutex<HashSet<String>>,
    trackers: Mutex<HashMap<String, Tracker>>,
    scanners: Mutex<HashMap<String, OscScanner>>,
    last_output: Mutex<HashMap<String, Instant>>,
    /// Último estado notificado por painel (deduplicação).
    notified: Mutex<HashMap<String, AgentState>>,
    ui_attached: AtomicBool,
    notifier: Mutex<Arc<dyn SystemNotifier>>,
    silence: Mutex<Duration>,
    /// Binário chamado pelos hooks dos agentes.
    hook_exe: Mutex<Option<PathBuf>>,
    /// Diretório de runtime do daemon, repassado aos hooks.
    runtime_dir: Mutex<Option<PathBuf>>,
    hooks_dir: PathBuf,
    /// Aviso a entregar na primeira conexão (ex.: registro corrompido).
    pending_notice: Mutex<Option<String>>,
}

pub struct Workspace {
    inner: Arc<Inner>,
}

fn hooks_dir(state_dir: &std::path::Path) -> PathBuf {
    state_dir.join("hooks")
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// UUID v4 para sessões de agentes que aceitam id definido pela Lisa.
/// Modelo, effort e tarefa escolhidos ao criar um worktree.
struct Choice {
    model: Option<String>,
    effort: Option<String>,
    prompt: Option<String>,
}

/// Modelo e effort guardados, conferidos contra o catálogo atual: o que saiu dele é
/// ignorado com aviso, para um restart nunca falhar por causa de um modelo aposentado.
fn stored_options(
    agent: AgentId,
    model: Option<&str>,
    effort: Option<&str>,
) -> (Option<String>, Option<Effort>, Option<String>) {
    let Some(name) = model else {
        return (None, None, None);
    };
    let Some(spec) = agents::model(agent, name) else {
        let notice = format!(
            "model {name} is no longer in the {} catalog; starting with the default model",
            agent.name()
        );
        return (None, None, Some(notice));
    };
    let effort = effort
        .and_then(Effort::from_name)
        .filter(|e| spec.efforts.contains(e));
    (Some(name.to_owned()), effort, None)
}

fn new_session_id() -> String {
    let mut b = [0u8; 16];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .is_err()
    {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        b = nanos.to_le_bytes();
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

impl Workspace {
    pub fn open(state_file: PathBuf, worktree_root: PathBuf) -> Result<Workspace, RegistryError> {
        let loaded = Registry::load(&state_file)?;
        let state_file_parent = state_file.parent().map(PathBuf::from).unwrap_or_default();
        let (tx, rx) = mpsc::channel();
        let inner = Arc::new(Inner {
            registry: Mutex::new(loaded.registry.with_worktree_root(worktree_root)),
            state_file,
            sessions: SessionManager::new(tx, SCROLLBACK),
            ui: Mutex::new(None),
            env: Mutex::new(Vec::new()),
            size: Mutex::new((80, 24)),
            focus: Mutex::new(Focus::default()),
            last_sent: Mutex::new(HashMap::new()),
            dirty: Mutex::new(HashSet::new()),
            trackers: Mutex::new(HashMap::new()),
            scanners: Mutex::new(HashMap::new()),
            last_output: Mutex::new(HashMap::new()),
            notified: Mutex::new(HashMap::new()),
            ui_attached: AtomicBool::new(false),
            notifier: Mutex::new(Arc::new(OsNotifier)),
            silence: Mutex::new(DEFAULT_SILENCE),
            hook_exe: Mutex::new(std::env::current_exe().ok()),
            runtime_dir: Mutex::new(None),
            hooks_dir: hooks_dir(&state_file_parent),
            pending_notice: Mutex::new(loaded.warning),
        });
        spawn_event_loop(Arc::downgrade(&inner), rx);
        spawn_render_loop(Arc::downgrade(&inner));
        spawn_silence_loop(Arc::downgrade(&inner));
        Ok(Workspace { inner })
    }

    /// Binário que os hooks dos agentes chamam (padrão: este executável).
    pub fn with_hook_exe(self, exe: PathBuf) -> Self {
        *lock(&self.inner.hook_exe) = Some(exe);
        self
    }

    /// Diretório de runtime repassado aos hooks para acharem este daemon.
    pub fn with_runtime_dir(self, dir: PathBuf) -> Self {
        *lock(&self.inner.runtime_dir) = Some(dir);
        self
    }

    pub fn with_notifier(self, notifier: Arc<dyn SystemNotifier>) -> Self {
        *lock(&self.inner.notifier) = notifier;
        self
    }

    /// Silêncio que marca "terminou" em agentes sem outros sinais.
    pub fn with_silence(self, silence: Duration) -> Self {
        *lock(&self.inner.silence) = silence;
        self
    }

    /// Estado atual como a UI o vê.
    pub fn state(&self) -> WorkspaceState {
        self.inner.state()
    }
}

impl Inner {
    fn send(&self, msg: &DaemonMsg) {
        if let Some(sink) = lock(&self.ui).as_ref() {
            sink.send(msg);
        }
    }

    fn error(&self, err: impl std::fmt::Display) {
        self.send(&DaemonMsg::Error(err.to_string()));
    }

    fn save(&self) {
        let registry = lock(&self.registry);
        if let Err(e) = registry.save(&self.state_file) {
            drop(registry);
            self.error(format!("could not save the workspace state: {e}"));
        }
    }

    fn ui_path(&self) -> Option<std::ffi::OsString> {
        lock(&self.env)
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.into())
    }

    fn state(&self) -> WorkspaceState {
        let registry = lock(&self.registry);
        let trackers = lock(&self.trackers);
        let mut tags = registry.tags();
        let projects = registry
            .projects()
            .iter()
            .map(|p| ProjectView {
                slug: p.slug.clone(),
                name: p.display_name().to_owned(),
                path: p.path.display().to_string(),
                base_branch: p.base_branch.clone(),
                group: p.group.clone(),
                tag: tags.remove(&p.slug).unwrap_or_default(),
            })
            .collect();
        let groups = registry
            .groups()
            .iter()
            .map(|g| GroupView {
                slug: g.slug.clone(),
                name: g.name.clone(),
            })
            .collect();
        let worktrees = registry
            .worktrees()
            .iter()
            .map(|w| {
                let running = self.sessions.is_running(&w.id);
                WorktreeView {
                    id: w.id.clone(),
                    project: w.project.clone(),
                    name: w.name.clone(),
                    branch: w.branch.clone(),
                    agent: w.agent.clone(),
                    autonomy: w.permission.as_deref() == Some(PERMISSION_FULL),
                    state: if running {
                        trackers
                            .get(&w.id)
                            .map_or(AgentState::Working, Tracker::state)
                    } else {
                        AgentState::Idle
                    },
                    running,
                    exit_code: self.sessions.exit_code(&w.id),
                    broken: w.broken,
                }
            })
            .collect();
        let path = self.ui_path();
        let agents = agents::creatable_agents()
            .into_iter()
            .map(|id| AgentOption {
                name: id.name().to_owned(),
                available: agents::resolve_binary(id, path.as_deref()).is_some(),
                autonomy_supported: agents::spec(id).autonomy_args.is_some(),
            })
            .collect();
        WorkspaceState {
            projects,
            worktrees,
            agents,
            groups,
        }
    }

    fn broadcast_state(&self) {
        let state = self.state();
        self.send(&DaemonMsg::State(state));
    }

    fn mark_dirty(&self, pane: &str) {
        lock(&self.dirty).insert(pane.to_owned());
    }

    fn launch_for(
        &self,
        id: &str,
        session: SessionMode,
        prompt: Option<String>,
    ) -> Result<Launch, String> {
        let registry = lock(&self.registry);
        let wt = registry
            .worktree(id)
            .ok_or_else(|| format!("unknown worktree {id}"))?;
        let agent = wt
            .agent
            .as_deref()
            .and_then(AgentId::from_name)
            .ok_or_else(|| format!("worktree {id} has no agent"))?;
        let permission = if wt.permission.as_deref() == Some(PERMISSION_FULL) {
            Permission::FullAutonomy
        } else {
            Permission::Normal
        };
        let (model, effort, stale) =
            stored_options(agent, wt.model.as_deref(), wt.effort.as_deref());
        if let Some(notice) = stale {
            self.send(&DaemonMsg::Notice(notice));
        }
        let (cols, rows) = *lock(&self.size);
        let mut env = lock(&self.env).clone();
        env.retain(|(k, _)| k != "LISA_PANE_ID" && k != "LISA_WORKSPACE_RUNTIME_DIR");
        env.push(("LISA_PANE_ID".into(), id.to_owned()));
        if let Some(dir) = lock(&self.runtime_dir).as_ref() {
            env.push((
                "LISA_WORKSPACE_RUNTIME_DIR".into(),
                dir.display().to_string(),
            ));
        }
        // Claude: hooks por sessão para estados determinísticos (KTD12)
        let mut extra_args = Vec::new();
        if agent == AgentId::Claude
            && let Some(exe) = lock(&self.hook_exe).as_ref()
        {
            match write_claude_settings(&self.hooks_dir, exe) {
                Ok(path) => {
                    extra_args.push("--settings".to_owned());
                    extra_args.push(path.display().to_string());
                }
                Err(e) => self.send(&DaemonMsg::Notice(format!("agent hooks unavailable: {e}"))),
            }
        }
        let launch = build_launch(LaunchRequest {
            agent,
            permission,
            session,
            model,
            effort,
            prompt,
            extra_args,
            cwd: &wt.path,
            env,
            cols,
            rows,
        })
        .map_err(|e| e.to_string())?;
        Ok(launch)
    }

    /// Começa a rastrear o estado de um agente recém-subido.
    fn track_spawn(&self, id: &str) {
        let hooked = lock(&self.registry)
            .worktree(id)
            .and_then(|w| w.agent.as_deref())
            .and_then(AgentId::from_name)
            == Some(AgentId::Claude);
        let mut tracker = if hooked {
            Tracker::with_hooks()
        } else {
            Tracker::new(false)
        };
        tracker.on(Signal::Spawned);
        lock(&self.trackers).insert(id.to_owned(), tracker);
        lock(&self.scanners).insert(id.to_owned(), OscScanner::default());
        lock(&self.last_output).insert(id.to_owned(), Instant::now());
        lock(&self.notified).remove(id);
    }

    /// Estado vem dos hooks do agente; BEL e OSC não mexem nele.
    fn hooked(&self, pane: &str) -> bool {
        lock(&self.trackers).get(pane).is_some_and(Tracker::hooks)
    }

    fn is_looking(&self, pane: &str) -> bool {
        let focus = lock(&self.focus);
        self.ui_attached.load(Ordering::SeqCst)
            && focus.window_focused
            && focus.worktree.as_deref() == Some(pane)
    }

    fn apply(&self, pane: &str, signal: Signal) {
        let transition = lock(&self.trackers)
            .get_mut(pane)
            .and_then(|t| t.on(signal));
        if let Some(t) = transition {
            self.on_transition(pane, t);
        }
    }

    fn on_transition(&self, pane: &str, t: Transition) {
        match t.to {
            AgentState::NeedsYou | AgentState::Done => {
                if self.is_looking(pane) {
                    if t.to == AgentState::Done {
                        self.apply(pane, Signal::Looked);
                        return;
                    }
                } else {
                    self.notify(pane, t.to);
                }
            }
            AgentState::Working | AgentState::Idle => {
                lock(&self.notified).remove(pane);
            }
        }
        self.broadcast_state();
    }

    /// Notifica (R15), sem repetir enquanto o estado não muda.
    fn notify(&self, pane: &str, state: AgentState) {
        {
            let mut notified = lock(&self.notified);
            if notified.get(pane) == Some(&state) {
                return;
            }
            notified.insert(pane.to_owned(), state);
        }
        let (name, agent) = lock(&self.registry)
            .worktree(pane)
            .map(|w| {
                (
                    w.name.clone(),
                    w.agent.clone().unwrap_or_else(|| "agent".into()),
                )
            })
            .unwrap_or_else(|| (pane.to_owned(), "agent".into()));
        let body = match state {
            AgentState::NeedsYou => format!("{name}: {agent} needs you"),
            _ => format!("{name}: {agent} finished"),
        };
        let notifier = Arc::clone(&lock(&self.notifier));
        notifier.notify(NOTIFY_TITLE, &body);
        if self.ui_attached.load(Ordering::SeqCst) {
            self.send(&DaemonMsg::Alert {
                pane: pane.to_owned(),
                title: NOTIFY_TITLE.into(),
                body,
            });
        }
    }

    fn hook_event(&self, pane: &str, event: &str, payload: &str) {
        let json: serde_json::Value = serde_json::from_str(payload).unwrap_or_default();
        match event {
            "Notification" => match json.get("notification_type").and_then(|v| v.as_str()) {
                Some("permission_prompt" | "elicitation_dialog") => {
                    self.apply(pane, Signal::NeedsYou)
                }
                Some("idle_prompt") => self.apply(pane, Signal::Done),
                _ => {}
            },
            "Stop" => self.apply(pane, Signal::Done),
            "UserPromptSubmit" => {
                self.apply(pane, Signal::UserInput);
                self.apply(pane, Signal::Output);
            }
            "SessionStart" => {
                if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                    if let Some(wt) = lock(&self.registry).worktree_mut(pane) {
                        wt.session_id = Some(sid.to_owned());
                    }
                    self.save();
                }
            }
            _ => {}
        }
    }

    /// Validações rápidas aqui; o git (fetch pode levar até 30 s) roda numa thread,
    /// sem segurar o registro, para não congelar os outros worktrees.
    fn create_worktree(
        self: &Arc<Self>,
        project: &str,
        name: &str,
        agent: &str,
        permission: PermissionWire,
        choice: Choice,
    ) {
        let Some(agent_id) = AgentId::from_name(agent) else {
            return self.error(format!("unknown agent {agent}"));
        };
        if agents::resolve_binary(agent_id, self.ui_path().as_deref()).is_none() {
            return self.error(format!("{agent} is not installed (not found in PATH)"));
        }
        let permission = match permission {
            PermissionWire::Normal => Permission::Normal,
            PermissionWire::FullAutonomy => Permission::FullAutonomy,
        };
        if permission == Permission::FullAutonomy && agents::spec(agent_id).autonomy_args.is_none()
        {
            return self.error(format!("{agent} has no full-autonomy mode"));
        }
        // Modelo, effort e tarefa conferidos antes de qualquer worktree existir
        let effort = match choice.effort.as_deref().map(Effort::from_name) {
            Some(None) => {
                return self.error(format!(
                    "unknown effort {}",
                    choice.effort.as_deref().unwrap_or_default()
                ));
            }
            Some(known) => known,
            None => None,
        };
        if let Err(e) = agents::launch_args(
            agent_id,
            permission,
            &SessionMode::New { session_id: None },
            &LaunchOptions {
                model: choice.model.as_deref(),
                effort,
                prompt: choice.prompt.as_deref(),
            },
        ) {
            return self.error(format!("{agent}: {e}"));
        }
        let git_env = git::Env(
            lock(&self.env)
                .iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
        );
        let plan = lock(&self.registry).plan_worktree(project, name);
        let plan = match plan {
            Ok(p) => p,
            Err(e) => return self.error(e),
        };
        let inner = Arc::clone(self);
        let agent = agent.to_owned();
        thread::spawn(move || match execute_plan(&plan, &git_env) {
            Ok(warning) => {
                if let Some(w) = warning {
                    inner.send(&DaemonMsg::Notice(w));
                }
                let id = lock(&inner.registry).add_planned(&plan).id;
                inner.start_new_agent(&id, agent_id, &agent, permission, choice);
            }
            Err(e) => inner.error(e),
        });
    }

    fn start_new_agent(
        &self,
        id: &str,
        agent_id: AgentId,
        agent: &str,
        permission: Permission,
        choice: Choice,
    ) {
        let id = id.to_owned();
        let session_id = agents::spec(agent_id)
            .new_session_flag
            .map(|_| new_session_id());
        if let Some(wt) = lock(&self.registry).worktree_mut(&id) {
            wt.agent = Some(agent.to_owned());
            wt.permission = Some(
                if permission == Permission::FullAutonomy {
                    PERMISSION_FULL
                } else {
                    PERMISSION_NORMAL
                }
                .to_owned(),
            );
            wt.session_id.clone_from(&session_id);
            wt.model = choice.model;
            wt.effort = choice.effort;
        }
        self.save();
        // A tarefa vale só para este lançamento: não vai para o registro
        match self.launch_for(&id, SessionMode::New { session_id }, choice.prompt) {
            Ok(launch) => {
                self.track_spawn(&id);
                if let Err(e) = self.sessions.start(&id, launch) {
                    self.error(format!("could not start {agent}: {e}"));
                }
            }
            Err(e) => self.error(e),
        }
        self.broadcast_state();
    }

    /// Checagens e remoção no git sem segurar o registro, numa thread.
    fn remove_worktree(self: &Arc<Self>, id: &str, force: bool) {
        let inner = Arc::clone(self);
        let id = id.to_owned();
        thread::spawn(move || inner.remove_worktree_now(&id, force));
    }

    fn remove_worktree_now(&self, id: &str, force: bool) {
        let refused = |block: RemovalBlock| DaemonMsg::RemovalRefused {
            id: id.to_owned(),
            reason: block.to_string(),
        };
        let target = lock(&self.registry).removal_target(id);
        let (wt, project) = match target {
            Ok(t) => t,
            Err(e) => return self.error(e),
        };
        let check = || {
            (!wt.broken && wt.path.exists())
                .then(|| {
                    git::removal_block(
                        &project.path,
                        &wt.path,
                        &wt.branch,
                        &project.base_branch,
                        project.remote.is_some(),
                    )
                })
                .flatten()
        };
        // Antes de parar o agente: uma recusa não pode derrubá-lo
        if !force && let Some(block) = check() {
            return self.send(&refused(block));
        }
        self.sessions.stop(id);
        // De novo depois de parar: o agente pode ter escrito durante a parada
        if !force && let Some(block) = check() {
            self.send(&refused(block));
            return self.broadcast_state();
        }
        if let Err(e) = git::remove_worktree(&project.path, &wt.path, &wt.branch) {
            self.error(e);
            return self.broadcast_state();
        }
        lock(&self.registry).forget_worktree(id);
        self.sessions.forget(id);
        lock(&self.trackers).remove(id);
        lock(&self.notified).remove(id);
        lock(&self.last_sent).remove(id);
        self.save();
        self.broadcast_state();
    }

    fn restart_agent(self: &Arc<Self>, id: &str) {
        let session_id = lock(&self.registry)
            .worktree(id)
            .and_then(|w| w.session_id.clone());
        let primary = match self.launch_for(id, SessionMode::Resume { session_id }, None) {
            Ok(l) => l,
            Err(e) => return self.error(e),
        };
        let fresh_id = new_session_id();
        let fallback = match self.launch_for(
            id,
            SessionMode::New {
                session_id: Some(fresh_id.clone()),
            },
            None,
        ) {
            Ok(l) => l,
            Err(e) => return self.error(e),
        };
        self.track_spawn(id);
        let inner = Arc::clone(self);
        let id = id.to_owned();
        thread::spawn(move || {
            match inner
                .sessions
                .start_with_fallback(&id, primary, fallback, RESUME_WINDOW)
            {
                // O fallback usa um id novo: é ele que vale para o próximo resume
                Ok(true) => {
                    inner.track_spawn(&id);
                    if let Some(wt) = lock(&inner.registry).worktree_mut(&id) {
                        wt.session_id = Some(fresh_id);
                    }
                    inner.save();
                }
                Ok(false) => {}
                Err(e) => inner.error(format!("could not restart the agent: {e}")),
            }
            inner.mark_dirty(&id);
            inner.broadcast_state();
        });
        self.broadcast_state();
    }

    fn set_focus(&self, worktree: Option<String>, window_focused: bool) {
        let changed = {
            let mut focus = lock(&self.focus);
            let changed = focus.worktree != worktree;
            focus.worktree.clone_from(&worktree);
            focus.window_focused = window_focused;
            changed
        };
        if changed && let Some(pane) = worktree.as_ref() {
            let (cols, rows) = *lock(&self.size);
            self.sessions.resize(pane, cols, rows);
            lock(&self.last_sent).remove(pane);
            self.mark_dirty(pane);
        }
        if window_focused && let Some(pane) = worktree {
            self.apply(&pane, Signal::Looked);
        }
    }

    fn handle(self: &Arc<Self>, msg: ClientMsg) {
        match msg {
            ClientMsg::Ping | ClientMsg::HookEvent { .. } => {}
            ClientMsg::Attach { cols, rows, env } => {
                self.ui_attached.store(true, Ordering::SeqCst);
                *lock(&self.size) = (cols, rows);
                *lock(&self.env) = env;
                lock(&self.last_sent).clear();
                if let Some(notice) = lock(&self.pending_notice).take() {
                    self.send(&DaemonMsg::Notice(notice));
                }
                self.broadcast_state();
                let focused = lock(&self.focus).worktree.clone();
                if let Some(pane) = focused {
                    self.mark_dirty(&pane);
                }
            }
            ClientMsg::Focus {
                worktree,
                window_focused,
            } => self.set_focus(worktree, window_focused),
            ClientMsg::Input { pane, bytes } => {
                // Digitar não é trabalhar: só um Enter submete. Agentes com hooks
                // avisam o envio pelo UserPromptSubmit.
                let hooked = lock(&self.trackers).get(&pane).is_some_and(Tracker::hooks);
                if !hooked && bytes.contains(&b'\r') {
                    self.apply(&pane, Signal::UserInput);
                }
                self.sessions.input(&pane, bytes);
            }
            ClientMsg::Resize { cols, rows } => {
                *lock(&self.size) = (cols, rows);
                let focused = lock(&self.focus).worktree.clone();
                if let Some(pane) = focused {
                    self.sessions.resize(&pane, cols, rows);
                    self.mark_dirty(&pane);
                }
            }
            ClientMsg::AddProject { path } => {
                let result = lock(&self.registry)
                    .add_project(std::path::Path::new(&path), &git::Env::default());
                match result {
                    Ok(_) => self.save(),
                    Err(e) => self.error(e),
                }
                self.broadcast_state();
            }
            ClientMsg::AddGroup { name, paths } => {
                let paths: Vec<std::path::PathBuf> = paths.iter().map(Into::into).collect();
                let result = lock(&self.registry).add_group(&name, &paths, &git::Env::default());
                match result {
                    Ok(_) => self.save(),
                    Err(e) => self.error(e),
                }
                self.broadcast_state();
            }
            ClientMsg::DissolveGroup { group } => {
                let result = lock(&self.registry).dissolve_group(&group);
                match result {
                    Ok(()) => self.save(),
                    Err(e) => self.error(e),
                }
                self.broadcast_state();
            }
            ClientMsg::Scroll { pane, lines } => {
                self.sessions.scroll(&pane, lines);
                self.mark_dirty(&pane);
            }
            ClientMsg::Rename { target, name } => {
                let result = {
                    let mut registry = lock(&self.registry);
                    match &target {
                        RenameTarget::Project(slug) => {
                            registry.set_alias(slug, &name).map(|()| None)
                        }
                        RenameTarget::Group(slug) => {
                            registry.rename_group(slug, &name).map(|()| None)
                        }
                        RenameTarget::Worktree(id) => registry.rename_worktree(id, &name),
                    }
                };
                match result {
                    Ok(notice) => {
                        self.save();
                        if let Some(notice) = notice {
                            self.send(&DaemonMsg::Notice(notice));
                        }
                    }
                    Err(e) => self.error(e),
                }
                self.broadcast_state();
            }
            ClientMsg::SetBaseBranch { project, base } => {
                let result = lock(&self.registry).set_base_branch(&project, &base);
                match result {
                    Ok(()) => self.save(),
                    Err(e) => self.error(e),
                }
                self.broadcast_state();
            }
            ClientMsg::CreateWorktree {
                project,
                name,
                agent,
                permission,
                model,
                effort,
                prompt,
            } => {
                let choice = Choice {
                    model,
                    effort,
                    prompt,
                };
                self.create_worktree(&project, &name, &agent, permission, choice);
            }
            ClientMsg::RemoveWorktree { id, force } => self.remove_worktree(&id, force),
            ClientMsg::StopAgent { id } => self.sessions.stop(&id),
            ClientMsg::RestartAgent { id } => self.restart_agent(&id),
        }
    }
}

fn spawn_event_loop(inner: Weak<Inner>, rx: Receiver<PaneEvent>) {
    thread::spawn(move || {
        for event in rx {
            let Some(inner) = inner.upgrade() else { break };
            match event {
                PaneEvent::Dirty(pane) => inner.mark_dirty(&pane),
                PaneEvent::Exited { pane, .. } => {
                    inner.mark_dirty(&pane);
                    // Saída de uma sessão já substituída (resume que caiu no fallback)
                    if !inner.sessions.is_running(&pane) {
                        inner.apply(&pane, Signal::Exited);
                    }
                    inner.broadcast_state();
                }
                PaneEvent::Warning { message, .. } => inner.send(&DaemonMsg::Notice(message)),
                PaneEvent::Output { pane, bytes } => {
                    lock(&inner.last_output).insert(pane.clone(), Instant::now());
                    let notices = lock(&inner.scanners)
                        .get_mut(&pane)
                        .map(|s| s.scan(&bytes))
                        .unwrap_or_default();
                    if !notices.is_empty() && !inner.hooked(&pane) {
                        inner.apply(&pane, Signal::NeedsYou);
                    }
                    inner.apply(&pane, Signal::Output);
                }
                PaneEvent::Title { pane, title } => {
                    if let Some(kind) = classify_title(&title) {
                        if let Some(t) = lock(&inner.trackers).get_mut(&pane) {
                            t.mark_rich();
                        }
                        let signal = if kind == TitleKind::Idle {
                            Signal::TitleIdle
                        } else {
                            Signal::TitleWorking
                        };
                        inner.apply(&pane, signal);
                    }
                }
                PaneEvent::Bell(pane) => {
                    if !inner.hooked(&pane) {
                        inner.apply(&pane, Signal::NeedsYou);
                    }
                }
            }
        }
    });
}

/// Marca "terminou" em agentes sem sinais que ficaram em silêncio (KTD12).
fn spawn_silence_loop(inner: Weak<Inner>) {
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(200));
            let Some(inner) = inner.upgrade() else { break };
            let silence = *lock(&inner.silence);
            let quiet: Vec<String> = {
                let trackers = lock(&inner.trackers);
                let last = lock(&inner.last_output);
                trackers
                    .iter()
                    .filter(|(_, t)| t.running() && !t.rich() && t.state() == AgentState::Working)
                    .filter(|(pane, _)| last.get(*pane).is_some_and(|at| at.elapsed() >= silence))
                    .map(|(pane, _)| pane.clone())
                    .collect()
            };
            for pane in quiet {
                inner.apply(&pane, Signal::Silence);
            }
        }
    });
}

fn spawn_render_loop(inner: Weak<Inner>) {
    thread::spawn(move || {
        loop {
            thread::sleep(FRAME);
            let Some(inner) = inner.upgrade() else { break };
            let Some(pane) = lock(&inner.focus).worktree.clone() else {
                continue;
            };
            if !lock(&inner.dirty).remove(&pane) {
                continue;
            }
            let Some(snapshot) = inner.sessions.snapshot(&pane) else {
                continue;
            };
            let msg = {
                let last = lock(&inner.last_sent);
                match last.get(&pane) {
                    Some(prev) if *prev == snapshot => None,
                    Some(prev) => Some(match snapshot.diff(prev) {
                        Some(diff) => DaemonMsg::Diff {
                            pane: pane.clone(),
                            diff,
                        },
                        None => DaemonMsg::Snapshot {
                            pane: pane.clone(),
                            snapshot: snapshot.clone(),
                        },
                    }),
                    None => Some(DaemonMsg::Snapshot {
                        pane: pane.clone(),
                        snapshot: snapshot.clone(),
                    }),
                }
            };
            if let Some(msg) = msg {
                inner.send(&msg);
            }
            lock(&inner.last_sent).insert(pane, snapshot);
        }
    });
}

impl SessionHost for Workspace {
    fn live_agents(&self) -> u32 {
        self.inner.sessions.live_agents()
    }

    fn stop_all(&self) {
        self.inner.sessions.stop_all();
    }

    fn set_ui_sink(&self, sink: UiSink) {
        *lock(&self.inner.ui) = Some(sink);
    }

    fn handle(&self, msg: ClientMsg) {
        self.inner.handle(msg);
    }

    fn hook_event(&self, pane: &str, event: &str, payload: &str) {
        self.inner.hook_event(pane, event, payload);
    }

    fn ui_detached(&self) {
        self.inner.ui_attached.store(false, Ordering::SeqCst);
        *lock(&self.inner.focus) = Focus::default();
        lock(&self.inner.last_sent).clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_model_and_effort_are_kept_when_the_catalog_has_them() {
        let (model, effort, notice) = stored_options(AgentId::Claude, Some("opus"), Some("high"));
        assert_eq!(model.as_deref(), Some("opus"));
        assert_eq!(effort, Some(Effort::High));
        assert_eq!(notice, None);
    }

    #[test]
    fn a_retired_model_is_dropped_with_a_notice() {
        let (model, effort, notice) =
            stored_options(AgentId::Claude, Some("retired-model"), Some("high"));
        assert_eq!((model, effort), (None, None));
        assert!(notice.is_some_and(|n| n.contains("retired-model")));
    }

    #[test]
    fn an_effort_the_model_lost_is_dropped_quietly() {
        let (model, effort, notice) = stored_options(AgentId::Claude, Some("haiku"), Some("high"));
        assert_eq!(model.as_deref(), Some("haiku"));
        assert_eq!((effort, notice), (None, None));
    }

    #[test]
    fn worktrees_without_a_stored_model_launch_with_defaults() {
        assert_eq!(
            stored_options(AgentId::Claude, None, None),
            (None, None, None)
        );
    }
}
