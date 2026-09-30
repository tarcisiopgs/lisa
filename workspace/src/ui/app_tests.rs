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
    a.on_key(key(KeyCode::Tab));
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
