use super::*;
use crate::protocol::work::{
    AgentOption, AgentState, CursorPos, DaemonMsg, GroupView, Line, Modes, ProjectView, Snapshot,
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
fn new_worktree_dialog_marks_missing_agents_and_has_no_name_field() {
    let mut a = app(100, 16);
    a.on_key(key(KeyCode::Char('n')));
    a.on_key(key(KeyCode::Enter));
    let screen = text(&a);
    assert!(screen.contains("○ gemini  not installed"), "{screen}");
    assert!(screen.contains("○ opencode  no full autonomy"), "{screen}");
    // O nome é gerado e só se troca depois, com o rename
    for gone in ["Name", "branch:", "· auto", "Task"] {
        assert!(!screen.contains(gone), "{gone:?} in {screen}");
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

/// Diálogo aberto com o roteador disponível, a tarefa digitada e confirmada: já na revisão,
/// com o foco no agente. Devolve o id da consulta pedida ao roteador.
fn with_task(cols: u16, rows: u16, task: &str) -> (App, u64) {
    let mut a = app(cols, rows);
    a.set_router_ready(true);
    a.on_key(key(KeyCode::Char('n')));
    type_in(&mut a, task);
    let id = a
        .on_key(key(KeyCode::Enter))
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

/// Linhas da tela, sem a moldura à direita.
fn screen_lines(a: &App) -> Vec<String> {
    let t = draw(a);
    let area = t.backend().buffer().area;
    (0..area.height)
        .map(|y| row_text(&t, y, area.width))
        .collect()
}

/// Índice da primeira linha que contém `needle`.
fn line_of(lines: &[String], needle: &str) -> usize {
    lines
        .iter()
        .position(|l| l.contains(needle))
        .unwrap_or_else(|| panic!("no {needle:?} in\n{}", lines.join("\n")))
}

#[test]
fn new_worktree_dialog_shows_the_task_field() {
    // Sem o roteador a tarefa também vem primeiro, sozinha
    let mut a = app(100, 24);
    a.on_key(key(KeyCode::Char('n')));
    let screen = text(&a);
    assert!(screen.contains("› Task"), "{screen}");
    assert!(screen.contains("⏎ skip · esc cancel"), "{screen}");
    for later in ["Agent", "Model", "Mode", "⏎ create"] {
        assert!(!screen.contains(later), "{later:?} in {screen}");
    }
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn review_without_a_route_has_no_verdict_and_no_task() {
    let mut a = app(100, 24);
    a.on_key(key(KeyCode::Char('n')));
    type_in(&mut a, "fix login");
    a.on_key(key(KeyCode::Enter));
    let lines = screen_lines(&a);
    let screen = lines.join("\n");
    assert!(
        screen.contains("⏎ create · tab next field · ←→ change · esc cancel"),
        "{screen}"
    );
    for gone in ["Jev", "Task", "fix login", "Name", "branch:"] {
        assert!(!screen.contains(gone), "{gone:?} in {screen}");
    }
    // Sem veredito, o agente é a primeira linha do diálogo
    assert_eq!(
        line_of(&lines, "› Agent"),
        line_of(&lines, "New worktree in api") + 1,
        "{screen}"
    );
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn a_pending_route_says_so_at_the_top() {
    let (a, id) = with_task(100, 24, TASK);
    assert_ne!(id, 0, "no route requested");
    let lines = screen_lines(&a);
    let screen = lines.join("\n");
    assert!(
        lines.iter().any(|l| l.contains("│  asking Jev…")),
        "{screen}"
    );
    assert!(
        line_of(&lines, "asking Jev…") < line_of(&lines, "Agent"),
        "{screen}"
    );
    // A marca não fica mais na linha do agente
    let agent = &lines[line_of(&lines, "● claude")];
    assert!(agent.contains("› Agent   ● claude   "), "{agent:?}");
    assert!(!screen.contains("routing…"), "{screen}");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn a_suggestion_is_one_line_at_the_top_and_fills_the_model() {
    let (mut a, id) = with_task(100, 24, TASK);
    a.on_route(
        id,
        Ok(answers(Size::Complex, 0.9, Kind::Investigation, 0.86)),
    );
    let lines = screen_lines(&a);
    let screen = lines.join("\n");
    assert!(
        screen.contains("│  Jev suggests claude · opus · high · 86% sure"),
        "{screen}"
    );
    assert!(
        line_of(&lines, "Jev suggests") < line_of(&lines, "Agent"),
        "{screen}"
    );
    assert!(!screen.contains("suggested ·"), "{screen}");
    assert!(screen.contains("‹ opus ›   effort ‹ high ›"), "{screen}");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn a_suggestion_for_another_agent_names_only_the_agent() {
    let (mut a, id) = with_task(100, 24, TASK);
    // Escolha feita à mão antes de a resposta chegar
    a.on_key(key(KeyCode::Tab));
    a.on_key(key(KeyCode::Right));
    a.on_key(key(KeyCode::BackTab));
    a.on_key(key(KeyCode::Down));
    a.on_route(
        id,
        Ok(answers(Size::Complex, 0.9, Kind::Investigation, 0.86)),
    );
    let screen = text(&a);
    assert!(screen.contains("● opencode"), "{screen}");
    // Modelo e effort são do agente sugerido, não do que está selecionado
    assert!(
        screen.contains("│  Jev suggests claude · 86% sure"),
        "{screen}"
    );
    assert!(screen.contains("task is not sent to opencode"), "{screen}");
}

#[test]
fn unsure_suggestion_says_so() {
    let (mut a, id) = with_task(100, 24, TASK);
    a.on_route(id, Ok(answers(Size::Scoped, 0.1, Kind::Review, 0.2)));
    let screen = text(&a);
    assert!(
        screen.contains("│  Jev is unsure · using your default"),
        "{screen}"
    );
    assert!(!screen.contains("% sure"), "{screen}");
    assert!(!screen.contains("unsure · your default"), "{screen}");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn failure_reason_sits_at_the_top() {
    let (mut a, id) = with_task(100, 24, TASK);
    a.on_route(id, Err(RouteError::NoKey));
    let lines = screen_lines(&a);
    let screen = lines.join("\n");
    assert!(
        screen.contains("│  no TYPESAFE_API_KEY · choosing manually"),
        "{screen}"
    );
    assert!(
        line_of(&lines, "no TYPESAFE_API_KEY") < line_of(&lines, "Agent"),
        "{screen}"
    );
    assert!(!screen.contains("asking Jev"), "{screen}");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn model_without_effort_hides_the_effort() {
    let (mut a, id) = with_task(100, 24, "rename foo to bar");
    a.on_route(id, Ok(answers(Size::Trivial, 0.1, Kind::Other, 0.9)));
    let screen = text(&a);
    assert!(screen.contains("‹ haiku ›"), "{screen}");
    assert!(!screen.contains("effort"), "{screen}");
    assert!(
        screen.contains("Jev suggests claude · haiku · 90% sure"),
        "{screen}"
    );
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn agent_without_a_catalog_hides_the_model_and_warns() {
    let (mut a, id) = with_task(100, 24, TASK);
    a.on_route(id, Err(RouteError::Timeout));
    a.on_key(key(KeyCode::Down));
    let lines = screen_lines(&a);
    let screen = lines.join("\n");
    assert!(screen.contains("● opencode"), "{screen}");
    assert!(!screen.contains("Model"), "{screen}");
    // O aviso fica logo abaixo do veredito, os dois antes do agente
    let reason = line_of(&lines, "Jev timed out · choosing manually");
    assert_eq!(
        line_of(&lines, "│  task is not sent to opencode"),
        reason + 1,
        "{screen}"
    );
    assert!(reason < line_of(&lines, "Agent"), "{screen}");
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
    a.on_paste("Corrigir a ação de publicação 🚀 que falha em produção quando o usuário não tem permissão\nsegunda linha: validar também o fluxo de reenvio e a paginação da listagem de pedidos");
    let screen = text(&a);
    // Em foco, a tarefa mostra o fim do texto, com o cursor
    assert!(screen.contains("pedidos▏"), "{screen}");
    assert!(!screen.contains('\u{fffd}'), "{screen}");
    insta::assert_snapshot!(draw(&a).backend());
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
    assert!(screen.contains("Jev suggests claude"), "{screen}");
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

// ---- Grupos ----

fn project(slug: &str, group: Option<&str>, tag: &str) -> ProjectView {
    ProjectView {
        slug: slug.into(),
        name: slug.into(),
        path: format!("/r/{slug}"),
        base_branch: "main".into(),
        group: group.map(str::to_owned),
        tag: tag.into(),
    }
}

fn grouped_workspace() -> WorkspaceState {
    WorkspaceState {
        groups: vec![GroupView {
            slug: "b-metric".into(),
            name: "B-Metric".into(),
        }],
        projects: vec![
            project("lisa", None, ""),
            project("b-metric-web", Some("b-metric"), "web"),
            project("bloom", None, ""),
            project("b-metric-api", Some("b-metric"), "api"),
            project("b-metric-consumer", Some("b-metric"), "consumer"),
        ],
        worktrees: vec![
            wt("b-metric-web/dashboard-filter", AgentState::NeedsYou, true),
            wt("b-metric-api/fix-ingest-lag", AgentState::Working, true),
            wt("lisa/sidebar-groups", AgentState::Done, true),
        ],
        agents: workspace().agents,
    }
}

fn grouped(cols: u16, rows: u16, ws: WorkspaceState) -> App {
    let mut a = App::new(cols, rows);
    a.on_focus(true);
    a.on_daemon(DaemonMsg::State(ws));
    a
}

/// Texto de uma linha da tela, da coluna 0 até `width`.
fn row_text(t: &Terminal<TestBackend>, y: u16, width: u16) -> String {
    let buf = t.backend().buffer();
    (0..width)
        .filter_map(|x| buf.cell((x, y)).map(|c| c.symbol().to_owned()))
        .collect()
}

#[test]
fn grouped_agents_carry_a_dim_repository_tag() {
    let a = grouped(100, 14, grouped_workspace());
    let t = draw(&a);
    insta::assert_snapshot!(t.backend());
    assert_eq!(row_text(&t, 2, 28), "   ◉ fix-ingest-lag     api ");
    let buf = t.backend().buffer();
    let cell = buf.cell((24, 2)).unwrap_or_else(|| panic!("cell"));
    assert!(cell.modifier.contains(Modifier::DIM), "tag is not dim");
}

#[test]
fn a_long_agent_name_is_cut_before_the_tag() {
    let mut ws = grouped_workspace();
    ws.worktrees.push(wt(
        "b-metric-consumer/dev-2368-atividades-do-projeto",
        AgentState::Working,
        true,
    ));
    let a = grouped(100, 14, ws);
    let t = draw(&a);
    insta::assert_snapshot!(t.backend());
    assert_eq!(row_text(&t, 3, 29), "   ◉ dev-2368-ati… consumer │");
}

#[test]
fn a_folded_group_shows_its_most_urgent_state() {
    let mut a = grouped(100, 14, grouped_workspace());
    a.select_row(0);
    a.on_key(key(KeyCode::Enter));
    let t = draw(&a);
    insta::assert_snapshot!(t.backend());
    assert_eq!(row_text(&t, 1, 29), "▐▸ B-Metric               ◆ │");
}

#[test]
fn a_group_without_agents_shows_a_hint() {
    let mut ws = grouped_workspace();
    ws.worktrees.retain(|w| w.project == "lisa");
    let a = grouped(100, 14, ws);
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn narrow_terminal_keeps_groups_in_the_glyph_rail() {
    let mut a = grouped(80, 12, grouped_workspace());
    open(&mut a, "b-metric-api/fix-ingest-lag");
    insta::assert_snapshot!(draw(&a).backend());
}

#[test]
fn a_tag_never_reaches_the_separator_and_wide_characters_do_not_panic() {
    let mut ws = grouped_workspace();
    ws.worktrees.push(wt(
        "b-metric-consumer/correção-🚀-login-com-nome-comprido",
        AgentState::Working,
        true,
    ));
    let a = grouped(100, 14, ws);
    let t = draw(&a);
    let buf = t.backend().buffer();
    for y in 0..13 {
        let sep = buf.cell((28, y)).unwrap_or_else(|| panic!("cell"));
        assert_eq!(sep.symbol(), "│", "row {y}");
    }
    let line = row_text(&t, 3, 28);
    assert!(line.contains('…'), "{line}");
    assert!(line.trim_end().ends_with("consumer"), "{line}");
}

// ---- Largura da lateral ----

#[test]
fn sidebar_at_its_narrowest_keeps_the_tag_whole() {
    let mut ws = grouped_workspace();
    ws.worktrees.push(wt(
        "b-metric-consumer/dev-2368-atividades-do-projeto",
        AgentState::Working,
        true,
    ));
    let mut a = grouped(100, 14, ws);
    a.set_sidebar_width(Some(20));
    let t = draw(&a);
    insta::assert_snapshot!(t.backend());
    assert_eq!(row_text(&t, 3, 21), "   ◉ dev-… consumer │");
}

#[test]
fn sidebar_at_its_widest() {
    let mut a = grouped(120, 14, grouped_workspace());
    a.set_sidebar_width(Some(48));
    let t = draw(&a);
    insta::assert_snapshot!(t.backend());
    assert_eq!(a.pane_size(), (71, 13));
}

// ---- Lançar pelo grupo ----

fn text_of(t: &Terminal<TestBackend>) -> String {
    let area = t.backend().buffer().area;
    (0..area.height)
        .map(|y| row_text(t, y, area.width))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn new_worktree_from_a_group_starts_with_the_repo_field() {
    let mut a = grouped(100, 24, grouped_workspace());
    a.select_row(0);
    a.on_key(key(KeyCode::Char('n')));
    a.on_key(key(KeyCode::Enter));
    a.on_key(key(KeyCode::Right));
    let t = draw(&a);
    let screen = text_of(&t);
    assert!(screen.contains("New worktree in B-Metric"), "{screen}");
    assert!(
        screen.contains("› Repo    ‹ consumer ›  2 of 3"),
        "{screen}"
    );
    insta::assert_snapshot!(t.backend());
}

#[test]
fn new_worktree_from_a_group_fits_the_smallest_terminal() {
    let mut a = grouped(60, 12, grouped_workspace());
    a.select_row(0);
    a.on_key(key(KeyCode::Char('n')));
    a.on_key(key(KeyCode::Enter));
    let t = draw(&a);
    let screen = text_of(&t);
    assert!(screen.contains("› Repo    ‹ api ›  1 of 3"), "{screen}");
    assert!(screen.contains("⏎ create"), "{screen}");
    insta::assert_snapshot!(t.backend());
}

// ---- Criar e desfazer grupos ----

fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}

#[test]
fn project_picker_offers_groups_on_a_plain_folder() {
    let tmp = projects_home(0);
    let mut a = picker_app(&tmp, 100, 20);
    type_text(&mut a, "arch");
    let t = draw(&a);
    assert!(text_of(&t).contains("⏎ open · ^f as group · ^n new group · esc cancel"));
    insta::assert_snapshot!(t.backend());
}

#[test]
fn a_folder_without_repositories_says_why_it_cannot_be_a_group() {
    let tmp = projects_home(0);
    let mut a = picker_app(&tmp, 100, 20);
    type_text(&mut a, "arch");
    a.on_key(ctrl('f'));
    let t = draw(&a);
    assert!(text_of(&t).contains("no repositories in this folder"));
    insta::assert_snapshot!(t.backend());
}

#[test]
fn new_group_asks_for_a_name() {
    let tmp = projects_home(0);
    let mut a = picker_app(&tmp, 100, 20);
    a.on_key(ctrl('n'));
    type_text(&mut a, "Glowz");
    let t = draw(&a);
    let screen = text_of(&t);
    assert!(screen.contains("┌ New group "), "{screen}");
    assert!(screen.contains("› Name  Glowz"), "{screen}");
    insta::assert_snapshot!(t.backend());
}

#[test]
fn new_group_marks_repositories_across_folders() {
    let tmp = projects_home(0);
    std::fs::create_dir_all(tmp.path().join("Workspace/archive/old-api/.git"))
        .unwrap_or_else(|e| panic!("{e}"));
    let mut a = picker_app(&tmp, 100, 20);
    a.on_key(ctrl('n'));
    type_text(&mut a, "Glowz");
    a.on_key(key(KeyCode::Enter));
    a.on_key(key(KeyCode::Char(' ')));
    type_text(&mut a, "arch");
    a.on_key(key(KeyCode::Right));
    a.on_key(key(KeyCode::Char(' ')));
    a.on_key(key(KeyCode::Left));
    let t = draw(&a);
    let screen = text_of(&t);
    assert!(screen.contains("Glowz · 2 marked"), "{screen}");
    assert!(screen.contains("✔ glowz"), "{screen}");
    assert!(
        screen.contains("space mark · → open · ← up · ⏎ create · esc cancel"),
        "{screen}"
    );
    insta::assert_snapshot!(t.backend());
}

#[test]
fn new_group_fits_the_smallest_terminal() {
    let tmp = projects_home(12);
    let mut a = picker_app(&tmp, 60, 12);
    a.on_key(ctrl('n'));
    type_text(&mut a, "Glowz");
    a.on_key(key(KeyCode::Enter));
    a.on_key(key(KeyCode::Enter));
    let t = draw(&a);
    let screen = text_of(&t);
    assert!(screen.contains("mark at least one repository"), "{screen}");
    assert!(screen.contains("space mark"), "{screen}");
    insta::assert_snapshot!(t.backend());
}

#[test]
fn ungroup_asks_and_says_nothing_is_deleted() {
    let mut a = grouped(100, 14, grouped_workspace());
    a.select_row(0);
    a.on_key(key(KeyCode::Char('d')));
    let t = draw(&a);
    let screen = text_of(&t);
    assert!(screen.contains("Ungroup B-Metric?"), "{screen}");
    assert!(screen.contains("Nothing is deleted."), "{screen}");
    insta::assert_snapshot!(t.backend());
}

#[test]
fn help_lists_groups_and_resize() {
    let mut a = grouped(100, 24, grouped_workspace());
    a.on_key(key(KeyCode::Char('?')));
    let t = draw(&a);
    let screen = text_of(&t);
    for line in [
        "open worktree / fold project or group",
        "new worktree in this project or group",
        "add project or group",
        "remove worktree / ungroup",
        "resize the sidebar",
    ] {
        assert!(screen.contains(line), "missing {line:?} in {screen}");
    }
    insta::assert_snapshot!(t.backend());
}

// ---- Achados da revisão final ----

#[test]
fn long_tags_keep_their_ends_so_they_stay_apart() {
    let mut ws = grouped_workspace();
    ws.projects.push(project(
        "b-metric-bo-web",
        Some("b-metric"),
        "backoffice-web",
    ));
    ws.projects.push(project(
        "b-metric-bo-api",
        Some("b-metric"),
        "backoffice-api",
    ));
    ws.worktrees
        .push(wt("b-metric-bo-web/a", AgentState::Working, true));
    ws.worktrees
        .push(wt("b-metric-bo-api/b", AgentState::Working, true));
    let a = grouped(100, 14, ws);
    let screen = text_of(&draw(&a));
    assert!(screen.contains("…ice-web"), "{screen}");
    assert!(screen.contains("…ice-api"), "{screen}");
}

#[test]
fn the_footer_says_ungroup_on_a_group_row() {
    let mut a = grouped(100, 14, grouped_workspace());
    a.select_row(0);
    let screen = text_of(&draw(&a));
    assert!(screen.contains("d ungroup"), "{screen}");
    a.select_row(1);
    let screen = text_of(&draw(&a));
    assert!(screen.contains("d remove"), "{screen}");
}

// ---- Tarefa primeiro, nome automático e renomear ----

#[test]
fn with_the_router_the_new_worktree_dialog_asks_only_for_the_task() {
    let mut a = app(100, 20);
    a.set_router_ready(true);
    a.on_key(key(KeyCode::Char('n')));
    type_text(&mut a, "Fix the redirect loop on login");
    let t = draw(&a);
    let screen = text_of(&t);
    assert!(screen.contains("⏎ continue · esc cancel"), "{screen}");
    assert!(!screen.contains("Agent"), "{screen}");
    insta::assert_snapshot!(t.backend());
}

#[test]
fn the_task_step_fits_the_smallest_terminal() {
    let mut a = app(60, 12);
    a.set_router_ready(true);
    a.on_key(key(KeyCode::Char('n')));
    let t = draw(&a);
    let screen = text_of(&t);
    assert!(screen.contains("New worktree in api"), "{screen}");
    assert!(screen.contains("› Task"), "{screen}");
    assert!(screen.contains("⏎ skip · esc cancel"), "{screen}");
    insta::assert_snapshot!(t.backend());
    // Com uma tarefa longa, a dica continua na tela
    a.on_paste(&format!("{TASK}\n{TASK}\n{TASK}\n{TASK}"));
    let screen = text_of(&draw(&a));
    assert!(screen.contains("⏎ continue · esc cancel"), "{screen}");
    assert!(screen.contains("has expired▏"), "{screen}");
}

#[test]
fn the_review_step_fits_the_smallest_terminal() {
    let (mut a, id) = with_task(60, 12, TASK);
    a.on_route(
        id,
        Ok(answers(Size::Complex, 0.9, Kind::Investigation, 0.86)),
    );
    let t = draw(&a);
    let screen = text_of(&t);
    for shown in [
        "New worktree in api",
        "Jev suggests claude · opus · high · 86% sure",
        "› Agent   ● claude",
        "‹ opus ›   effort ‹ high ›",
        "(•) normal",
        // Nessa largura a moldura corta o `cancel` do fim da dica
        "⏎ create · tab next field · ←→ change · esc",
    ] {
        assert!(screen.contains(shown), "missing {shown:?} in\n{screen}");
    }
    insta::assert_snapshot!(t.backend());
    // O pior caso em altura: veredito, aviso de tarefa não enviada e todos os agentes
    a.on_key(key(KeyCode::Down));
    let screen = text_of(&draw(&a));
    for shown in ["● opencode", "task is not sent to opencode", "⏎ create"] {
        assert!(screen.contains(shown), "missing {shown:?} in\n{screen}");
    }
}

#[test]
fn renaming_a_worktree_edits_its_row_and_previews_the_branch_in_the_footer() {
    let mut a = grouped(100, 14, grouped_workspace());
    a.select_row(1);
    a.on_key(key(KeyCode::Char('e')));
    type_text(&mut a, " V2");
    let t = draw(&a);
    let screen = text_of(&t);
    assert!(!screen.contains("┌"), "no box on the agent side: {screen}");
    assert_eq!(row_text(&t, 2, 28).trim_end(), "▐  ◉ fix-ingest-lag V2▏");
    assert!(
        row_text(&t, 13, 100).starts_with(" branch: fix-ingest-lag-v2 · ⏎ rename · esc cancel"),
        "{screen}"
    );
    insta::assert_snapshot!(t.backend());
}

#[test]
fn renaming_a_project_edits_its_row_and_says_the_folder_keeps_its_name() {
    let mut a = grouped(100, 14, grouped_workspace());
    let at = a
        .rows()
        .iter()
        .position(|r| {
            *r == crate::ui::app::Row::Project {
                slug: "lisa".into(),
            }
        })
        .unwrap_or(0);
    a.select_row(at);
    a.on_key(key(KeyCode::Char('e')));
    let t = draw(&a);
    let screen = text_of(&t);
    assert!(screen.contains("▐▾ lisa▏"), "{screen}");
    assert!(
        screen.contains(" ⏎ rename · empty restores the folder name · esc cancel"),
        "{screen}"
    );
}

#[test]
fn a_long_rename_keeps_its_end_and_the_cursor_inside_the_sidebar() {
    let mut a = grouped(100, 14, grouped_workspace());
    a.select_row(1);
    a.on_key(key(KeyCode::Char('e')));
    type_text(&mut a, "-with-a-very-long-name-that-does-not-fit");
    let t = draw(&a);
    let line = row_text(&t, 2, 29);
    assert!(line.ends_with("does-not-fit▏ │"), "{line:?}");
}

#[test]
fn sidebar_keys_sit_under_the_sidebar_and_the_open_agent_moves_right() {
    let mut a = app(120, 14);
    open(&mut a, "api/fix-login");
    a.on_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL));
    let t = draw(&a);
    let footer = row_text(&t, 13, 120);
    assert!(
        footer.starts_with(" ⏎ open · n new · s stop · e rename · d remove · ? keys  "),
        "{footer:?}"
    );
    assert!(
        footer.ends_with("  ^a agent · fix-login · claude "),
        "{footer:?}"
    );
    // Com o foco no agente, a esquerda só diz como voltar ao menu
    a.on_key(key(KeyCode::Esc));
    assert_eq!(a.zone(), Zone::Pane);
    let footer = row_text(&draw(&a), 13, 120);
    assert!(footer.starts_with(" ^a sidebar  "), "{footer:?}");
    assert!(footer.ends_with("  api/fix-login · claude "), "{footer:?}");
}

// ---- Legendas por linha selecionada e dica do painel vazio ----

use crate::ui::app::Row;

/// Legenda da esquerda do rodapé (a tela inteira quando não há agente aberto).
fn footer(a: &App) -> String {
    let (cols, rows) = a.size();
    row_text(&draw(a), rows - 1, cols).trim_end().to_owned()
}

fn select(a: &mut App, row: &Row) {
    let at = a
        .rows()
        .iter()
        .position(|r| r == row)
        .unwrap_or_else(|| panic!("no row {row:?} in {:?}", a.rows()));
    a.select_row(at);
}

fn worktree_row(id: &str) -> Row {
    Row::Worktree { id: id.into() }
}

/// Grupo com agentes, grupo vazio, projeto com agentes e projeto vazio, todos com nome
/// diferente do slug; um worktree parado e um quebrado.
fn every_row_kind() -> App {
    let mut ws = grouped_workspace();
    ws.groups.push(GroupView {
        slug: "acme".into(),
        name: "Acme Corp".into(),
    });
    ws.projects.push(project("acme-api", Some("acme"), "api"));
    for p in &mut ws.projects {
        match p.slug.as_str() {
            "lisa" => p.name = "Lisa CLI".into(),
            "bloom" => p.name = "Bloom App".into(),
            _ => {}
        }
    }
    ws.worktrees
        .push(wt("lisa/stopped-one", AgentState::Idle, false));
    let mut broken = wt("lisa/broken-one", AgentState::Idle, false);
    broken.broken = true;
    ws.worktrees.push(broken);
    grouped(120, 16, ws)
}

#[test]
fn the_sidebar_legend_follows_the_selected_row() {
    let mut a = every_row_kind();
    assert_eq!(a.zone(), Zone::Sidebar);
    let cases = [
        (
            worktree_row("lisa/sidebar-groups"),
            " ⏎ open · n new · s stop · e rename · d remove · ? keys",
        ),
        (
            worktree_row("lisa/stopped-one"),
            " ⏎ open · n new · r restart · e rename · d remove · ? keys",
        ),
        (worktree_row("lisa/broken-one"), " d remove · ? keys"),
        (
            Row::Project {
                slug: "lisa".into(),
            },
            " ⏎ fold · n new · e rename · ? keys",
        ),
        (
            Row::Empty {
                project: "bloom".into(),
            },
            " ⏎ fold · n new · e rename · ? keys",
        ),
        (
            Row::Group {
                slug: "b-metric".into(),
            },
            " ⏎ fold · n new · e rename · d ungroup · ? keys",
        ),
        (
            Row::EmptyGroup {
                group: "acme".into(),
            },
            " ⏎ fold · n new · e rename · d ungroup · ? keys",
        ),
    ];
    for (row, legend) in cases {
        select(&mut a, &row);
        assert_eq!(footer(&a), legend, "{row:?}");
    }
}

#[test]
fn the_legend_without_any_row_says_how_to_add_a_project() {
    let mut a = App::new(100, 12);
    a.on_focus(true);
    a.on_daemon(DaemonMsg::State(WorkspaceState::default()));
    assert_eq!(a.zone(), Zone::Sidebar);
    assert_eq!(footer(&a), " p add a project · ? keys · q quit");
}

#[test]
fn the_right_legend_names_the_open_agent_whatever_row_is_selected() {
    let mut a = every_row_kind();
    select(&mut a, &worktree_row("lisa/sidebar-groups"));
    a.on_key(key(KeyCode::Enter));
    a.on_key(ctrl('a'));
    select(
        &mut a,
        &Row::Group {
            slug: "b-metric".into(),
        },
    );
    let line = footer(&a);
    assert!(
        line.starts_with(" ⏎ fold · n new · e rename · d ungroup · ? keys  "),
        "{line:?}"
    );
    assert!(
        line.ends_with("  ^a agent · sidebar-groups · claude"),
        "{line:?}"
    );
}

#[test]
fn the_pane_legend_says_how_to_reach_the_sidebar_and_names_full_autonomy() {
    let mut ws = workspace();
    ws.worktrees[0].autonomy = true;
    let mut a = App::new(120, 12);
    a.on_focus(true);
    a.on_daemon(DaemonMsg::State(ws));
    open(&mut a, "api/fix-login");
    assert_eq!(a.zone(), Zone::Pane);
    let line = footer(&a);
    assert!(line.starts_with(" ^a sidebar  "), "{line:?}");
    assert!(
        line.ends_with("  api/fix-login · claude · full autonomy"),
        "{line:?}"
    );
    // No menu, a direita troca o caminho pela tecla e pelo nome do worktree
    a.on_key(ctrl('a'));
    let line = footer(&a);
    assert!(
        line.ends_with("  ^a agent · fix-login · claude · full autonomy"),
        "{line:?}"
    );
}

#[test]
fn a_dialog_leaves_no_keys_in_the_left_legend() {
    let mut a = app(120, 14);
    open(&mut a, "api/fix-login");
    a.on_key(ctrl('a'));
    a.on_key(key(KeyCode::Char('n')));
    let line = row_text(&draw(&a), 13, 120);
    assert!(line.starts_with("    "), "{line:?}");
    assert!(!line.contains("? keys"), "{line:?}");
    assert!(!line.contains("^a"), "{line:?}");
    assert!(line.ends_with("  api/fix-login · claude "), "{line:?}");
}

/// Texto do painel do agente, sem a lateral nem o rodapé.
fn pane_text(a: &App) -> String {
    let (cols, rows) = a.size();
    let side = cols - a.pane_size().0;
    let t = draw(a);
    let buf = t.backend().buffer();
    (0..rows - 1)
        .map(|y| {
            (side..cols)
                .filter_map(|x| buf.cell((x, y)).map(|c| c.symbol().to_owned()))
                .collect::<String>()
                .trim()
                .to_owned()
        })
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn the_empty_pane_hint_follows_the_selected_row() {
    let mut a = every_row_kind();
    let cases = [
        (
            worktree_row("lisa/sidebar-groups"),
            "⏎  opens sidebar-groups",
        ),
        (worktree_row("lisa/stopped-one"), "⏎  opens stopped-one"),
        (
            Row::Project {
                slug: "lisa".into(),
            },
            "n  starts a worktree in Lisa CLI",
        ),
        (
            Row::Empty {
                project: "bloom".into(),
            },
            "n  starts a worktree in Bloom App",
        ),
        (
            Row::Group {
                slug: "b-metric".into(),
            },
            "n  starts a worktree in B-Metric",
        ),
        (
            Row::EmptyGroup {
                group: "acme".into(),
            },
            "n  starts a worktree in Acme Corp",
        ),
    ];
    for (row, hint) in cases {
        select(&mut a, &row);
        let pane = pane_text(&a);
        assert!(pane.lines().any(|l| l == hint), "{row:?}: {pane}");
    }
    // Com um diálogo aberto, a dica sai
    a.on_key(key(KeyCode::Char('?')));
    assert!(!text_of(&draw(&a)).contains("n  starts a worktree"));
}

#[test]
fn a_long_empty_pane_hint_is_cut_inside_the_pane() {
    let mut ws = workspace();
    ws.worktrees.push(wt(
        "lisa/a-worktree-with-a-very-long-name-that-cannot-fit-in-the-pane-at-all",
        AgentState::Idle,
        true,
    ));
    let mut a = App::new(100, 12);
    a.on_focus(true);
    a.on_daemon(DaemonMsg::State(ws));
    select(
        &mut a,
        &worktree_row("lisa/a-worktree-with-a-very-long-name-that-cannot-fit-in-the-pane-at-all"),
    );
    let pane = pane_text(&a);
    let hint = pane
        .lines()
        .find(|l| l.starts_with("⏎  opens a-worktree-with"))
        .unwrap_or_default();
    assert!(hint.ends_with('…'), "{pane}");
}

#[test]
fn help_separates_the_sidebar_keys_from_the_ones_that_work_anywhere() {
    let mut a = app(100, 24);
    a.on_key(key(KeyCode::Char('?')));
    let t = draw(&a);
    let screen = text_of(&t);
    let anywhere = screen.find("ANYWHERE").unwrap_or(usize::MAX);
    let sidebar = screen.find("SIDEBAR").unwrap_or(0);
    let prefix = screen.find("send ctrl-a").unwrap_or(0);
    let quit_all = screen.find("stop every agent and quit").unwrap_or(0);
    assert!(
        anywhere < prefix && prefix < sidebar && sidebar < quit_all,
        "{screen}"
    );
    insta::assert_snapshot!(t.backend());
}

#[test]
fn quitting_everything_asks_first_and_says_what_stays() {
    let mut a = app(100, 14);
    a.on_key(key(KeyCode::Char('Q')));
    let t = draw(&a);
    let screen = text_of(&t);
    assert!(screen.contains("Stop 4 agents and quit?"), "{screen}");
    assert!(screen.contains("y stop and quit · esc cancel"), "{screen}");
    insta::assert_snapshot!(t.backend());
}

// ---- Achados da adaptação dos testes ----

#[test]
fn a_tight_footer_drops_middle_keys_and_keeps_help_and_the_open_agent() {
    let mut a = app(80, 14);
    open(&mut a, "api/fix-login");
    a.on_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL));
    let footer = row_text(&draw(&a), 13, 80);
    assert!(footer.starts_with(" ⏎ open · "), "{footer:?}");
    assert!(footer.contains("? keys"), "{footer:?}");
    assert!(
        footer.trim_end().ends_with("^a agent · fix-login · claude"),
        "{footer:?}"
    );
}

#[test]
fn the_review_title_names_the_worktree_that_will_be_created() {
    let mut a = app(100, 24);
    a.on_key(key(KeyCode::Char('n')));
    a.on_key(key(KeyCode::Enter));
    let name = match a.dialog() {
        Some(crate::ui::app::Dialog::NewWorktree(d)) => d.name.clone(),
        other => panic!("no dialog: {other:?}"),
    };
    let screen = text_of(&draw(&a));
    assert!(
        screen.contains(&format!("New worktree in api · {name} ")),
        "{screen}"
    );
}

#[test]
fn in_a_narrow_terminal_the_empty_pane_hint_stays_clear_of_the_sidebar() {
    let mut ws = workspace();
    ws.worktrees = vec![wt(
        "api/a-very-long-name-that-cannot-fit",
        AgentState::Idle,
        true,
    )];
    let mut a = App::new(60, 12);
    a.on_focus(true);
    a.on_daemon(DaemonMsg::State(ws));
    a.select_row(1);
    let screen = text_of(&draw(&a));
    let line = screen
        .lines()
        .find(|l| l.contains("opens "))
        .unwrap_or_default();
    let hint = line.split('│').nth(1).unwrap_or_default();
    assert!(hint.trim_start().starts_with("⏎  opens "), "{screen}");
}

// ---- Histórico ----

#[test]
fn a_scrolled_pane_says_how_far_back_it_is_and_hides_the_cursor() {
    let mut a = app(100, 14);
    open(&mut a, "api/fix-login");
    let (cols, rows) = a.pane_size();
    let mut snapshot = screen_with(&["old line"], cols, rows);
    snapshot.scrolled = 42;
    snapshot.cursor.visible = false;
    a.on_daemon(DaemonMsg::Snapshot {
        pane: "api/fix-login".into(),
        snapshot,
    });
    let t = draw(&a);
    let line = row_text(&t, 12, 100);
    assert!(
        line.contains(" ↑ 42 lines back · scroll down or type to return "),
        "{line:?}"
    );
    insta::assert_snapshot!(t.backend());
}

#[test]
fn removing_a_worktree_without_a_folder_says_only_the_list_changes() {
    let mut ws = workspace();
    let mut gone = wt("api/gone", AgentState::Idle, false);
    gone.broken = true;
    ws.worktrees = vec![gone];
    let mut a = App::new(100, 14);
    a.on_focus(true);
    a.on_daemon(DaemonMsg::State(ws));
    a.select_row(1);
    a.on_key(key(KeyCode::Char('d')));
    let t = draw(&a);
    let screen = text_of(&t);
    assert!(screen.contains("Its folder is already gone."), "{screen}");
    assert!(
        screen.contains("Only the list changes; branch gone is kept."),
        "{screen}"
    );
    assert!(!screen.contains("Deletes the worktree"), "{screen}");
}

// ---- Tela de entrada ----

#[test]
fn the_welcome_screen_shows_the_wordmark_next_steps_and_the_agents() {
    let a = app(120, 30);
    let t = draw(&a);
    let screen = text_of(&t);
    assert!(screen.contains("███████ ██  ███████  ██   ██"), "{screen}");
    assert!(
        screen.contains("Map projects. Run agents. Stay in the terminal."),
        "{screen}"
    );
    assert!(screen.contains("n  starts a worktree in api"), "{screen}");
    assert!(screen.contains("p  adds a project or a group"), "{screen}");
    assert!(screen.contains("?  shows every key"), "{screen}");
    assert!(
        screen.contains("1 needs you · 1 working · 1 done"),
        "{screen}"
    );
    assert!(screen.contains("v0.0.0"), "{screen}");
    insta::assert_snapshot!(t.backend());
}

#[test]
fn the_wordmark_is_yellow_and_only_what_waits_on_the_user_is_red() {
    let a = app(120, 30);
    let t = draw(&a);
    let (x, y) = find(&t, '█').unwrap_or_else(|| panic!("no wordmark"));
    let cell = t
        .backend()
        .buffer()
        .cell((x, y))
        .unwrap_or_else(|| panic!("cell"));
    assert_eq!(cell.fg, TuiColor::Yellow);
    let buf = t.backend().buffer();
    let area = buf.area;
    let red: String = (0..area.height)
        .flat_map(|y| (29..area.width).map(move |x| (x, y)))
        .filter_map(|p| buf.cell(p))
        .filter(|c| c.fg == TuiColor::Red)
        .map(|c| c.symbol().to_owned())
        .collect();
    assert_eq!(red, "1 needs you");
}

#[test]
fn the_welcome_screen_without_projects_says_how_to_add_one() {
    let mut a = App::new(100, 24);
    a.on_focus(true);
    a.on_daemon(DaemonMsg::State(WorkspaceState::default()));
    let screen = text_of(&draw(&a));
    assert!(screen.contains("███████ ██  ███████  ██   ██"), "{screen}");
    assert!(screen.contains("p  adds a project or a group"), "{screen}");
    assert!(!screen.contains("starts a worktree"), "{screen}");
    assert!(!screen.contains("working"), "{screen}");
}

#[test]
fn a_short_terminal_swaps_the_wordmark_for_the_name_and_keeps_the_steps() {
    let a = app(60, 12);
    let t = draw(&a);
    let screen = text_of(&t);
    assert!(!screen.contains('█'), "{screen}");
    assert!(screen.contains("LISA"), "{screen}");
    assert!(screen.contains("?  shows every key"), "{screen}");
    insta::assert_snapshot!(t.backend());
}

#[test]
fn the_welcome_screen_leaves_when_an_agent_or_a_dialog_opens() {
    let mut a = app(120, 30);
    a.on_key(key(KeyCode::Char('?')));
    assert!(!text_of(&draw(&a)).contains("Map projects."));
    a.on_key(key(KeyCode::Esc));
    open(&mut a, "api/fix-login");
    assert!(!text_of(&draw(&a)).contains("Map projects."));
}
