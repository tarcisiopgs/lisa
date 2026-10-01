use super::*;
use crate::protocol::work::{AgentOption, AgentState, GroupView, ProjectView, WorktreeView};
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
        groups: Vec::new(),
        projects: vec![
            ProjectView {
                slug: "api".into(),
                name: "api".into(),
                path: "/r/api".into(),
                base_branch: "main".into(),
                group: None,
                tag: String::new(),
            },
            ProjectView {
                slug: "web".into(),
                name: "web".into(),
                path: "/r/web".into(),
                base_branch: "main".into(),
                group: None,
                tag: String::new(),
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

// ---- Grupos ----

fn project(slug: &str, name: &str, group: Option<&str>, tag: &str) -> ProjectView {
    ProjectView {
        slug: slug.into(),
        name: name.into(),
        path: format!("/r/{slug}"),
        base_branch: "main".into(),
        group: group.map(str::to_owned),
        tag: tag.into(),
    }
}

fn group(slug: &str, name: &str) -> GroupView {
    GroupView {
        slug: slug.into(),
        name: name.into(),
    }
}

/// Grupo B-Metric (web e api, nessa ordem no registro), mais bloom e Lisa soltos.
fn workspace_with_groups() -> WorkspaceState {
    WorkspaceState {
        groups: vec![group("b-metric", "B-Metric")],
        projects: vec![
            project("lisa", "Lisa", None, ""),
            project("b-metric-web", "b-metric-web", Some("b-metric"), "web"),
            project("bloom", "bloom", None, ""),
            project("b-metric-api", "b-metric-api", Some("b-metric"), "api"),
        ],
        worktrees: vec![
            wt("b-metric-web/dashboard", AgentState::Working, true),
            wt("b-metric-api/ingest", AgentState::NeedsYou, true),
            wt("lisa/sidebar", AgentState::Done, true),
        ],
        agents: workspace().agents,
    }
}

fn grouped() -> App {
    let mut a = App::new(120, 30);
    a.on_focus(true);
    a.on_daemon(DaemonMsg::State(workspace_with_groups()));
    a
}

fn top_level(a: &App) -> Vec<Row> {
    a.rows()
        .into_iter()
        .filter(|r| matches!(r, Row::Group { .. } | Row::Project { .. }))
        .collect()
}

#[test]
fn groups_and_projects_share_one_alphabetical_list() {
    assert_eq!(
        top_level(&grouped()),
        [
            Row::Group {
                slug: "b-metric".into()
            },
            Row::Project {
                slug: "bloom".into()
            },
            Row::Project {
                slug: "lisa".into()
            },
        ]
    );
}

#[test]
fn a_group_lists_its_agents_by_repository_tag() {
    let rows = grouped().rows();
    assert_eq!(
        rows[..3],
        [
            Row::Group {
                slug: "b-metric".into()
            },
            Row::Worktree {
                id: "b-metric-api/ingest".into()
            },
            Row::Worktree {
                id: "b-metric-web/dashboard".into()
            },
        ]
    );
}

#[test]
fn a_repository_without_agents_takes_no_row() {
    let mut ws = workspace_with_groups();
    ws.worktrees.retain(|w| w.project != "b-metric-api");
    let mut a = grouped();
    a.on_daemon(DaemonMsg::State(ws));
    let rows = a.rows();
    assert!(!rows.iter().any(|r| matches!(
        r,
        Row::Project { slug } | Row::Empty { project: slug } if slug.starts_with("b-metric")
    )));
    assert_eq!(
        rows[..2],
        [
            Row::Group {
                slug: "b-metric".into()
            },
            Row::Worktree {
                id: "b-metric-web/dashboard".into()
            },
        ]
    );
}

#[test]
fn a_group_without_agents_shows_one_hint_row() {
    let mut ws = workspace_with_groups();
    ws.worktrees.retain(|w| w.project == "lisa");
    let mut a = grouped();
    a.on_daemon(DaemonMsg::State(ws));
    assert_eq!(
        a.rows()[..3],
        [
            Row::Group {
                slug: "b-metric".into()
            },
            Row::EmptyGroup {
                group: "b-metric".into()
            },
            Row::Project {
                slug: "bloom".into()
            },
        ]
    );
}

#[test]
fn folding_a_group_does_not_fold_a_project_with_the_same_slug() {
    let mut ws = workspace_with_groups();
    ws.groups.push(group("lisa", "Lisa tools"));
    ws.projects
        .push(project("lisa-cli", "lisa-cli", Some("lisa"), "cli"));
    ws.worktrees
        .push(wt("lisa-cli/flags", AgentState::Working, true));
    let mut a = grouped();
    a.on_daemon(DaemonMsg::State(ws));
    let at = a
        .rows()
        .iter()
        .position(|r| {
            *r == Row::Group {
                slug: "lisa".into(),
            }
        })
        .unwrap_or_else(|| panic!("no group row"));
    a.select_row(at);
    a.on_key(key(KeyCode::Enter));
    let rows = a.rows();
    assert!(!rows.contains(&Row::Worktree {
        id: "lisa-cli/flags".into()
    }));
    assert!(rows.contains(&Row::Worktree {
        id: "lisa/sidebar".into()
    }));
}

#[test]
fn the_selection_stays_on_the_same_row_when_groups_arrive() {
    let mut a = grouped();
    select(&mut a, "lisa/sidebar");
    let mut ws = workspace_with_groups();
    ws.groups.push(group("acme", "Acme"));
    ws.projects
        .push(project("acme-api", "acme-api", Some("acme"), "api"));
    a.on_daemon(DaemonMsg::State(ws));
    assert_eq!(
        a.selected_row(),
        Some(Row::Worktree {
            id: "lisa/sidebar".into()
        })
    );
}

#[test]
fn a_project_whose_group_is_gone_is_listed_standalone() {
    let mut ws = workspace_with_groups();
    ws.groups.clear();
    let mut a = grouped();
    a.on_daemon(DaemonMsg::State(ws));
    assert!(a.rows().contains(&Row::Project {
        slug: "b-metric-api".into()
    }));
    let w = wt("b-metric-api/ingest", AgentState::Working, true);
    assert_eq!(a.tag(&w), None);
}

// ---- Largura da lateral ----

fn ch(c: char) -> KeyEvent {
    key(KeyCode::Char(c))
}

#[test]
fn angle_keys_resize_the_sidebar_one_column_and_resize_the_pane() {
    let mut a = app();
    assert_eq!(a.sidebar_width(), SIDEBAR_DEFAULT);
    let actions = a.on_key(ch('>'));
    assert_eq!(a.sidebar_width(), 29);
    assert_eq!(
        actions,
        [
            Action::Send(ClientMsg::Resize { cols: 90, rows: 29 }),
            Action::RememberSidebarWidth(29),
        ]
    );
    let actions = a.on_key(ch('<'));
    assert_eq!(a.sidebar_width(), 28);
    assert_eq!(
        actions,
        [
            Action::Send(ClientMsg::Resize { cols: 91, rows: 29 }),
            Action::RememberSidebarWidth(28),
        ]
    );
}

#[test]
fn the_sidebar_width_stops_at_its_limits() {
    let mut a = app();
    for _ in 0..48 {
        a.on_key(ch('>'));
    }
    assert_eq!(a.sidebar_width(), SIDEBAR_MAX);
    assert!(a.on_key(ch('>')).is_empty());
    for _ in 0..48 {
        a.on_key(ch('<'));
    }
    assert_eq!(a.sidebar_width(), SIDEBAR_MIN);
    assert!(a.on_key(ch('<')).is_empty());
}

#[test]
fn a_stored_width_outside_the_limits_is_clamped() {
    let mut a = app();
    a.set_sidebar_width(Some(200));
    assert_eq!(a.sidebar_width(), SIDEBAR_MAX);
    a.set_sidebar_width(Some(3));
    assert_eq!(a.sidebar_width(), SIDEBAR_MIN);
    a.set_sidebar_width(None);
    assert_eq!(a.sidebar_width(), SIDEBAR_DEFAULT);
}

#[test]
fn the_pane_never_gets_narrower_than_its_minimum() {
    let mut a = App::new(100, 30);
    a.on_focus(true);
    a.on_daemon(DaemonMsg::State(workspace()));
    a.set_sidebar_width(Some(SIDEBAR_MAX));
    let (cols, _) = a.pane_size();
    assert!(cols >= PANE_MIN, "{cols}");
}

#[test]
fn angle_keys_send_nothing_to_the_agent_and_do_nothing_under_a_dialog() {
    let mut a = app();
    open(&mut a, "api/fix-login");
    // No painel, a tecla é do agente
    let actions = a.on_key(ch('>'));
    assert!(matches!(
        sent(&actions).as_slice(),
        [ClientMsg::Input { .. }]
    ));
    assert_eq!(a.sidebar_width(), SIDEBAR_DEFAULT);
    a.on_key(ctrl('a'));
    a.on_key(ch('?'));
    assert!(a.on_key(ch('>')).is_empty());
    assert_eq!(a.sidebar_width(), SIDEBAR_DEFAULT);
}

#[test]
fn in_a_narrow_terminal_the_overlay_resizes_without_resizing_the_pane() {
    let mut a = App::new(80, 20);
    a.on_focus(true);
    a.on_daemon(DaemonMsg::State(workspace()));
    let before = a.pane_size();
    let actions = a.on_key(ch('>'));
    assert_eq!(actions, [Action::RememberSidebarWidth(29)]);
    assert_eq!(a.pane_size(), before);
}

// ---- Lançar pelo grupo ----

fn select_row(a: &mut App, row: &Row) {
    let at = a
        .rows()
        .iter()
        .position(|r| r == row)
        .unwrap_or_else(|| panic!("no row {row:?}"));
    a.select_row(at);
}

fn group_row() -> Row {
    Row::Group {
        slug: "b-metric".into(),
    }
}

#[test]
fn n_on_a_group_asks_for_the_repository_first() {
    let mut a = grouped();
    select_row(&mut a, &group_row());
    a.on_key(ch('n'));
    let d = new_worktree(&a);
    assert_eq!(d.group.as_deref(), Some("b-metric"));
    assert_eq!(d.field, Field::Repo);
    assert_eq!(d.project, "b-metric-api");
}

#[test]
fn n_on_a_grouped_agent_preselects_its_repository() {
    let mut a = grouped();
    select(&mut a, "b-metric-web/dashboard");
    a.on_key(ch('n'));
    let d = new_worktree(&a);
    assert_eq!(d.group.as_deref(), Some("b-metric"));
    assert_eq!(d.project, "b-metric-web");
    assert_eq!(d.field, Field::Name);
}

#[test]
fn n_on_a_standalone_project_has_no_repo_field() {
    let mut a = grouped();
    select(&mut a, "lisa/sidebar");
    a.on_key(ch('n'));
    assert_eq!(new_worktree(&a).group, None);
    for _ in 0..8 {
        a.on_key(key(KeyCode::Tab));
        assert_ne!(new_worktree(&a).field, Field::Repo);
    }
}

#[test]
fn arrows_cycle_the_repositories_and_a_letter_jumps_by_tag() {
    let mut a = grouped();
    select_row(&mut a, &group_row());
    a.on_key(ch('n'));
    a.on_key(key(KeyCode::Right));
    assert_eq!(new_worktree(&a).project, "b-metric-web");
    a.on_key(key(KeyCode::Right));
    assert_eq!(new_worktree(&a).project, "b-metric-api");
    a.on_key(key(KeyCode::Left));
    assert_eq!(new_worktree(&a).project, "b-metric-web");
    a.on_key(ch('A'));
    assert_eq!(new_worktree(&a).project, "b-metric-api");
    a.on_key(ch('w'));
    assert_eq!(new_worktree(&a).project, "b-metric-web");
    // Letra que nenhuma marca usa não muda nada nem vira texto
    a.on_key(ch('z'));
    assert_eq!(new_worktree(&a).project, "b-metric-web");
    assert!(new_worktree(&a).name_auto);
}

#[test]
fn the_last_repository_used_in_a_group_is_offered_first() {
    let mut a = grouped();
    a.set_last_repos(BTreeMap::from([(
        "b-metric".to_owned(),
        "b-metric-web".to_owned(),
    )]));
    select_row(&mut a, &group_row());
    a.on_key(ch('n'));
    assert_eq!(new_worktree(&a).project, "b-metric-web");

    a.on_key(key(KeyCode::Esc));
    a.set_last_repos(BTreeMap::from([(
        "b-metric".to_owned(),
        "bloom".to_owned(),
    )]));
    a.on_key(ch('n'));
    assert_eq!(new_worktree(&a).project, "b-metric-api");
}

#[test]
fn creating_from_a_group_targets_the_chosen_repository_and_remembers_it() {
    let mut a = grouped();
    select_row(&mut a, &group_row());
    a.on_key(ch('n'));
    a.on_key(key(KeyCode::Right));
    a.on_key(key(KeyCode::Tab));
    type_text(&mut a, "filters");
    let actions = a.on_key(key(KeyCode::Enter));
    assert!(matches!(
        sent(&actions).as_slice(),
        [ClientMsg::CreateWorktree { project, name, .. }]
            if project == "b-metric-web" && name == "filters"
    ));
    assert!(actions.contains(&Action::RememberRepo {
        group: "b-metric".into(),
        project: "b-metric-web".into(),
    }));
}

#[test]
fn creating_from_a_standalone_project_remembers_no_repository() {
    let mut a = grouped();
    select(&mut a, "lisa/sidebar");
    a.on_key(ch('n'));
    type_text(&mut a, "x");
    let actions = a.on_key(key(KeyCode::Enter));
    assert!(
        !actions
            .iter()
            .any(|a| matches!(a, Action::RememberRepo { .. }))
    );
}

#[test]
fn a_group_dissolved_under_the_dialog_keeps_the_dialog_on_its_project() {
    let mut a = grouped();
    select_row(&mut a, &group_row());
    a.on_key(ch('n'));
    let mut ws = workspace_with_groups();
    ws.groups.clear();
    for p in &mut ws.projects {
        p.group = None;
        p.tag.clear();
    }
    a.on_daemon(DaemonMsg::State(ws));
    let d = new_worktree(&a);
    assert_eq!(d.group, None);
    assert_eq!(d.project, "b-metric-api");
    assert_eq!(d.field, Field::Name);
}

#[test]
fn a_repository_leaving_the_group_moves_the_dialog_to_the_first_one() {
    let mut a = grouped();
    select_row(&mut a, &group_row());
    a.on_key(ch('n'));
    let mut ws = workspace_with_groups();
    for p in &mut ws.projects {
        if p.slug == "b-metric-api" {
            p.group = None;
            p.tag.clear();
        }
    }
    a.on_daemon(DaemonMsg::State(ws));
    let d = new_worktree(&a);
    assert_eq!(d.group.as_deref(), Some("b-metric"));
    assert_eq!(d.project, "b-metric-web");
}

#[test]
fn a_removed_repository_closes_the_dialog_with_a_notice() {
    let mut a = grouped();
    select_row(&mut a, &group_row());
    a.on_key(ch('n'));
    let mut ws = workspace_with_groups();
    ws.projects.retain(|p| p.slug != "b-metric-api");
    a.on_daemon(DaemonMsg::State(ws));
    assert!(a.dialog().is_none());
    assert!(
        a.notice()
            .is_some_and(|n| n.text.contains("no longer mapped"))
    );
}

// ---- Criar e desfazer grupos ----

#[test]
fn a_group_from_the_picker_is_sent_to_the_daemon() {
    let tmp = tempfile::TempDir::new().unwrap_or_else(|e| panic!("{e}"));
    for dir in ["acme/acme-api/.git", "acme/acme-web/.git"] {
        std::fs::create_dir_all(tmp.path().join(dir)).unwrap_or_else(|e| panic!("{e}"));
    }
    let mut a = App::new(120, 30);
    a.on_focus(true);
    a.set_dirs(tmp.path().to_path_buf(), None);
    a.on_key(ch('p'));
    let actions = a.on_key(ctrl('f'));
    let acme = tmp.path().join("acme");
    assert_eq!(
        sent(&actions),
        [ClientMsg::AddGroup {
            name: "acme".into(),
            paths: vec![
                acme.join("acme-api").display().to_string(),
                acme.join("acme-web").display().to_string(),
            ],
        }]
    );
    assert!(a.dialog().is_none());
}

#[test]
fn d_on_a_group_asks_before_ungrouping_and_y_sends_it() {
    let mut a = grouped();
    select_row(&mut a, &group_row());
    assert!(a.on_key(ch('d')).is_empty());
    assert_eq!(
        a.dialog(),
        Some(&Dialog::ConfirmDissolve {
            group: "b-metric".into()
        })
    );
    let actions = a.on_key(ch('y'));
    assert_eq!(
        sent(&actions),
        [ClientMsg::DissolveGroup {
            group: "b-metric".into()
        }]
    );
    assert!(a.dialog().is_none());

    // Qualquer outra tecla desiste
    a.on_key(ch('d'));
    assert!(a.on_key(ch('n')).is_empty());
    assert!(a.dialog().is_none());
}

#[test]
fn d_on_a_grouped_agent_still_removes_the_worktree() {
    let mut a = grouped();
    select(&mut a, "b-metric-api/ingest");
    a.on_key(ch('d'));
    assert!(matches!(
        a.dialog(),
        Some(Dialog::ConfirmRemove { id, .. }) if id == "b-metric-api/ingest"
    ));
}

// ---- Tarefa primeiro, nome automático e renomear ----

fn routed() -> App {
    let mut a = app();
    a.set_router_ready(true);
    a
}

fn route_of(actions: &[Action]) -> Option<(u64, String)> {
    actions.iter().find_map(|a| match a {
        Action::Route { id, task } => Some((*id, task.clone())),
        _ => None,
    })
}

#[test]
fn without_the_router_the_dialog_opens_complete_with_a_generated_name() {
    let mut a = app();
    a.on_key(ch('n'));
    let d = new_worktree(&a);
    assert_eq!(d.stage, Stage::Review);
    assert_eq!(d.field, Field::Name);
    assert!(d.name_auto);
    assert!(naming::WORDS.contains(&d.name.as_str()), "{}", d.name);
}

#[test]
fn the_generated_name_skips_names_and_branches_already_in_the_project() {
    let mut a = app();
    a.on_key(ch('n'));
    let first = new_worktree(&a).name.clone();
    a.on_key(key(KeyCode::Esc));
    let mut ws = workspace();
    ws.worktrees
        .push(wt(&format!("api/{first}"), AgentState::Idle, true));
    a.on_daemon(DaemonMsg::State(ws));
    a.on_key(ch('n'));
    assert_ne!(new_worktree(&a).name, first);
}

#[test]
fn typing_replaces_a_generated_name_and_then_edits_normally() {
    let mut a = app();
    a.on_key(ch('n'));
    type_text(&mut a, "fix");
    let d = new_worktree(&a);
    assert_eq!(d.name, "fix");
    assert!(!d.name_auto);
    a.on_key(key(KeyCode::Backspace));
    assert_eq!(new_worktree(&a).name, "fi");
}

#[test]
fn backspace_or_a_paste_also_replace_a_generated_name() {
    let mut a = app();
    a.on_key(ch('n'));
    a.on_key(key(KeyCode::Backspace));
    assert_eq!(new_worktree(&a).name, "");
    a.on_key(key(KeyCode::Esc));
    a.on_key(ch('n'));
    a.on_paste("pasted-name");
    assert_eq!(new_worktree(&a).name, "pasted-name");
}

#[test]
fn enter_with_a_generated_name_creates_the_worktree() {
    let mut a = app();
    a.on_key(ch('n'));
    let name = new_worktree(&a).name.clone();
    let actions = a.on_key(key(KeyCode::Enter));
    assert!(matches!(
        sent(&actions).as_slice(),
        [ClientMsg::CreateWorktree { name: n, .. }] if *n == name
    ));
}

#[test]
fn with_the_router_the_dialog_asks_for_the_task_first() {
    let mut a = routed();
    a.on_key(ch('n'));
    let d = new_worktree(&a);
    assert_eq!(d.stage, Stage::Ask);
    assert_eq!(d.field, Field::Task);
    // Tab não sai da tarefa nessa etapa
    a.on_key(key(KeyCode::Tab));
    assert_eq!(new_worktree(&a).field, Field::Task);
    type_text(&mut a, "x");
    assert_eq!(new_worktree(&a).task, "x");
}

#[test]
fn enter_on_the_task_routes_it_and_opens_the_dialog_named_after_it() {
    let mut a = routed();
    a.on_key(ch('n'));
    type_text(&mut a, "Fix the redirect loop on login");
    let actions = a.on_key(key(KeyCode::Enter));
    assert_eq!(
        route_of(&actions).map(|(_, task)| task),
        Some("Fix the redirect loop on login".to_owned())
    );
    assert!(sent(&actions).is_empty(), "nothing is created yet");
    let d = new_worktree(&a);
    assert_eq!(d.stage, Stage::Review);
    assert_eq!(d.field, Field::Name);
    assert_eq!(d.name, "fix-redirect-loop-login");
    assert!(d.name_auto);
    assert!(matches!(d.route, Route::Pending { .. }));
}

#[test]
fn an_empty_task_skips_the_router_and_keeps_the_word_name() {
    let mut a = routed();
    a.on_key(ch('n'));
    let actions = a.on_key(key(KeyCode::Enter));
    assert!(actions.is_empty());
    let d = new_worktree(&a);
    assert_eq!(d.stage, Stage::Review);
    assert!(naming::WORDS.contains(&d.name.as_str()));
    assert_eq!(d.route, Route::Idle);
}

#[test]
fn a_task_name_already_in_use_gets_a_number() {
    let mut a = routed();
    let mut ws = workspace();
    ws.worktrees
        .push(wt("api/fix-login", AgentState::Idle, true));
    a.on_daemon(DaemonMsg::State(ws));
    a.on_key(ch('n'));
    type_text(&mut a, "fix login");
    a.on_key(key(KeyCode::Enter));
    assert_eq!(new_worktree(&a).name, "fix-login-2");
}

#[test]
fn a_name_the_user_typed_is_never_replaced_by_the_task() {
    let mut a = app();
    a.on_key(ch('n'));
    type_text(&mut a, "mine");
    a.on_key(key(KeyCode::Tab));
    type_text(&mut a, "fix the login");
    a.on_key(key(KeyCode::Tab));
    assert_eq!(new_worktree(&a).name, "mine");
}

#[test]
fn editing_the_task_later_renames_a_still_generated_name() {
    let mut a = app();
    a.on_key(ch('n'));
    a.on_key(key(KeyCode::Tab));
    type_text(&mut a, "tune the cache");
    a.on_key(key(KeyCode::Tab));
    assert_eq!(new_worktree(&a).name, "tune-cache");
}

#[test]
fn a_task_from_a_group_goes_to_the_repo_field_next() {
    let mut a = grouped();
    a.set_router_ready(true);
    select_row(&mut a, &group_row());
    a.on_key(ch('n'));
    assert_eq!(new_worktree(&a).stage, Stage::Ask);
    type_text(&mut a, "tune ingest");
    a.on_key(key(KeyCode::Enter));
    let d = new_worktree(&a);
    assert_eq!(d.field, Field::Repo);
    assert_eq!(d.name, "tune-ingest");
}

#[test]
fn a_task_too_long_stays_on_the_task_and_says_why() {
    let mut a = routed();
    a.on_key(ch('n'));
    a.on_paste(&"x".repeat(MAX_PROMPT_BYTES + 1));
    let actions = a.on_key(key(KeyCode::Enter));
    assert!(actions.is_empty());
    let d = new_worktree(&a);
    assert_eq!(d.stage, Stage::Ask);
    assert!(d.error.as_deref().is_some_and(|e| e.contains("too long")));
}

fn rename_dialog(a: &App) -> (&RenameTarget, &str) {
    match a.dialog() {
        Some(Dialog::Rename { target, value }) => (target, value.as_str()),
        other => panic!("no rename dialog: {other:?}"),
    }
}

#[test]
fn e_renames_whatever_row_is_selected_starting_from_its_name() {
    let mut a = grouped();
    select_row(&mut a, &group_row());
    a.on_key(ch('e'));
    assert_eq!(
        rename_dialog(&a),
        (&RenameTarget::Group("b-metric".into()), "B-Metric")
    );
    a.on_key(key(KeyCode::Esc));

    select_row(
        &mut a,
        &Row::Project {
            slug: "lisa".into(),
        },
    );
    a.on_key(ch('e'));
    assert_eq!(
        rename_dialog(&a),
        (&RenameTarget::Project("lisa".into()), "Lisa")
    );
    a.on_key(key(KeyCode::Esc));

    select(&mut a, "lisa/sidebar");
    a.on_key(ch('e'));
    assert_eq!(
        rename_dialog(&a),
        (&RenameTarget::Worktree("lisa/sidebar".into()), "sidebar")
    );
}

#[test]
fn enter_sends_the_new_name_and_closes_the_dialog() {
    let mut a = grouped();
    select(&mut a, "lisa/sidebar");
    a.on_key(ch('e'));
    type_text(&mut a, "-v2");
    let actions = a.on_key(key(KeyCode::Enter));
    assert_eq!(
        sent(&actions),
        [ClientMsg::Rename {
            target: RenameTarget::Worktree("lisa/sidebar".into()),
            name: "sidebar-v2".into(),
        }]
    );
    assert!(a.dialog().is_none());
}

#[test]
fn only_a_project_alias_may_be_cleared() {
    let mut a = grouped();
    select(&mut a, "lisa/sidebar");
    a.on_key(ch('e'));
    for _ in 0.."sidebar".len() {
        a.on_key(key(KeyCode::Backspace));
    }
    assert!(a.on_key(key(KeyCode::Enter)).is_empty());
    assert!(a.dialog().is_some());
    a.on_key(key(KeyCode::Esc));

    select_row(
        &mut a,
        &Row::Project {
            slug: "lisa".into(),
        },
    );
    a.on_key(ch('e'));
    for _ in 0.."Lisa".len() {
        a.on_key(key(KeyCode::Backspace));
    }
    let actions = a.on_key(key(KeyCode::Enter));
    assert_eq!(
        sent(&actions),
        [ClientMsg::Rename {
            target: RenameTarget::Project("lisa".into()),
            name: String::new(),
        }]
    );
}

// ---- Sair ----

#[test]
fn q_quits_at_once_and_says_how_many_agents_keep_running() {
    let mut a = app();
    assert_eq!(a.on_key(ch('q')), [Action::Quit]);
    assert_eq!(
        a.exit_message(),
        Some("3 agents still running · `lisa workspace` returns to them")
    );
}

#[test]
fn q_says_nothing_when_no_agent_is_running() {
    let mut ws = workspace();
    for w in &mut ws.worktrees {
        w.running = false;
    }
    let mut a = app();
    a.on_daemon(DaemonMsg::State(ws));
    assert_eq!(a.on_key(ch('q')), [Action::Quit]);
    assert_eq!(a.exit_message(), None);
    assert_eq!(a.on_key(ch('Q')), [Action::Quit]);
}

#[test]
fn capital_q_asks_then_stops_every_running_agent_and_quits() {
    let mut a = app();
    assert!(a.on_key(ch('Q')).is_empty());
    assert_eq!(a.dialog(), Some(&Dialog::ConfirmQuit { running: 3 }));
    let actions = a.on_key(ch('y'));
    let stopped: Vec<String> = sent(&actions)
        .into_iter()
        .filter_map(|m| match m {
            ClientMsg::StopAgent { id } => Some(id),
            _ => None,
        })
        .collect();
    assert_eq!(stopped, ["api/fix-login", "api/rate-limit", "web/checkout"]);
    assert_eq!(actions.last(), Some(&Action::Quit));
    assert_eq!(a.exit_message(), Some("stopped 3 agents"));
}

#[test]
fn any_other_key_cancels_quitting_everything() {
    let mut a = app();
    a.on_key(ch('Q'));
    assert!(a.on_key(ch('n')).is_empty());
    assert!(a.dialog().is_none());
    assert_eq!(a.exit_message(), None);
}
