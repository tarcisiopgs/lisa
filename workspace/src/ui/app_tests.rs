use super::*;
use crate::protocol::work::{AgentOption, AgentState, ProjectView, WorktreeView};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}

fn wt(id: &str, state: AgentState, running: bool) -> WorktreeView {
    let (project, name) = id.split_once('/').unwrap_or(("api", id));
    WorktreeView {
        id: id.into(),
        project: project.into(),
        name: name.into(),
        branch: name.into(),
        agent: Some("claude".into()),
        autonomy: false,
        state,
        running,
        exit_code: if running { None } else { Some(1) },
        broken: false,
    }
}

fn workspace() -> WorkspaceState {
    WorkspaceState {
        projects: vec![
            ProjectView {
                slug: "api".into(),
                name: "api".into(),
                path: "/r/api".into(),
                base_branch: "main".into(),
            },
            ProjectView {
                slug: "web".into(),
                name: "web".into(),
                path: "/r/web".into(),
                base_branch: "main".into(),
            },
        ],
        worktrees: vec![
            wt("api/fix-login", AgentState::Working, true),
            wt("api/rate-limit", AgentState::NeedsYou, true),
            wt("web/checkout", AgentState::Done, true),
        ],
        agents: vec![
            AgentOption {
                name: "claude".into(),
                available: true,
                autonomy_supported: true,
            },
            AgentOption {
                name: "opencode".into(),
                available: true,
                autonomy_supported: false,
            },
            AgentOption {
                name: "gemini".into(),
                available: false,
                autonomy_supported: true,
            },
        ],
    }
}

fn app() -> App {
    let mut a = App::new(120, 30);
    a.on_focus(true);
    a.on_daemon(DaemonMsg::State(workspace()));
    a
}

fn sent(actions: &[Action]) -> Vec<ClientMsg> {
    actions
        .iter()
        .filter_map(|a| match a {
            Action::Send(m) => Some(m.clone()),
            _ => None,
        })
        .collect()
}

fn select(a: &mut App, id: &str) {
    let idx = a
        .rows()
        .iter()
        .position(|r| matches!(r, Row::Worktree { id: i } if i == id));
    a.select_row(idx.unwrap_or_else(|| panic!("no row {id}")));
}

fn open(a: &mut App, id: &str) -> Vec<Action> {
    a.on_key(ctrl('a'));
    select(a, id);
    a.on_key(key(KeyCode::Enter))
}

fn type_text(a: &mut App, text: &str) {
    for c in text.chars() {
        a.on_key(key(KeyCode::Char(c)));
    }
}

#[test]
fn prefix_moves_focus_to_the_sidebar_without_sending_anything() {
    let mut a = app();
    let actions = a.on_key(ctrl('a'));
    assert_eq!(a.zone(), Zone::Sidebar);
    assert!(sent(&actions).is_empty());
}

#[test]
fn double_prefix_sends_a_literal_ctrl_a_to_the_agent() {
    let mut a = app();
    open(&mut a, "api/fix-login");
    a.on_key(ctrl('a'));
    let actions = a.on_key(ctrl('a'));
    assert_eq!(
        sent(&actions),
        vec![ClientMsg::Input {
            pane: "api/fix-login".into(),
            bytes: vec![1]
        }]
    );
    assert_eq!(a.zone(), Zone::Pane);
}

#[test]
fn enter_on_a_worktree_opens_it_and_reports_focus() {
    let mut a = app();
    let actions = open(&mut a, "api/fix-login");
    assert_eq!(a.zone(), Zone::Pane);
    assert_eq!(a.focused(), Some("api/fix-login"));
    assert!(
        sent(&actions).iter().any(
            |m| matches!(m, ClientMsg::Focus { worktree: Some(w), .. } if w == "api/fix-login")
        )
    );
}

#[test]
fn keys_in_the_pane_go_to_the_focused_agent() {
    let mut a = app();
    open(&mut a, "api/fix-login");
    let actions = a.on_key(key(KeyCode::Char('x')));
    assert_eq!(
        sent(&actions),
        vec![ClientMsg::Input {
            pane: "api/fix-login".into(),
            bytes: b"x".to_vec()
        }]
    );
}

#[test]
fn keys_in_the_pane_without_a_focused_worktree_send_nothing() {
    let mut a = app();
    assert!(sent(&a.on_key(key(KeyCode::Char('x')))).is_empty());
}

#[test]
fn creating_a_worktree_sends_name_agent_and_permission() {
    let mut a = app();
    a.on_key(ctrl('a'));
    select(&mut a, "api/fix-login");
    a.on_key(key(KeyCode::Char('n')));
    type_text(&mut a, "Fix Login");
    let actions = a.on_key(key(KeyCode::Enter));
    assert_eq!(
        sent(&actions),
        vec![ClientMsg::CreateWorktree {
            project: "api".into(),
            name: "Fix Login".into(),
            agent: "claude".into(),
            permission: PermissionWire::Normal,
            model: None,
            effort: None,
            prompt: None,
        }]
    );
    assert!(matches!(a.dialog(), Some(Dialog::NewWorktree(d)) if d.pending));
}

#[test]
fn full_autonomy_cannot_be_chosen_for_an_agent_without_it() {
    let mut a = app();
    a.on_key(ctrl('a'));
    a.on_key(key(KeyCode::Char('n')));
    type_text(&mut a, "x");
    a.on_key(key(KeyCode::Tab)); // campo tarefa
    a.on_key(key(KeyCode::Tab)); // campo agente
    a.on_key(key(KeyCode::Down)); // opencode
    a.on_key(key(KeyCode::Tab)); // campo permissão
    a.on_key(key(KeyCode::Char(' ')));
    let actions = a.on_key(key(KeyCode::Enter));
    assert!(sent(&actions).iter().any(|m| matches!(
        m,
        ClientMsg::CreateWorktree { agent, permission: PermissionWire::Normal, .. } if agent == "opencode"
    )));
}

#[test]
fn unavailable_agents_are_skipped_when_choosing() {
    let mut a = app();
    a.on_key(ctrl('a'));
    a.on_key(key(KeyCode::Char('n')));
    type_text(&mut a, "x");
    a.on_key(key(KeyCode::Tab)); // campo tarefa
    a.on_key(key(KeyCode::Tab)); // campo agente
    a.on_key(key(KeyCode::Down));
    a.on_key(key(KeyCode::Down)); // gemini indisponível: fica em opencode
    let actions = a.on_key(key(KeyCode::Enter));
    assert!(
        sent(&actions)
            .iter()
            .any(|m| matches!(m, ClientMsg::CreateWorktree { agent, .. } if agent == "opencode"))
    );
}

#[test]
fn the_created_worktree_is_opened_when_it_appears() {
    let mut a = app();
    a.on_key(ctrl('a'));
    a.on_key(key(KeyCode::Char('n')));
    type_text(&mut a, "new-one");
    a.on_key(key(KeyCode::Enter));
    let mut ws = workspace();
    ws.worktrees
        .push(wt("api/new-one", AgentState::Working, true));
    let actions = a.on_daemon(DaemonMsg::State(ws));
    assert!(a.dialog().is_none());
    assert_eq!(a.focused(), Some("api/new-one"));
    assert_eq!(a.zone(), Zone::Pane);
    assert!(
        sent(&actions)
            .iter()
            .any(|m| matches!(m, ClientMsg::Focus { worktree: Some(w), .. } if w == "api/new-one"))
    );
}

#[test]
fn an_error_while_creating_keeps_the_dialog_with_the_message() {
    let mut a = app();
    a.on_key(ctrl('a'));
    a.on_key(key(KeyCode::Char('n')));
    type_text(&mut a, "taken");
    a.on_key(key(KeyCode::Enter));
    a.on_daemon(DaemonMsg::Error("branch taken already exists".into()));
    match a.dialog() {
        Some(Dialog::NewWorktree(d)) => {
            assert!(!d.pending);
            assert_eq!(d.error.as_deref(), Some("branch taken already exists"));
        }
        other => panic!("unexpected dialog {other:?}"),
    }
}

#[test]
fn removal_confirms_then_reports_refusal_and_can_force() {
    let mut a = app();
    a.on_key(ctrl('a'));
    select(&mut a, "api/fix-login");
    a.on_key(key(KeyCode::Char('d')));
    let actions = a.on_key(key(KeyCode::Char('y')));
    assert_eq!(
        sent(&actions),
        vec![ClientMsg::RemoveWorktree {
            id: "api/fix-login".into(),
            force: false
        }]
    );
    a.on_daemon(DaemonMsg::RemovalRefused {
        id: "api/fix-login".into(),
        reason: "1 uncommitted change(s)".into(),
    });
    assert!(
        matches!(a.dialog(), Some(Dialog::ConfirmRemove { refused: Some(r), .. }) if r.contains("uncommitted"))
    );
    let actions = a.on_key(key(KeyCode::Char('f')));
    assert_eq!(
        sent(&actions),
        vec![ClientMsg::RemoveWorktree {
            id: "api/fix-login".into(),
            force: true
        }]
    );
}

#[test]
fn escape_cancels_removal_without_sending() {
    let mut a = app();
    a.on_key(ctrl('a'));
    select(&mut a, "api/fix-login");
    a.on_key(key(KeyCode::Char('d')));
    assert!(sent(&a.on_key(key(KeyCode::Esc))).is_empty());
    assert!(a.dialog().is_none());
}

#[test]
fn alert_rings_the_host_terminal_bell() {
    let mut a = app();
    let actions = a.on_daemon(DaemonMsg::Alert {
        pane: "api/rate-limit".into(),
        title: "Lisa".into(),
        body: "rate-limit: claude needs you".into(),
    });
    assert!(actions.contains(&Action::Bell));
}

#[test]
fn losing_window_focus_is_reported_to_the_daemon() {
    let mut a = app();
    open(&mut a, "api/fix-login");
    let actions = a.on_focus(false);
    assert_eq!(
        sent(&actions),
        vec![ClientMsg::Focus {
            worktree: Some("api/fix-login".into()),
            window_focused: false
        }]
    );
}

#[test]
fn a_key_press_proves_the_window_is_focused() {
    let mut a = app();
    open(&mut a, "api/fix-login");
    a.on_focus(false);
    let actions = a.on_key(key(KeyCode::Char('x')));
    assert!(sent(&actions).contains(&ClientMsg::Focus {
        worktree: Some("api/fix-login".into()),
        window_focused: true
    }));
}

#[test]
fn attached_elsewhere_quits_with_a_message() {
    let mut a = app();
    let actions = a.on_daemon(DaemonMsg::AttachedElsewhere);
    assert!(actions.contains(&Action::Quit));
    assert!(a.exit_message().is_some_and(|m| m.contains("another")));
}

#[test]
fn tab_in_the_sidebar_jumps_to_the_next_worktree_that_needs_attention() {
    let mut a = app();
    a.on_key(ctrl('a'));
    select(&mut a, "api/fix-login");
    a.on_key(key(KeyCode::Tab));
    assert!(matches!(a.selected_row(), Some(Row::Worktree { id }) if id == "api/rate-limit"));
    a.on_key(key(KeyCode::Tab));
    assert!(matches!(a.selected_row(), Some(Row::Worktree { id }) if id == "web/checkout"));
}

#[test]
fn quitting_from_the_sidebar_detaches() {
    let mut a = app();
    a.on_key(ctrl('a'));
    assert!(a.on_key(key(KeyCode::Char('q'))).contains(&Action::Quit));
}

#[test]
fn diff_for_the_focused_pane_updates_the_screen() {
    let mut a = app();
    open(&mut a, "api/fix-login");
    let blank = Snapshot {
        cols: 2,
        rows: 1,
        lines: vec![Line {
            cells: vec![cell(' '), cell(' ')],
        }],
        cursor: CursorPos {
            row: 0,
            col: 0,
            visible: true,
        },
        title: String::new(),
        modes: Modes::default(),
    };
    a.on_daemon(DaemonMsg::Snapshot {
        pane: "api/fix-login".into(),
        snapshot: blank.clone(),
    });
    let mut next = blank.clone();
    next.lines[0].cells[0] = cell('x');
    let diff = next.diff(&blank).unwrap_or_else(|| panic!("diff"));
    a.on_daemon(DaemonMsg::Diff {
        pane: "api/fix-login".into(),
        diff,
    });
    assert_eq!(a.screen().map(|s| s.lines[0].cells[0].ch), Some('x'));
}

#[test]
fn resize_reports_the_pane_size_leaving_room_for_the_sidebar() {
    let mut a = app();
    let actions = a.on_resize(120, 30);
    assert_eq!(
        sent(&actions),
        vec![ClientMsg::Resize { cols: 91, rows: 29 }]
    );
}

#[test]
fn narrow_terminals_keep_only_a_glyph_rail() {
    let mut a = app();
    let actions = a.on_resize(90, 30);
    assert_eq!(
        sent(&actions),
        vec![ClientMsg::Resize { cols: 86, rows: 29 }]
    );
}

#[test]
fn restart_is_only_sent_for_an_exited_agent() {
    let mut a = App::new(120, 30);
    a.on_focus(true);
    let mut ws = workspace();
    ws.worktrees.push(wt("api/dead", AgentState::Idle, false));
    a.on_daemon(DaemonMsg::State(ws));
    a.on_key(ctrl('a'));
    select(&mut a, "api/fix-login");
    assert!(sent(&a.on_key(key(KeyCode::Char('r')))).is_empty());
    select(&mut a, "api/dead");
    assert_eq!(
        sent(&a.on_key(key(KeyCode::Char('r')))),
        vec![ClientMsg::RestartAgent {
            id: "api/dead".into()
        }]
    );
}

#[test]
fn adding_a_project_expands_the_home_directory() {
    let mut a = app();
    a.on_key(ctrl('a'));
    a.on_key(key(KeyCode::Char('p')));
    type_text(&mut a, "~/code/app");
    let actions = a.on_key(key(KeyCode::Enter));
    let home = std::env::var("HOME").unwrap_or_default();
    assert_eq!(
        sent(&actions),
        vec![ClientMsg::AddProject {
            path: format!("{home}/code/app")
        }]
    );
}

fn cell(ch: char) -> crate::protocol::work::Cell {
    crate::protocol::work::Cell {
        ch,
        fg: Color::Default,
        bg: Color::Default,
        attrs: 0,
    }
}

#[test]
fn the_remembered_permission_is_preselected_and_saved_again() {
    let mut a = app();
    a.set_default_autonomy(true);
    a.on_key(ctrl('a'));
    a.on_key(key(KeyCode::Char('n')));
    type_text(&mut a, "auto");
    let actions = a.on_key(key(KeyCode::Enter));
    assert!(sent(&actions).iter().any(|m| matches!(
        m,
        ClientMsg::CreateWorktree {
            permission: PermissionWire::FullAutonomy,
            ..
        }
    )));
    assert!(actions.contains(&Action::RememberAutonomy(true)));
}

#[test]
fn a_remembered_full_autonomy_is_not_applied_to_an_agent_without_it() {
    let mut a = app();
    a.set_default_autonomy(true);
    a.on_key(ctrl('a'));
    a.on_key(key(KeyCode::Char('n')));
    type_text(&mut a, "x");
    a.on_key(key(KeyCode::Tab)); // campo tarefa
    a.on_key(key(KeyCode::Tab)); // campo agente
    a.on_key(key(KeyCode::Down)); // opencode
    let actions = a.on_key(key(KeyCode::Enter));
    assert!(sent(&actions).iter().any(|m| matches!(
        m,
        ClientMsg::CreateWorktree {
            permission: PermissionWire::Normal,
            ..
        }
    )));
}

#[test]
fn reattaching_resends_focus_so_the_pane_keeps_streaming() {
    let mut a = app();
    open(&mut a, "api/fix-login");
    let msgs = a.attach_msgs(Vec::new());
    assert!(matches!(msgs.first(), Some(ClientMsg::Attach { .. })));
    assert!(msgs.contains(&ClientMsg::Focus {
        worktree: Some("api/fix-login".into()),
        window_focused: true
    }));
}

// ---- Roteador no diálogo de novo worktree ----

use crate::agents::Effort;
use crate::router::{Answers, Kind, RouteError, Size};

fn option(name: &str, autonomy: bool) -> AgentOption {
    AgentOption {
        name: name.into(),
        available: true,
        autonomy_supported: autonomy,
    }
}

/// App com claude, codex, gemini e opencode instalados, e o diálogo de novo worktree aberto.
fn routing() -> App {
    let mut state = workspace();
    state.agents = vec![
        option("claude", true),
        option("codex", true),
        option("gemini", true),
        option("opencode", false),
    ];
    let mut a = App::new(120, 40);
    a.on_focus(true);
    a.on_daemon(DaemonMsg::State(state));
    a.on_key(ctrl('a'));
    select(&mut a, "api/fix-login");
    a.on_key(key(KeyCode::Char('n')));
    a
}

fn new_worktree(a: &App) -> &NewWorktree {
    match a.dialog() {
        Some(Dialog::NewWorktree(d)) => d,
        other => panic!("no new worktree dialog: {other:?}"),
    }
}

/// Modelo selecionado, pelo nome.
fn model_name(a: &App) -> &'static str {
    let d = new_worktree(a);
    let agent = &a.workspace.agents[d.agent].name;
    model_options(agent)[d.model]
}

fn agent_name(a: &App) -> String {
    a.workspace.agents[new_worktree(a).agent].name.clone()
}

/// Digita nome e tarefa e sai do campo `Task`; devolve as ações dessa saída.
fn fill(a: &mut App, task: &str) -> Vec<Action> {
    type_text(a, "fix");
    a.on_key(key(KeyCode::Tab));
    type_text(a, task);
    a.on_key(key(KeyCode::Tab))
}

fn route_id(actions: &[Action]) -> u64 {
    actions
        .iter()
        .find_map(|a| match a {
            Action::Route { id, .. } => Some(*id),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no route requested: {actions:?}"))
}

fn answers(size: Size, depth: f32, kind: Kind, kind_confidence: f32) -> Answers {
    let mut size_probs = [0.0; 4];
    size_probs[size as usize] = 1.0;
    Answers {
        size_probs,
        size_confidence: 0.9,
        depth,
        kind,
        kind_confidence,
    }
}

fn created(actions: &[Action]) -> ClientMsg {
    sent(actions)
        .into_iter()
        .find(|m| matches!(m, ClientMsg::CreateWorktree { .. }))
        .unwrap_or_else(|| panic!("nothing created: {actions:?}"))
}

#[test]
fn blank_task_creates_exactly_as_before() {
    let mut a = routing();
    type_text(&mut a, "fix");
    let tabbed = a.on_key(key(KeyCode::Tab));
    let left_task = a.on_key(key(KeyCode::Tab));
    assert!(tabbed.is_empty() && left_task.is_empty());
    let msg = created(&a.on_key(key(KeyCode::Enter)));
    assert!(matches!(
        msg,
        ClientMsg::CreateWorktree {
            model: None,
            effort: None,
            prompt: None,
            ..
        }
    ));
}

#[test]
fn leaving_the_task_field_asks_for_a_route() {
    let mut a = routing();
    let actions = fill(&mut a, "fix login");
    assert_eq!(
        actions,
        vec![Action::Route {
            id: 1,
            task: "fix login".into()
        }]
    );
    assert_eq!(new_worktree(&a).route, Route::Pending { id: 1 });
}

#[test]
fn leaving_with_the_same_text_does_not_ask_twice() {
    let mut a = routing();
    fill(&mut a, "fix login");
    a.on_key(key(KeyCode::BackTab));
    assert!(a.on_key(key(KeyCode::Tab)).is_empty());
    a.on_key(key(KeyCode::BackTab));
    type_text(&mut a, "!");
    assert_eq!(route_id(&a.on_key(key(KeyCode::Tab))), 2);
}

#[test]
fn a_suggestion_fills_agent_model_and_effort() {
    let mut a = routing();
    let id = route_id(&fill(&mut a, "why does login loop"));
    a.on_route(
        id,
        Ok(answers(Size::Complex, 0.9, Kind::Investigation, 0.86)),
    );
    assert_eq!(agent_name(&a), "claude");
    assert_eq!(model_name(&a), "opus");
    assert_eq!(new_worktree(&a).effort, Some(Effort::High));
    assert_eq!(
        new_worktree(&a).route,
        Route::Suggested {
            agent: "claude".into(),
            percent: 86,
            unsure: false
        }
    );
}

#[test]
fn a_kind_that_maps_elsewhere_moves_the_selection() {
    let mut a = routing();
    let id = route_id(&fill(&mut a, "review the auth module"));
    a.on_route(id, Ok(answers(Size::Scoped, 0.1, Kind::Review, 0.9)));
    assert_eq!(agent_name(&a), "codex");
    assert_eq!(model_name(&a), "gpt-6-luna");
    assert_eq!(new_worktree(&a).effort, Some(Effort::High));
}

#[test]
fn accepting_sends_model_effort_and_prompt() {
    let mut a = routing();
    let id = route_id(&fill(&mut a, "  why does login loop "));
    a.on_route(
        id,
        Ok(answers(Size::Complex, 0.9, Kind::Investigation, 0.86)),
    );
    let msg = created(&a.on_key(key(KeyCode::Enter)));
    assert_eq!(
        msg,
        ClientMsg::CreateWorktree {
            project: "api".into(),
            name: "fix".into(),
            agent: "claude".into(),
            permission: PermissionWire::Normal,
            model: Some("opus".into()),
            effort: Some("high".into()),
            prompt: Some("why does login loop".into()),
        }
    );
}

#[test]
fn a_manual_choice_survives_a_late_suggestion() {
    let mut a = routing();
    let id = route_id(&fill(&mut a, "why does login loop"));
    // Já no campo Agent: desce para codex antes de a resposta chegar
    a.on_key(key(KeyCode::Down));
    a.on_route(
        id,
        Ok(answers(Size::Complex, 0.9, Kind::Investigation, 0.86)),
    );
    assert_eq!(agent_name(&a), "codex");
    assert!(matches!(
        &new_worktree(&a).route,
        Route::Suggested { agent, .. } if agent == "claude"
    ));
    // O tamanho chegou: o modelo do agente escolhido acompanha
    assert_eq!(model_name(&a), "gpt-6.1-sol");
}

#[test]
fn switching_agent_keeps_the_size() {
    let mut a = routing();
    let id = route_id(&fill(&mut a, "why does login loop"));
    a.on_route(
        id,
        Ok(answers(Size::Complex, 0.1, Kind::Investigation, 0.86)),
    );
    a.on_key(key(KeyCode::Down));
    assert_eq!(agent_name(&a), "codex");
    assert_eq!(model_name(&a), "gpt-6.1-sol");
    assert_eq!(new_worktree(&a).effort, Some(Effort::Medium));
    // gemini ainda não tem catálogo conferido: sem modelo, e a seleção volta ao padrão
    a.on_key(key(KeyCode::Down));
    assert_eq!(agent_name(&a), "gemini");
    assert!(model_options("gemini").is_empty());
    assert_eq!((new_worktree(&a).model, new_worktree(&a).effort), (0, None));
}

#[test]
fn stale_and_orphan_answers_are_dropped() {
    let complex = || Ok(answers(Size::Complex, 0.9, Kind::Review, 0.9));
    // Resposta de um texto que já mudou
    let mut a = routing();
    let old = route_id(&fill(&mut a, "one"));
    a.on_key(key(KeyCode::BackTab));
    type_text(&mut a, " two");
    let new = route_id(&a.on_key(key(KeyCode::Tab)));
    a.on_route(old, complex());
    assert_eq!(new_worktree(&a).route, Route::Pending { id: new });
    assert_eq!(agent_name(&a), "claude");
    // Resposta depois de fechar o diálogo, e sem diálogo nenhum
    a.on_key(key(KeyCode::Esc));
    a.on_route(new, complex());
    assert!(a.dialog().is_none());
    // Resposta de um diálogo anterior não vale para o novo
    a.on_key(key(KeyCode::Char('n')));
    a.on_route(new, complex());
    assert_eq!(new_worktree(&a).route, Route::Idle);
}

#[test]
fn a_reordered_agent_list_does_not_move_the_suggestion_to_another_agent() {
    let mut a = routing();
    let id = route_id(&fill(&mut a, "review the auth module"));
    let mut state = a.workspace.clone();
    state.agents.reverse();
    a.on_daemon(DaemonMsg::State(state));
    a.on_route(id, Ok(answers(Size::Scoped, 0.1, Kind::Review, 0.9)));
    assert_eq!(agent_name(&a), "codex");
}

#[test]
fn failures_show_their_reason_and_keep_the_dialog_usable() {
    let mut a = routing();
    let id = route_id(&fill(&mut a, "fix login"));
    a.on_route(id, Err(RouteError::NoKey));
    assert_eq!(
        new_worktree(&a).route,
        Route::Failed("no TYPESAFE_API_KEY · choosing manually")
    );
    let msg = created(&a.on_key(key(KeyCode::Enter)));
    assert!(matches!(
        msg,
        ClientMsg::CreateWorktree { model: None, effort: None, prompt: Some(p), .. } if p == "fix login"
    ));
}

#[test]
fn low_kind_confidence_selects_the_first_preferred_agent_as_unsure() {
    let mut a = routing();
    a.set_router_config(crate::router::RouterConfig {
        preference: vec![
            crate::agents::AgentId::Codex,
            crate::agents::AgentId::Claude,
        ],
        ..Default::default()
    });
    let id = route_id(&fill(&mut a, "do the thing"));
    a.on_route(id, Ok(answers(Size::Scoped, 0.1, Kind::Review, 0.2)));
    assert_eq!(agent_name(&a), "codex");
    assert!(matches!(
        new_worktree(&a).route,
        Route::Suggested { unsure: true, .. }
    ));
}

#[test]
fn no_routable_agent_installed_is_a_failure_with_a_reason() {
    let mut a = routing();
    let mut state = a.workspace.clone();
    state.agents = vec![option("opencode", false)];
    a.on_daemon(DaemonMsg::State(state));
    let id = route_id(&fill(&mut a, "fix login"));
    a.on_route(id, Ok(answers(Size::Scoped, 0.1, Kind::Other, 0.9)));
    assert_eq!(
        new_worktree(&a).route,
        Route::Failed("no routable agent installed · choosing manually")
    );
}

#[test]
fn tab_walks_only_the_fields_that_apply() {
    let mut a = routing();
    let fields = |a: &mut App| {
        let mut seen = vec![new_worktree(a).field];
        for _ in 0..6 {
            a.on_key(key(KeyCode::Tab));
            seen.push(new_worktree(a).field);
        }
        seen
    };
    // claude com o modelo `default`: sem effort
    assert_eq!(
        fields(&mut a),
        [
            Field::Name,
            Field::Task,
            Field::Agent,
            Field::Model,
            Field::Permission,
            Field::Name,
            Field::Task
        ]
    );
}

#[test]
fn models_without_effort_skip_the_effort_field() {
    let mut a = routing();
    let id = route_id(&fill(&mut a, "rename foo"));
    a.on_route(id, Ok(answers(Size::Trivial, 0.1, Kind::Other, 0.9)));
    assert_eq!((model_name(&a), new_worktree(&a).effort), ("haiku", None));
    a.on_key(key(KeyCode::Tab));
    assert_eq!(new_worktree(&a).field, Field::Model);
    a.on_key(key(KeyCode::Tab));
    assert_eq!(new_worktree(&a).field, Field::Permission);
}

#[test]
fn changing_model_takes_its_default_effort() {
    let mut a = routing();
    a.on_key(key(KeyCode::Tab));
    a.on_key(key(KeyCode::Tab));
    a.on_key(key(KeyCode::Tab));
    assert_eq!(
        (new_worktree(&a).field, model_name(&a)),
        (Field::Model, "default")
    );
    a.on_key(key(KeyCode::Right));
    assert_eq!(
        (model_name(&a), new_worktree(&a).effort),
        ("fable", Some(Effort::High))
    );
    a.on_key(key(KeyCode::Right));
    assert_eq!(
        (model_name(&a), new_worktree(&a).effort),
        ("opus", Some(Effort::Medium))
    );
    a.on_key(key(KeyCode::Left));
    a.on_key(key(KeyCode::Left));
    a.on_key(key(KeyCode::Left));
    assert_eq!((model_name(&a), new_worktree(&a).effort), ("default", None));
}

#[test]
fn effort_only_walks_levels_the_model_supports() {
    let mut a = routing();
    let id = route_id(&fill(&mut a, "small fix"));
    a.on_route(id, Ok(answers(Size::Scoped, 0.1, Kind::Review, 0.9)));
    assert_eq!(model_name(&a), "gpt-6-luna");
    a.on_key(key(KeyCode::Tab));
    a.on_key(key(KeyCode::Tab));
    assert_eq!(new_worktree(&a).field, Field::Effort);
    for _ in 0..10 {
        a.on_key(key(KeyCode::Right));
    }
    assert_eq!(new_worktree(&a).effort, Some(Effort::Max));
    for _ in 0..10 {
        a.on_key(key(KeyCode::Left));
    }
    assert_eq!(new_worktree(&a).effort, Some(Effort::Low));
}

#[test]
fn agents_without_a_catalog_hide_model_and_do_not_send_the_task() {
    let mut a = routing();
    let id = route_id(&fill(&mut a, "fix login"));
    a.on_route(id, Err(RouteError::Timeout));
    for _ in 0..3 {
        a.on_key(key(KeyCode::Down));
    }
    assert_eq!(agent_name(&a), "opencode");
    assert!(model_options("opencode").is_empty());
    assert!(!task_delivered("opencode") && task_delivered("claude"));
    a.on_key(key(KeyCode::Tab));
    assert_eq!(new_worktree(&a).field, Field::Permission);
    let msg = created(&a.on_key(key(KeyCode::Enter)));
    assert!(matches!(
        msg,
        ClientMsg::CreateWorktree {
            model: None,
            effort: None,
            prompt: None,
            ..
        }
    ));
}

#[test]
fn an_oversized_task_is_refused_with_a_reason() {
    let mut a = routing();
    type_text(&mut a, "fix");
    a.on_key(key(KeyCode::Tab));
    a.on_paste(&"a".repeat(crate::agents::MAX_PROMPT_BYTES + 1));
    a.on_key(key(KeyCode::Tab));
    let actions = a.on_key(key(KeyCode::Enter));
    assert!(sent(&actions).is_empty());
    let d = new_worktree(&a);
    assert_eq!(
        d.error.as_deref(),
        Some("task is too long (max 100,000 bytes)")
    );
    assert_eq!(d.field, Field::Task);
}

#[test]
fn pasted_text_lands_in_the_task_with_normalised_newlines() {
    let mut a = routing();
    a.on_key(key(KeyCode::Tab));
    a.on_paste("a\r\nb\rc\n");
    assert_eq!(new_worktree(&a).task, "a\nb\nc");
}

#[test]
fn enter_while_routing_creates_with_the_current_selection() {
    let mut a = routing();
    fill(&mut a, "fix login");
    let msg = created(&a.on_key(key(KeyCode::Enter)));
    assert!(matches!(
        msg,
        ClientMsg::CreateWorktree { model: None, prompt: Some(p), .. } if p == "fix login"
    ));
}

#[test]
fn clearing_the_task_forgets_the_suggestion() {
    let mut a = routing();
    let id = route_id(&fill(&mut a, "x"));
    a.on_route(id, Ok(answers(Size::Complex, 0.1, Kind::Other, 0.9)));
    a.on_key(key(KeyCode::BackTab));
    a.on_key(key(KeyCode::Backspace));
    assert!(a.on_key(key(KeyCode::Tab)).is_empty());
    assert_eq!(new_worktree(&a).route, Route::Idle);
}

#[test]
fn a_hand_picked_model_keeps_its_agent_when_the_suggestion_arrives() {
    let mut a = routing();
    let id = route_id(&fill(&mut a, "review the auth module"));
    a.on_key(key(KeyCode::Tab));
    a.on_key(key(KeyCode::Right));
    a.on_key(key(KeyCode::Right));
    assert_eq!(
        (agent_name(&a).as_str(), model_name(&a)),
        ("claude", "opus")
    );
    // A sugestão aponta para codex: a escolha feita à mão fica inteira
    a.on_route(id, Ok(answers(Size::Scoped, 0.1, Kind::Review, 0.9)));
    assert_eq!(
        (agent_name(&a).as_str(), model_name(&a)),
        ("claude", "opus")
    );
    assert_eq!(new_worktree(&a).effort, Some(Effort::Medium));
    assert!(matches!(
        &new_worktree(&a).route,
        Route::Suggested { agent, .. } if agent == "codex"
    ));
}

#[test]
fn an_answer_for_text_that_changed_since_is_dropped() {
    let mut a = routing();
    let id = route_id(&fill(&mut a, "fix typo"));
    a.on_key(key(KeyCode::BackTab));
    type_text(&mut a, " and then redesign the whole storage layer");
    // Ainda no campo da tarefa: a resposta é do texto antigo
    a.on_route(id, Ok(answers(Size::Trivial, 0.1, Kind::Review, 0.9)));
    assert_eq!(
        (agent_name(&a).as_str(), model_name(&a)),
        ("claude", "default")
    );
    assert_eq!(new_worktree(&a).route, Route::Idle);
    // Ao sair do campo, o texto novo é consultado
    assert_eq!(route_id(&a.on_key(key(KeyCode::Tab))), 2);
}

/// Pasta temporária com `work/api` e `work/web` como repositórios.
fn repos() -> tempfile::TempDir {
    let tmp = tempfile::TempDir::new().unwrap_or_else(|e| panic!("{e}"));
    for dir in ["work/api/.git", "work/web/.git", "other"] {
        std::fs::create_dir_all(tmp.path().join(dir)).unwrap_or_else(|e| panic!("{e}"));
    }
    tmp
}

fn picker(a: &App) -> &Picker {
    match a.dialog() {
        Some(Dialog::AddProject(p)) => p,
        other => panic!("expected the project picker, got {other:?}"),
    }
}

#[test]
fn the_project_picker_opens_where_lisa_was_started_when_nothing_is_mapped_nearby() {
    let tmp = repos();
    let mut a = app();
    a.set_dirs(tmp.path().join("work"), Some(tmp.path().to_path_buf()));
    a.on_key(key(KeyCode::Char('p')));
    assert_eq!(picker(&a).dir_label(), "~/work/");
}

#[test]
fn the_project_picker_opens_beside_the_last_project_and_marks_it() {
    let tmp = repos();
    let mut a = app();
    a.set_dirs(tmp.path().join("other"), Some(tmp.path().to_path_buf()));
    let mut state = workspace();
    state.projects[1].path = tmp.path().join("work/api").display().to_string();
    a.on_daemon(DaemonMsg::State(state));
    a.on_key(key(KeyCode::Char('p')));
    assert_eq!(picker(&a).dir_label(), "~/work/");
    assert!(
        picker(&a)
            .current()
            .is_some_and(|e| e.name == "api" && e.added)
    );
}

#[test]
fn choosing_a_repository_in_the_picker_adds_it_and_closes_the_dialog() {
    let tmp = repos();
    let mut a = app();
    a.set_dirs(tmp.path().join("work"), None);
    a.on_key(key(KeyCode::Char('p')));
    type_text(&mut a, "we");
    let actions = a.on_key(key(KeyCode::Enter));
    assert_eq!(
        sent(&actions),
        vec![ClientMsg::AddProject {
            path: tmp.path().join("work/web").display().to_string()
        }]
    );
    assert!(a.dialog().is_none());
}

#[test]
fn pasting_a_path_into_the_picker_selects_that_repository() {
    let tmp = repos();
    let mut a = app();
    a.set_dirs(tmp.path().join("other"), None);
    a.on_key(key(KeyCode::Char('p')));
    a.on_paste(&format!("{}/work/api\n", tmp.path().display()));
    assert!(picker(&a).current().is_some_and(|e| e.name == "api"));
}
