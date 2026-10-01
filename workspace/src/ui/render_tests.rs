use super::*;
use crate::protocol::work::{
    AgentOption, AgentState, CursorPos, DaemonMsg, Line, Modes, ProjectView, Snapshot,
    WorkspaceState, WorktreeView,
};
use crate::ui::app::App;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::style::Color as TuiColor;

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
            ProjectView {
                slug: "lisa".into(),
                name: "lisa".into(),
                path: "/r/lisa".into(),
                base_branch: "main".into(),
                group: None,
                tag: String::new(),
            },
        ],
        worktrees: vec![
            wt("api/fix-login", AgentState::Working, true),
            wt("api/rate-limit", AgentState::NeedsYou, true),
            wt("api/docs-update", AgentState::Idle, true),
            wt("web/new-checkout", AgentState::Done, true),
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

fn screen_with(text: &[&str], cols: u16, rows: u16) -> Snapshot {
    let mut s = crate::ui::app::blank_screen(cols, rows);
    for (r, line) in text.iter().enumerate() {
        for (c, ch) in line.chars().enumerate() {
            if let Some(cell) = s
                .lines
                .get_mut(r)
                .and_then(|l: &mut Line| l.cells.get_mut(c))
            {
                cell.ch = ch;
            }
        }
    }
    s.cursor = CursorPos {
        row: 2,
        col: 2,
        visible: true,
    };
    s.modes = Modes::default();
    s
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn app(cols: u16, rows: u16) -> App {
    let mut a = App::new(cols, rows);
    a.on_focus(true);
    a.on_daemon(DaemonMsg::State(workspace()));
    a
}

fn open(a: &mut App, id: &str) {
    let idx = a
        .rows()
        .iter()
        .position(|r| matches!(r, crate::ui::app::Row::Worktree { id: i } if i == id));
    a.select_row(idx.unwrap_or(0));
    a.on_key(key(KeyCode::Enter));
    let (cols, rows) = a.pane_size();
    a.on_daemon(DaemonMsg::Snapshot {
        pane: id.into(),
        snapshot: screen_with(
            &[
                "> fix the login redirect",
                "⏺ Updating middleware...",
                "✳ Waiting for input",
            ],
            cols,
            rows,
        ),
    });
}

fn draw(a: &App) -> Terminal<TestBackend> {
    let (cols, rows) = a.size();
    let mut t = Terminal::new(TestBackend::new(cols, rows)).unwrap_or_else(|e| panic!("{e}"));
    t.draw(|f| render(f, a)).unwrap_or_else(|e| panic!("{e}"));
    t
}

fn find(t: &Terminal<TestBackend>, needle: char) -> Option<(u16, u16)> {
    let buf = t.backend().buffer();
    let area = buf.area;
    (0..area.height)
        .flat_map(|y| (0..area.width).map(move |x| (x, y)))
        .find(|&(x, y)| {
            buf.cell((x, y))
                .is_some_and(|c| c.symbol().starts_with(needle))
        })
}

#[test]
fn wide_layout_puts_the_sidebar_left_and_the_agent_right() {
    let mut a = app(100, 14);
    open(&mut a, "api/fix-login");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn the_sidebar_starts_at_the_left_edge_and_the_cursor_follows_the_pane() {
    let mut a = app(100, 14);
    open(&mut a, "api/fix-login");
    let mut t = draw(&a);
    assert_eq!(find(&t, 'P'), Some((1, 0)), "PROJECTS label");
    assert_eq!(find(&t, '│'), Some((28, 0)), "separator");
    // O cursor do agente está em (2, 2) dentro do painel, que começa depois do separador
    let cursor = t.get_cursor_position().unwrap_or_else(|e| panic!("{e}"));
    assert_eq!((cursor.x, cursor.y), (31, 2));
}

#[test]
fn narrow_terminal_puts_the_rail_at_the_left_edge() {
    let mut a = app(80, 12);
    open(&mut a, "api/fix-login");
    assert_eq!(find(&draw(&a), '│'), Some((3, 0)));
}

#[test]
fn needs_you_glyph_is_red_and_shape_distinct() {
    let a = app(100, 14);
    let t = draw(&a);
    let (x, y) = find(&t, '◆').unwrap_or_else(|| panic!("no needs-you glyph"));
    assert_eq!(
        t.backend().buffer().cell((x, y)).map(|c| c.fg),
        Some(TuiColor::Red)
    );
}

#[test]
fn sidebar_focus_shows_the_action_hints() {
    let mut a = app(100, 14);
    open(&mut a, "api/fix-login");
    a.on_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL));
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn narrow_terminal_keeps_a_glyph_rail() {
    let mut a = app(80, 12);
    open(&mut a, "api/fix-login");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn empty_workspace_explains_how_to_start() {
    let mut a = App::new(100, 12);
    a.on_daemon(DaemonMsg::State(WorkspaceState::default()));
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn new_worktree_dialog_previews_the_branch_and_marks_missing_agents() {
    let mut a = app(100, 16);
    a.on_key(key(KeyCode::Char('n')));
    for c in "Fix Login!".chars() {
        a.on_key(key(KeyCode::Char(c)));
    }
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn refused_removal_explains_and_offers_force() {
    let mut a = app(100, 14);
    let idx = a
        .rows()
        .iter()
        .position(|r| matches!(r, crate::ui::app::Row::Worktree { id } if id == "api/fix-login"));
    a.select_row(idx.unwrap_or(0));
    a.on_key(key(KeyCode::Char('d')));
    a.on_key(key(KeyCode::Char('y')));
    a.on_daemon(DaemonMsg::RemovalRefused {
        id: "api/fix-login".into(),
        reason: "2 uncommitted change(s)".into(),
    });
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn exited_agent_shows_a_restart_banner() {
    let mut a = App::new(100, 12);
    a.on_focus(true);
    let mut ws = workspace();
    ws.worktrees[0] = wt("api/fix-login", AgentState::Idle, false);
    a.on_daemon(DaemonMsg::State(ws));
    open(&mut a, "api/fix-login");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn full_autonomy_is_named_in_the_footer() {
    let mut a = App::new(100, 12);
    a.on_focus(true);
    let mut ws = workspace();
    ws.worktrees[0].autonomy = true;
    a.on_daemon(DaemonMsg::State(ws));
    open(&mut a, "api/fix-login");
    let t = draw(&a);
    let footer: String = (0..100u16)
        .filter_map(|x| {
            t.backend()
                .buffer()
                .cell((x, 11))
                .map(|c| c.symbol().to_owned())
        })
        .collect();
    assert!(footer.contains("full autonomy"), "{footer}");
}

#[test]
fn tiny_terminal_says_so() {
    let a = app(50, 10);
    insta::assert_snapshot!(draw(&a).backend());
}

// ---- Diálogo de novo worktree com tarefa e sugestão ----

use crate::router::{Answers, Kind, RouteError, Size};
use crate::ui::app::Action;

fn text(a: &App) -> String {
    format!("{}", draw(a).backend())
}

fn type_in(a: &mut App, s: &str) {
    for c in s.chars() {
        a.on_key(key(KeyCode::Char(c)));
    }
}

/// Diálogo aberto, com nome e tarefa digitados e o foco já fora da tarefa.
/// Devolve o id da consulta pedida ao roteador.
fn with_task(cols: u16, rows: u16, task: &str) -> (App, u64) {
    let mut a = app(cols, rows);
    a.on_key(key(KeyCode::Char('n')));
    type_in(&mut a, "fix-login-redirect");
    a.on_key(key(KeyCode::Tab));
    type_in(&mut a, task);
    let id = a
        .on_key(key(KeyCode::Tab))
        .iter()
        .find_map(|x| match x {
            Action::Route { id, .. } => Some(*id),
            _ => None,
        })
        .unwrap_or(0);
    (a, id)
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

const TASK: &str = "Fix the redirect loop on login when the session cookie has expired";

#[test]
fn new_worktree_dialog_shows_the_task_field() {
    let mut a = app(100, 24);
    a.on_key(key(KeyCode::Char('n')));
    let screen = text(&a);
    assert!(screen.contains("Task"), "{screen}");
    assert!(
        screen.contains("⏎ create · tab next field · ←→ change · esc cancel"),
        "{screen}"
    );
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn routing_shows_on_the_selected_agent_row() {
    let (a, _) = with_task(100, 24, TASK);
    let screen = text(&a);
    assert!(screen.contains("● claude  routing…"), "{screen}");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn suggestion_marks_the_agent_and_fills_the_model() {
    let (mut a, id) = with_task(100, 24, TASK);
    a.on_route(
        id,
        Ok(answers(Size::Complex, 0.9, Kind::Investigation, 0.86)),
    );
    let screen = text(&a);
    assert!(screen.contains("● claude  suggested · 86%"), "{screen}");
    assert!(screen.contains("‹ opus ›   effort ‹ high ›"), "{screen}");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn unsure_suggestion_says_so() {
    let (mut a, id) = with_task(100, 24, TASK);
    a.on_route(id, Ok(answers(Size::Scoped, 0.1, Kind::Review, 0.2)));
    let screen = text(&a);
    assert!(
        screen.contains("● claude  unsure · your default"),
        "{screen}"
    );
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn failure_reason_sits_under_the_task() {
    let (mut a, id) = with_task(100, 24, TASK);
    a.on_route(id, Err(RouteError::NoKey));
    let screen = text(&a);
    assert!(
        screen.contains("no TYPESAFE_API_KEY · choosing manually"),
        "{screen}"
    );
    assert!(!screen.contains("routing…"), "{screen}");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn model_without_effort_hides_the_effort() {
    let (mut a, id) = with_task(100, 24, "rename foo to bar");
    a.on_route(id, Ok(answers(Size::Trivial, 0.1, Kind::Other, 0.9)));
    let screen = text(&a);
    assert!(screen.contains("‹ haiku ›"), "{screen}");
    assert!(!screen.contains("effort"), "{screen}");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn agent_without_a_catalog_hides_the_model_and_warns() {
    let (mut a, id) = with_task(100, 24, TASK);
    a.on_route(id, Err(RouteError::Timeout));
    a.on_key(key(KeyCode::Down));
    let screen = text(&a);
    assert!(screen.contains("● opencode"), "{screen}");
    assert!(screen.contains("task is not sent to opencode"), "{screen}");
    assert!(!screen.contains("Model"), "{screen}");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn cost_note_shows_for_models_that_have_one() {
    let (mut a, id) = with_task(100, 26, TASK);
    a.on_route(id, Ok(answers(Size::Open, 0.1, Kind::Other, 0.9)));
    let screen = text(&a);
    assert!(screen.contains("‹ fable ›   effort ‹ high ›"), "{screen}");
    assert!(screen.contains("fable may bill usage credits"), "{screen}");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn long_task_wraps_without_splitting_characters() {
    let mut a = app(100, 26);
    a.on_key(key(KeyCode::Char('n')));
    a.on_key(key(KeyCode::Tab));
    a.on_paste("Corrigir a ação de publicação 🚀 que falha em produção quando o usuário não tem permissão\nsegunda linha: validar também o fluxo de reenvio e a paginação da listagem de pedidos");
    let screen = text(&a);
    // Em foco, a tarefa mostra o fim do texto, com o cursor
    assert!(screen.contains("pedidos▏"), "{screen}");
    assert!(!screen.contains('\u{fffd}'), "{screen}");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn unfocused_long_task_shows_its_start_with_an_ellipsis() {
    let long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five";
    let (a, _) = with_task(100, 26, long);
    let screen = text(&a);
    assert!(screen.contains("one two three"), "{screen}");
    assert!(screen.contains('…'), "{screen}");
    assert!(!screen.contains("twenty-five"), "{screen}");
}

#[test]
fn short_terminal_keeps_the_focused_field_and_the_hints() {
    let (mut a, id) = with_task(100, 14, TASK);
    a.on_route(
        id,
        Ok(answers(Size::Complex, 0.9, Kind::Investigation, 0.86)),
    );
    a.on_key(key(KeyCode::Tab));
    let screen = text(&a);
    assert!(screen.contains("› Model"), "{screen}");
    assert!(screen.contains("‹ opus ›"), "{screen}");
    assert!(screen.contains("● claude"), "{screen}");
    assert!(screen.contains("⏎ create"), "{screen}");
    assert!(screen.contains("New worktree in api"), "{screen}");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn very_short_terminal_still_shows_the_selected_agent_and_the_hints() {
    let (mut a, id) = with_task(100, 12, TASK);
    a.on_route(id, Err(RouteError::Timeout));
    a.on_key(key(KeyCode::Down));
    let screen = text(&a);
    assert!(screen.contains("● opencode"), "{screen}");
    assert!(screen.contains("⏎ create"), "{screen}");
}

/// HOME temporário com `Workspace/` cheio de repositórios e pastas comuns.
fn projects_home(extra: usize) -> tempfile::TempDir {
    let tmp = tempfile::TempDir::new().unwrap_or_else(|e| panic!("{e}"));
    let mut dirs: Vec<String> = [
        "glowz/.git",
        "glowz-api/.git",
        "lisa/.git",
        "archive",
        "notes",
    ]
    .iter()
    .map(|d| format!("Workspace/{d}"))
    .collect();
    dirs.extend((0..extra).map(|i| format!("Workspace/service-{i:02}/.git")));
    for dir in dirs {
        std::fs::create_dir_all(tmp.path().join(dir)).unwrap_or_else(|e| panic!("{e}"));
    }
    tmp
}

fn picker_app(tmp: &tempfile::TempDir, cols: u16, rows: u16) -> App {
    let mut a = app(cols, rows);
    let mut state = workspace();
    state.projects[2].path = tmp.path().join("Workspace/lisa").display().to_string();
    a.on_daemon(DaemonMsg::State(state));
    a.set_dirs(tmp.path().to_path_buf(), Some(tmp.path().to_path_buf()));
    a.on_key(key(KeyCode::Char('p')));
    a
}

fn type_text(a: &mut App, text: &str) {
    for c in text.chars() {
        a.on_key(key(KeyCode::Char(c)));
    }
}

#[test]
fn project_picker_lists_repositories_then_folders_and_marks_mapped_ones() {
    let tmp = projects_home(0);
    let a = picker_app(&tmp, 100, 20);
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn project_picker_narrows_the_list_as_you_type() {
    let tmp = projects_home(0);
    let mut a = picker_app(&tmp, 100, 20);
    type_text(&mut a, "glo");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn project_picker_says_when_nothing_matches() {
    let tmp = projects_home(0);
    let mut a = picker_app(&tmp, 100, 20);
    type_text(&mut a, "zzz");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn project_picker_offers_to_open_a_plain_folder() {
    let tmp = projects_home(0);
    let mut a = picker_app(&tmp, 100, 20);
    type_text(&mut a, "arch");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn project_picker_explains_a_folder_it_cannot_read() {
    let tmp = projects_home(0);
    let mut a = picker_app(&tmp, 100, 20);
    type_text(&mut a, "~/missing/");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn project_picker_windows_a_long_list_around_the_selection() {
    let tmp = projects_home(30);
    let mut a = picker_app(&tmp, 100, 24);
    for _ in 0..14 {
        a.on_key(key(KeyCode::Down));
    }
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn project_picker_fits_the_smallest_terminal() {
    let tmp = projects_home(30);
    let a = picker_app(&tmp, 60, 12);
    insta::assert_snapshot!(draw(&a).backend());
}
