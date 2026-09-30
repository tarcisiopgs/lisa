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
            ProjectView {
                slug: "lisa".into(),
                name: "lisa".into(),
                path: "/r/lisa".into(),
                base_branch: "main".into(),
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
fn wide_layout_puts_the_agent_left_and_the_sidebar_right() {
    let mut a = app(100, 14);
    open(&mut a, "api/fix-login");
    insta::assert_snapshot!(draw(&a).backend());
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
