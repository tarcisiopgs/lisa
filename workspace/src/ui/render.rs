//! Desenho da UI: lateral estreita à esquerda, agente ocupando o resto da tela,
//! uma linha de rodapé. Cores ANSI nomeadas, como o kanban da Lisa e o devsweep.

use ratatui::Frame;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Color as TuiColor, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Paragraph, Wrap};

use super::app::{
    App, Dialog, Field, MIN_COLS, MIN_ROWS, NewWorktree, NoticeKind, RAIL_WIDTH, Route, Row, Stage,
    Zone, cost_note, effort_options, group_key, model_options, task_delivered,
};
use super::picker::{Mode, Picker};
use crate::protocol::work::{
    ATTR_BOLD, ATTR_DIM, ATTR_HIDDEN, ATTR_INVERSE, ATTR_ITALIC, ATTR_STRIKE, ATTR_UNDERLINE,
    ATTR_WIDE_SPACER, AgentState, Color, RenameTarget, Snapshot, WorktreeView,
};

const SELECT_BAR: &str = "▐";

fn dim() -> Style {
    Style::default().add_modifier(Modifier::DIM)
}

fn bold() -> Style {
    Style::default().add_modifier(Modifier::BOLD)
}

/// Glifo e estilo do estado (forma distinta, não só cor).
pub fn state_glyph(w: &WorktreeView) -> (&'static str, Style) {
    if w.broken {
        return ("⊘", dim());
    }
    if !w.running {
        return match w.exit_code {
            Some(code) if code != 0 => (
                "✖",
                Style::default()
                    .fg(TuiColor::Red)
                    .add_modifier(Modifier::DIM),
            ),
            _ => ("○", dim()),
        };
    }
    match w.state {
        AgentState::Working => ("◉", Style::default().fg(TuiColor::Yellow)),
        AgentState::NeedsYou => (
            "◆",
            Style::default()
                .fg(TuiColor::Red)
                .add_modifier(Modifier::BOLD),
        ),
        AgentState::Done => ("✔", Style::default().fg(TuiColor::Green)),
        AgentState::Idle => ("○", dim()),
    }
}

/// Colunas que a marca do repositório ocupa, no máximo.
pub const TAG_WIDTH: usize = 8;

/// Glifo do estado mais urgente entre os agentes do grupo: precisa de você, trabalhando,
/// concluído. Nada quando todos estão ociosos ou parados.
pub fn group_glyph(app: &App, group: &str) -> Option<(&'static str, Style)> {
    let worktrees = app.group_worktrees(group);
    [AgentState::NeedsYou, AgentState::Working, AgentState::Done]
        .into_iter()
        .find_map(|state| {
            worktrees
                .iter()
                .find(|w| w.running && !w.broken && w.state == state)
                .map(|w| state_glyph(w))
        })
}

/// Largura em colunas do terminal (caracteres largos contam dois).
fn cols(text: &str) -> usize {
    Span::raw(text).width()
}

/// Corta por colunas, sem partir caractere: o que não cabe vira `…`.
fn clip(text: &str, width: usize) -> String {
    if cols(text) <= width {
        return text.to_owned();
    }
    let mut out = String::new();
    for ch in text.chars() {
        let mut next = out.clone();
        next.push(ch);
        if cols(&next) + 1 > width {
            break;
        }
        out = next;
    }
    if width > 0 {
        out.push('…');
    }
    out
}

/// Como `clip`, mas corta o começo: em marcas compridas, é o fim que as distingue.
fn clip_left(text: &str, width: usize) -> String {
    if cols(text) <= width {
        return text.to_owned();
    }
    let mut tail: Vec<char> = Vec::new();
    for ch in text.chars().rev() {
        let mut next = String::from(ch);
        next.extend(tail.iter().rev());
        if cols(&next) + 1 > width {
            break;
        }
        tail.push(ch);
    }
    let kept: String = tail.iter().rev().collect();
    if width > 0 {
        format!("…{kept}")
    } else {
        kept
    }
}

fn truncate(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(width.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let w = width.min(area.width);
    let h = height.min(area.height);
    Rect {
        x: area.x + (area.width - w) / 2,
        y: area.y + (area.height - h) / 2,
        width: w,
        height: h,
    }
}

pub fn render(f: &mut Frame, app: &App) {
    let area = f.area();
    if area.width < MIN_COLS || area.height < MIN_ROWS {
        let msg = format!("Terminal too small (need {MIN_COLS}×{MIN_ROWS})");
        let rect = centered(
            area,
            u16::try_from(msg.chars().count()).unwrap_or(area.width),
            1,
        );
        f.render_widget(Paragraph::new(msg).style(dim()), rect);
        return;
    }

    let body_h = area.height - 1;
    let side_w = if app.wide() {
        app.sidebar_width()
    } else {
        RAIL_WIDTH
    };
    let side = Rect {
        x: 0,
        y: 0,
        width: side_w,
        height: body_h,
    };
    let sep = Rect {
        x: side_w,
        y: 0,
        width: 1,
        height: body_h,
    };
    let pane = Rect {
        x: side_w + 1,
        y: 0,
        width: area.width - side_w - 1,
        height: body_h,
    };
    let footer = Rect {
        x: 0,
        y: body_h,
        width: area.width,
        height: 1,
    };

    render_pane(f, app, pane);
    f.render_widget(
        Paragraph::new(vec![Line::from("│"); usize::from(body_h)]).style(dim()),
        sep,
    );
    if app.wide() {
        render_sidebar(f, app, side);
    } else if app.zone() == Zone::Sidebar {
        // Terminal estreito: a lateral completa aparece por cima do painel enquanto navega
        let full = app.sidebar_width();
        let overlay = Rect {
            x: 0,
            y: 0,
            width: full + 1,
            height: body_h,
        };
        f.render_widget(Clear, overlay);
        f.render_widget(
            Paragraph::new(vec![Line::from("│"); usize::from(body_h)]).style(dim()),
            Rect {
                x: full,
                width: 1,
                ..overlay
            },
        );
        render_sidebar(
            f,
            app,
            Rect {
                width: full,
                ..overlay
            },
        );
    } else {
        render_rail(f, app, side);
    }
    render_footer(f, app, footer);

    // O rename é editado na própria linha do menu: não abre caixa do lado do agente
    if let Some(dialog) = app.dialog().filter(|d| !matches!(d, Dialog::Rename { .. })) {
        // Centralizado no painel: a lateral continua legível atrás do diálogo
        render_dialog(f, app, dialog, pane);
    } else if app.zone() == Zone::Pane
        && let Some(screen) = app.screen()
        && screen.cursor.visible
        && screen.cursor.col < pane.width
        && screen.cursor.row < pane.height
    {
        f.set_cursor_position(Position {
            x: pane.x + screen.cursor.col,
            y: pane.y + screen.cursor.row,
        });
    }
}

fn render_pane(f: &mut Frame, app: &App, pane: Rect) {
    if app.workspace().projects.is_empty() {
        let lines = vec![
            Line::styled("No projects yet", bold()),
            Line::default(),
            Line::from(vec![
                Span::styled("p", bold()),
                Span::styled("  add a project", dim()),
            ]),
        ];
        f.render_widget(Paragraph::new(lines).centered(), centered(pane, 48, 3));
        return;
    }
    let Some(view) = app.focused_view() else {
        if app.dialog().is_none() {
            // A dica fala da linha selecionada, não de um worktree que não está sob o cursor
            let ws = app.workspace();
            let hint = match app.selected_row() {
                _ if app.zone() != Zone::Sidebar => "^a then ⏎ to open a worktree".to_owned(),
                Some(Row::Worktree { id }) => app
                    .worktree(&id)
                    .map(|w| format!("⏎ opens {}", w.name))
                    .unwrap_or_default(),
                Some(Row::Project { slug } | Row::Empty { project: slug }) => ws
                    .projects
                    .iter()
                    .find(|p| p.slug == slug)
                    .map(|p| format!("n starts a worktree in {}", p.name))
                    .unwrap_or_default(),
                Some(Row::Group { slug } | Row::EmptyGroup { group: slug }) => ws
                    .groups
                    .iter()
                    .find(|g| g.slug == slug)
                    .map(|g| format!("n starts a worktree in {}", g.name))
                    .unwrap_or_default(),
                None => String::new(),
            };
            // Em terminal estreito a lateral cobre o começo do painel enquanto se navega
            let covered = if !app.wide() && app.zone() == Zone::Sidebar {
                (app.sidebar_width() + 1).saturating_sub(pane.x)
            } else {
                0
            };
            let visible = Rect {
                x: pane.x + covered,
                width: pane.width.saturating_sub(covered),
                ..pane
            };
            let width = visible.width.saturating_sub(2);
            f.render_widget(
                Paragraph::new(clip(&hint, usize::from(width)))
                    .style(dim())
                    .centered(),
                centered(visible, width, 1),
            );
        }
        return;
    };
    if view.broken {
        let lines = vec![
            Line::styled("Worktree missing on disk", bold()),
            Line::styled("d remove from list", dim()),
        ];
        f.render_widget(Paragraph::new(lines).centered(), centered(pane, 40, 2));
        return;
    }
    if let Some(screen) = app.screen() {
        draw_screen(f, screen, pane, !view.running);
    }
    if !view.running {
        let code = view
            .exit_code
            .map_or_else(String::new, |c| format!(" (code {c})"));
        let banner = Line::from(vec![
            Span::styled(
                format!(" agent exited{code} "),
                Style::default().fg(TuiColor::Red),
            ),
            Span::styled("· ", dim()),
            Span::styled("r", bold()),
            Span::styled(" restart ", dim()),
        ]);
        let row = Rect {
            y: pane.y + pane.height - 1,
            height: 1,
            ..pane
        };
        f.render_widget(Clear, row);
        f.render_widget(Paragraph::new(banner), row);
    }
}

fn to_color(c: Color) -> TuiColor {
    match c {
        Color::Default => TuiColor::Reset,
        Color::Indexed(i) => TuiColor::Indexed(i),
        Color::Rgb(r, g, b) => TuiColor::Rgb(r, g, b),
    }
}

/// Pinta a tela do agente célula a célula.
fn draw_screen(f: &mut Frame, screen: &Snapshot, pane: Rect, faded: bool) {
    let buf = f.buffer_mut();
    for (r, line) in screen
        .lines
        .iter()
        .enumerate()
        .take(usize::from(pane.height))
    {
        let y = pane.y + u16::try_from(r).unwrap_or(0);
        for (c, cell) in line.cells.iter().enumerate().take(usize::from(pane.width)) {
            let x = pane.x + u16::try_from(c).unwrap_or(0);
            let Some(slot) = buf.cell_mut((x, y)) else {
                continue;
            };
            if cell.attrs & ATTR_WIDE_SPACER != 0 {
                slot.set_diff_option(ratatui::buffer::CellDiffOption::Skip);
                continue;
            }
            let mut modifier = Modifier::empty();
            for (attr, m) in [
                (ATTR_BOLD, Modifier::BOLD),
                (ATTR_ITALIC, Modifier::ITALIC),
                (ATTR_UNDERLINE, Modifier::UNDERLINED),
                (ATTR_INVERSE, Modifier::REVERSED),
                (ATTR_DIM, Modifier::DIM),
                (ATTR_STRIKE, Modifier::CROSSED_OUT),
                (ATTR_HIDDEN, Modifier::HIDDEN),
            ] {
                if cell.attrs & attr != 0 {
                    modifier |= m;
                }
            }
            if faded {
                modifier |= Modifier::DIM;
            }
            slot.set_char(cell.ch).set_style(
                Style::default()
                    .fg(to_color(cell.fg))
                    .bg(to_color(cell.bg))
                    .add_modifier(modifier),
            );
        }
    }
}

fn render_sidebar(f: &mut Frame, app: &App, side: Rect) {
    let rows = app.rows();
    let height = usize::from(side.height.saturating_sub(1));
    let offset = app.selected().saturating_sub(height.saturating_sub(1));
    let width = usize::from(side.width);
    let mut lines = vec![Line::styled(
        " PROJECTS",
        dim().add_modifier(Modifier::BOLD),
    )];
    for (i, row) in rows.iter().enumerate().skip(offset).take(height) {
        let selected = i == app.selected();
        let bar = if selected {
            let style = if app.zone() == Zone::Sidebar {
                Style::default().fg(TuiColor::Yellow)
            } else {
                dim()
            };
            Span::styled(SELECT_BAR, style)
        } else {
            Span::raw(" ")
        };
        // Linha em rename: o texto é editado no lugar do nome
        let editing = app.renaming().and_then(|(target, value)| {
            let hit = match (target, row) {
                (RenameTarget::Project(s), Row::Project { slug }) => s == slug,
                (RenameTarget::Group(s), Row::Group { slug }) => s == slug,
                (RenameTarget::Worktree(i), Row::Worktree { id }) => i == id,
                _ => false,
            };
            hit.then_some(value)
        });
        if let Some(value) = editing {
            let lead = if matches!(row, Row::Worktree { .. }) {
                let glyph = match row {
                    Row::Worktree { id } => app.worktree(id).map(state_glyph),
                    _ => None,
                };
                let (glyph, style) = glyph.unwrap_or(("○", dim()));
                vec![Span::raw("  "), Span::styled(glyph, style), Span::raw(" ")]
            } else {
                vec![Span::raw("▾ ")]
            };
            let used: usize = lead.iter().map(|s| s.width()).sum();
            // O fim do texto e o cursor ficam sempre à vista
            let room = width.saturating_sub(used + 3);
            let mut spans = vec![bar];
            spans.extend(lead);
            spans.push(Span::styled(truncate_left(value, room), bold()));
            spans.push(cursor());
            lines.push(Line::from(spans));
            continue;
        }
        let line = match row {
            Row::Group { slug } => {
                let name = app
                    .workspace()
                    .groups
                    .iter()
                    .find(|g| g.slug == *slug)
                    .map_or(slug.as_str(), |g| g.name.as_str());
                let folded = app.is_collapsed(&group_key(slug));
                let arrow = if folded { "▸ " } else { "▾ " };
                // Fechado, o grupo resume os agentes num glifo na última coluna útil
                let summary = folded.then(|| group_glyph(app, slug)).flatten();
                let room = width.saturating_sub(if summary.is_some() { 6 } else { 4 });
                let name = clip(name, room);
                let mut spans = vec![bar, Span::raw(arrow)];
                if let Some((glyph, style)) = summary {
                    let pad = width.saturating_sub(5 + cols(&name));
                    spans.push(Span::styled(name, bold()));
                    spans.push(Span::raw(" ".repeat(pad)));
                    spans.push(Span::styled(glyph, style));
                } else {
                    spans.push(Span::styled(name, bold()));
                }
                Line::from(spans)
            }
            Row::Project { slug } => {
                let name = app
                    .workspace()
                    .projects
                    .iter()
                    .find(|p| p.slug == *slug)
                    .map_or(slug.as_str(), |p| p.name.as_str());
                let arrow = if app.is_collapsed(slug) {
                    "▸ "
                } else {
                    "▾ "
                };
                Line::from(vec![
                    bar,
                    Span::raw(arrow),
                    Span::styled(truncate(name, width.saturating_sub(4)), bold()),
                ])
            }
            Row::Worktree { id } => {
                let Some(w) = app.worktree(id) else { continue };
                let (glyph, style) = state_glyph(w);
                let open = app.focused() == Some(id.as_str());
                let name_style = if w.broken {
                    dim()
                } else if open {
                    bold()
                } else {
                    Style::default()
                };
                let mut spans = vec![
                    bar,
                    Span::raw("  "),
                    Span::styled(glyph, style),
                    Span::raw(" "),
                ];
                match app.tag(w) {
                    // Agente de grupo: a marca do repositório fica inteira, à direita
                    Some(tag) => {
                        let tag = clip_left(tag, TAG_WIDTH);
                        let room = width.saturating_sub(7 + cols(&tag));
                        let name = clip(&w.name, room);
                        let pad = width.saturating_sub(6 + cols(&name) + cols(&tag));
                        spans.push(Span::styled(name, name_style));
                        spans.push(Span::raw(" ".repeat(pad)));
                        spans.push(Span::styled(tag, dim()));
                    }
                    None => spans.push(Span::styled(
                        truncate(&w.name, width.saturating_sub(6)),
                        name_style,
                    )),
                }
                Line::from(spans)
            }
            Row::Empty { .. } => Line::from(vec![bar, Span::styled("  no worktrees · n", dim())]),
            Row::EmptyGroup { .. } => {
                Line::from(vec![bar, Span::styled("  no worktrees · n", dim())])
            }
        };
        lines.push(line);
    }
    f.render_widget(Paragraph::new(lines), side);
}

fn render_rail(f: &mut Frame, app: &App, side: Rect) {
    let rows = app.rows();
    let height = usize::from(side.height.saturating_sub(1));
    let offset = app.selected().saturating_sub(height.saturating_sub(1));
    let mut lines = vec![Line::default()];
    for (i, row) in rows.iter().enumerate().skip(offset).take(height) {
        let bar = if i == app.selected() {
            Span::styled(SELECT_BAR, dim())
        } else {
            Span::raw(" ")
        };
        lines.push(match row {
            Row::Worktree { id } => match app.worktree(id) {
                Some(w) => {
                    let (glyph, style) = state_glyph(w);
                    Line::from(vec![bar, Span::styled(glyph, style)])
                }
                None => Line::default(),
            },
            _ => Line::from(vec![bar, Span::styled("·", dim())]),
        });
    }
    f.render_widget(Paragraph::new(lines), side);
}

fn render_footer(f: &mut Frame, app: &App, footer: Rect) {
    if let Some(notice) = app.notice() {
        let style = match notice.kind {
            NoticeKind::Info => Style::default(),
            NoticeKind::Warn => Style::default().fg(TuiColor::Yellow),
            NoticeKind::Error => Style::default().fg(TuiColor::Red),
        };
        f.render_widget(
            Paragraph::new(format!(" {}", notice.text)).style(style),
            footer,
        );
        return;
    }
    let width = usize::from(footer.width);
    // Rename em andamento: a legenda fala só dele, embaixo do menu onde ele acontece
    if let Some((target, value)) = app.renaming() {
        let text = match target {
            RenameTarget::Worktree(_) => format!(
                " branch: {} · ⏎ rename · esc cancel",
                crate::git::sanitize_branch(value).unwrap_or_else(|_| "—".to_owned())
            ),
            RenameTarget::Project(_) => {
                " ⏎ rename · empty restores the folder name · esc cancel".to_owned()
            }
            RenameTarget::Group(_) => " ⏎ rename · esc cancel".to_owned(),
        };
        f.render_widget(Paragraph::new(truncate(&text, width)).style(dim()), footer);
        return;
    }
    // Duas legendas: à esquerda a do menu, à direita a do agente. A zona em foco mostra o
    // que vale agora para a linha selecionada; a outra, só a tecla que leva até ela.
    let sidebar = app.zone() == Zone::Sidebar;
    let keys: Vec<&str> = match (app.dialog().is_some(), sidebar) {
        (true, _) => Vec::new(),
        (false, false) => vec!["^a sidebar"],
        (false, true) => match app.selected_row() {
            Some(Row::Worktree { id }) => match app.worktree(&id) {
                Some(w) if w.broken => vec!["d remove", "? keys"],
                Some(w) if w.running => {
                    vec![
                        "⏎ open", "n new", "s stop", "e rename", "d remove", "? keys",
                    ]
                }
                _ => vec![
                    "⏎ open",
                    "n new",
                    "r restart",
                    "e rename",
                    "d remove",
                    "? keys",
                ],
            },
            Some(Row::Project { .. } | Row::Empty { .. }) => {
                vec!["⏎ fold", "n new", "e rename", "? keys"]
            }
            Some(Row::Group { .. } | Row::EmptyGroup { .. }) => {
                vec!["⏎ fold", "n new", "e rename", "d ungroup", "? keys"]
            }
            None => vec!["p add a project", "? keys", "q quit"],
        },
    };
    let mut right = Vec::new();
    if let Some(w) = app.focused_view() {
        if sidebar && app.dialog().is_none() {
            right.push(Span::styled("^a agent · ", dim()));
            right.push(Span::raw(w.name.clone()));
        } else {
            right.push(Span::raw(format!("{}/{}", w.project, w.name)));
        }
        if let Some(agent) = &w.agent {
            right.push(Span::styled(format!(" · {agent}"), dim()));
        }
        if w.autonomy {
            right.push(Span::styled(
                " · full autonomy",
                Style::default().fg(TuiColor::Yellow),
            ));
        }
    }
    let right_width: usize = right.iter().map(Span::width).sum();
    // Sem espaço para as duas, a da esquerda perde teclas do meio: a primeira e `? keys`,
    // que leva a todas as outras, ficam. A da direita só some se nem assim couber.
    let join = |keys: &[&str]| keys.join(" · ");
    let mut keys = keys;
    let fits = |keys: &[&str], reserve: usize| 1 + cols(&join(keys)) + reserve < width;
    let reserve = if right_width > 0 { 2 + right_width } else { 1 };
    while keys.len() > 2 && !fits(&keys, reserve) {
        keys.remove(keys.len() - 2);
    }
    let show_right = right_width > 0 && fits(&keys, reserve);
    while keys.len() > 1 && !fits(&keys, 1) {
        keys.remove(keys.len() - 2);
    }
    let text = clip(&join(&keys), width.saturating_sub(2));
    let used = 1 + cols(&text);
    let mut left = vec![Span::raw(" "), Span::styled(text, dim())];
    if show_right {
        left.push(Span::raw(" ".repeat(width - used - right_width - 1)));
        left.extend(right);
    }
    f.render_widget(Paragraph::new(Line::from(left)), footer);
}

fn dialog_block(title: &str) -> Block<'_> {
    Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Plain)
        .title(Span::styled(
            format!(" {title} "),
            Style::default()
                .fg(TuiColor::Cyan)
                .add_modifier(Modifier::BOLD),
        ))
}

fn field_label(label: &str, active: bool) -> Vec<Span<'static>> {
    let marker = if active {
        Span::styled("› ", Style::default().fg(TuiColor::Yellow))
    } else {
        Span::raw("  ")
    };
    vec![
        marker,
        Span::styled(format!("{label:<8}"), if active { bold() } else { dim() }),
    ]
}

/// Largura do diálogo e do texto ao lado dos rótulos.
const DIALOG_WIDTH: u16 = 56;
const LABEL_WIDTH: usize = 10;
/// Linhas que a tarefa ocupa quando há espaço.
const TASK_ROWS: usize = 3;

fn cursor() -> Span<'static> {
    Span::styled("▏", Style::default().fg(TuiColor::Yellow))
}

fn indent() -> Span<'static> {
    Span::raw(" ".repeat(LABEL_WIDTH))
}

/// Quebra a tarefa por largura de exibição (acentos, emoji e CJK contam certo), sem
/// partir caractere; quebras de linha do texto são respeitadas.
fn wrap_task(text: &str, width: usize) -> Vec<String> {
    let mut rows = Vec::new();
    for paragraph in text.split('\n') {
        let mut row = String::new();
        let mut used = 0;
        for word in paragraph.split_inclusive(' ') {
            let w = Span::raw(word).width();
            if used + w > width && used > 0 {
                rows.push(std::mem::take(&mut row));
                used = 0;
            }
            // Palavra maior que a linha: parte entre caracteres
            if w > width {
                for ch in word.chars() {
                    let cw = Span::raw(ch.to_string()).width();
                    if used + cw > width && used > 0 {
                        rows.push(std::mem::take(&mut row));
                        used = 0;
                    }
                    row.push(ch);
                    used += cw;
                }
            } else {
                row.push_str(word);
                used += w;
            }
        }
        rows.push(row);
    }
    rows
}

/// Linhas do campo da tarefa: em foco, o fim do texto com o cursor; fora de foco, o
/// começo, com reticências quando não cabe.
fn task_lines(d: &NewWorktree, width: usize, max: usize) -> Vec<Line<'static>> {
    let active = d.field == Field::Task;
    let label = |i: usize| {
        if i == 0 {
            field_label("Task", active)
        } else {
            vec![indent()]
        }
    };
    if d.task.is_empty() {
        let mut spans = label(0);
        if active {
            spans.push(cursor());
        } else {
            spans.push(Span::styled("what should the agent do? (optional)", dim()));
        }
        return vec![Line::from(spans)];
    }
    // Uma coluna fica para o cursor ou para as reticências
    let rows = wrap_task(&d.task, width.saturating_sub(1).max(1));
    let shown: Vec<String> = if active {
        rows[rows.len().saturating_sub(max)..].to_vec()
    } else {
        let mut head = rows[..rows.len().min(max)].to_vec();
        if rows.len() > max
            && let Some(last) = head.last_mut()
        {
            *last = format!("{}…", last.trim_end());
        }
        head
    };
    let last = shown.len().saturating_sub(1);
    shown
        .into_iter()
        .enumerate()
        .map(|(i, row)| {
            let mut spans = label(i);
            spans.push(Span::raw(row));
            if active && i == last {
                spans.push(cursor());
            }
            Line::from(spans)
        })
        .collect()
}

/// Valor trocável pelas setas: `‹ valor ›`, com as setas acesas quando em foco.
fn stepper(value: &str, active: bool) -> Vec<Span<'static>> {
    let arrow = if active {
        Style::default().fg(TuiColor::Yellow)
    } else {
        dim()
    };
    vec![
        Span::styled("‹ ", arrow),
        Span::styled(
            value.to_owned(),
            if active { bold() } else { Style::default() },
        ),
        Span::styled(" ›", arrow),
    ]
}

/// Linhas do diálogo de novo worktree, encolhendo para caber em `max_lines`: primeiro a
/// tarefa cai para uma linha, depois saem os espaços e, por fim, a lista de agentes vira
/// uma janela em volta do selecionado. O campo em foco e as dicas sempre aparecem.
fn new_worktree(app: &App, d: &NewWorktree, max_lines: u16) -> (String, Vec<Line<'static>>) {
    let project = app
        .workspace()
        .projects
        .iter()
        .find(|p| p.slug == d.project);
    let group = d.group.as_deref().and_then(|slug| {
        app.workspace()
            .groups
            .iter()
            .find(|g| g.slug == slug)
            .map(|g| g.name.as_str())
    });
    let title = format!(
        "New worktree in {}",
        group.unwrap_or(project.map_or(d.project.as_str(), |p| p.name.as_str()))
    );
    // A tarefa vem antes de tudo
    if d.stage == Stage::Ask {
        let text_width = usize::from(DIALOG_WIDTH).saturating_sub(2 + LABEL_WIDTH);
        let mut lines = task_lines(d, text_width, TASK_ROWS);
        lines.push(Line::default());
        lines.push(match &d.error {
            Some(err) => Line::styled(format!("  {err}"), Style::default().fg(TuiColor::Red)),
            // Sem tarefa, o ⏎ só passa adiante: o agente sobe vazio
            None if d.task.trim().is_empty() => Line::styled("  ⏎ skip · esc cancel", dim()),
            None => Line::styled("  ⏎ continue · esc cancel", dim()),
        });
        return (title, lines);
    }
    // O nome já está decidido: aparece no título, e troca-se depois com o rename
    let title = format!("{title} · {}", d.name);
    let agents = app.workspace().agents.len();
    let max = usize::from(max_lines);
    let mut layouts = vec![(agents, true), (agents, false)];
    layouts.extend((1..agents).rev().map(|shown| (shown, false)));
    let mut lines = Vec::new();
    for (agent_rows, spaced) in layouts {
        lines = new_worktree_lines(app, d, agent_rows, spaced);
        if lines.len() <= max {
            break;
        }
    }
    (title, lines)
}

fn new_worktree_lines(
    app: &App,
    d: &NewWorktree,
    agent_rows: usize,
    spaced: bool,
) -> Vec<Line<'static>> {
    let agents = &app.workspace().agents;
    let selected = agents.get(d.agent);
    let selected_name = selected.map_or("", |a| a.name.as_str());
    let mut lines: Vec<Line<'static>> = Vec::new();
    let gap = |lines: &mut Vec<Line<'static>>| {
        if spaced {
            lines.push(Line::default());
        }
    };

    if let Some(group) = d.group.as_deref() {
        let repos = app.group_repos(group);
        let at = repos.iter().position(|p| p.slug == d.project);
        let tag = at.map_or(d.project.as_str(), |i| repos[i].tag.as_str());
        let mut repo = field_label("Repo", d.field == Field::Repo);
        repo.extend(stepper(tag, d.field == Field::Repo));
        if let Some(i) = at {
            repo.push(Span::styled(
                format!("  {} of {}", i + 1, repos.len()),
                dim(),
            ));
        }
        lines.push(Line::from(repo));
        gap(&mut lines);
    }

    // A decisão do roteador em uma linha, antes de tudo: é o que o diálogo já traz feito
    let shown_model = model_options(selected_name).get(d.model).copied();
    let verdict = match &d.route {
        Route::Idle => None,
        Route::Pending { .. } => Some(Line::styled(
            "  asking Jev…",
            Style::default().fg(TuiColor::Yellow),
        )),
        Route::Failed(reason) => Some(Line::styled(format!("  {reason}"), dim())),
        Route::Suggested { unsure: true, .. } => {
            Some(Line::styled("  Jev is unsure · using your default", dim()))
        }
        Route::Suggested { agent, percent, .. } => {
            let mut text = format!("  Jev suggests {agent}");
            // Modelo e effort só valem enquanto o agente sugerido é o selecionado
            if agent == selected_name {
                if let Some(model) = shown_model.filter(|_| d.model > 0) {
                    text.push_str(&format!(" · {model}"));
                }
                if let Some(effort) = d
                    .effort
                    .filter(|_| !effort_options(selected_name, d.model).is_empty())
                {
                    text.push_str(&format!(" · {}", effort.name()));
                }
            }
            text.push_str(&format!(" · {percent}% sure"));
            Some(Line::from(text))
        }
    };
    let has_task = !d.task.trim().is_empty();
    let undelivered = has_task && selected.is_some() && !task_delivered(selected_name);
    if verdict.is_some() || undelivered {
        lines.extend(verdict);
        if undelivered {
            lines.push(Line::styled(
                format!("  task is not sent to {selected_name}"),
                dim(),
            ));
        }
        gap(&mut lines);
    }

    // Janela da lista de agentes em volta do selecionado
    let first = d
        .agent
        .saturating_sub(agent_rows.saturating_sub(1))
        .min(agents.len().saturating_sub(agent_rows));
    for (i, agent) in agents.iter().enumerate().skip(first).take(agent_rows) {
        let mut spans = if i == first {
            field_label("Agent", d.field == Field::Agent)
        } else {
            vec![indent()]
        };
        let chosen = i == d.agent;
        spans.push(Span::styled(
            if chosen { "● " } else { "○ " },
            if chosen {
                Style::default().fg(TuiColor::Yellow)
            } else {
                dim()
            },
        ));
        let style = if !agent.available {
            dim()
        } else if chosen {
            bold()
        } else {
            Style::default()
        };
        spans.push(Span::styled(agent.name.clone(), style));
        if !agent.available {
            spans.push(Span::styled("  not installed", dim()));
        } else if !agent.autonomy_supported {
            spans.push(Span::styled("  no full autonomy", dim()));
        }
        lines.push(Line::from(spans));
    }
    gap(&mut lines);

    let models = model_options(selected_name);
    if let Some(model) = models.get(d.model) {
        let mut spans = field_label("Model", d.field == Field::Model);
        spans.extend(stepper(model, d.field == Field::Model));
        if let Some(effort) = d
            .effort
            .filter(|_| !effort_options(selected_name, d.model).is_empty())
        {
            let active = d.field == Field::Effort;
            spans.push(Span::styled(
                "   effort ",
                if active { bold() } else { dim() },
            ));
            spans.extend(stepper(effort.name(), active));
        }
        lines.push(Line::from(spans));
        if let Some(note) = cost_note(selected_name, d.model) {
            lines.push(Line::from(vec![
                indent(),
                Span::styled(format!("{model} {note}"), dim()),
            ]));
        }
        gap(&mut lines);
    }

    let supported = selected.is_some_and(|a| a.autonomy_supported);
    let mut mode = field_label("Mode", d.field == Field::Permission);
    let radio = |on: bool| if on { "(•) " } else { "( ) " };
    mode.push(Span::raw(format!("{}normal   ", radio(!d.autonomy))));
    let full = format!("{}full autonomy", radio(d.autonomy));
    mode.push(if supported {
        Span::raw(full)
    } else {
        Span::styled(full, dim())
    });
    lines.push(Line::from(mode));
    gap(&mut lines);

    let base = app
        .workspace()
        .projects
        .iter()
        .find(|p| p.slug == d.project)
        .map_or("main", |p| p.base_branch.as_str());
    lines.push(if d.pending {
        Line::styled(
            format!("  creating… fetching {base}"),
            Style::default().fg(TuiColor::Yellow),
        )
    } else if let Some(err) = &d.error {
        Line::styled(format!("  {err}"), Style::default().fg(TuiColor::Red))
    } else {
        Line::styled(
            "  ⏎ create · tab next field · ←→ change · esc cancel",
            dim(),
        )
    });
    lines
}

/// O mesmo que `truncate`, cortando o começo: num caminho, o fim é o que situa.
fn truncate_left(text: &str, width: usize) -> String {
    let len = text.chars().count();
    if len <= width {
        return text.to_owned();
    }
    let tail: String = text.chars().skip(len + 1 - width.max(1)).collect();
    format!("…{tail}")
}

/// Linhas da lista do seletor quando há espaço.
const PICKER_ROWS: usize = 10;

/// Linhas do seletor de projetos. A altura da lista depende só da pasta, não do filtro,
/// para o diálogo não pular enquanto se digita; passando disso, vira janela em volta do
/// selecionado.
fn add_project(p: &Picker, width: u16, max_lines: u16) -> Vec<Line<'static>> {
    let inner = usize::from(width).saturating_sub(2);
    let problem = |p: &Picker| match p.problem() {
        Some(reason) => Line::styled(format!("  {reason}"), Style::default().fg(TuiColor::Red)),
        None => Line::default(),
    };
    if let Mode::GroupName { name } = p.mode() {
        return vec![
            Line::from(vec![
                Span::styled("  › ", Style::default().fg(TuiColor::Yellow)),
                Span::styled("Name  ", bold()),
                Span::raw(truncate_left(name, inner.saturating_sub(12))),
                cursor(),
            ]),
            problem(p),
            Line::styled("  ⏎ next · esc cancel", dim()),
        ];
    }
    let entries = p.visible();
    // Pasta, filtro, dicas e dois espaços são fixos; a lista fica com o resto
    let rows = usize::from(max_lines)
        .saturating_sub(5)
        .min(PICKER_ROWS)
        .min(p.total())
        .max(1);
    let yellow = Style::default().fg(TuiColor::Yellow);

    let mut position = if entries.len() > rows {
        format!("{}/{}", p.selected() + 1, entries.len())
    } else {
        String::new()
    };
    // Grupo em criação: nome e quantos repositórios já foram marcados
    if let Mode::GroupPick { name, marked } = p.mode() {
        let group = format!("{} · {} marked", clip(name, 16), marked.len());
        position = if position.is_empty() {
            group
        } else {
            format!("{group}  {position}")
        };
    }
    let dir = truncate_left(
        &p.dir_label(),
        inner.saturating_sub(4 + position.chars().count()),
    );
    let pad = inner.saturating_sub(3 + dir.chars().count() + position.chars().count());
    let mut lines = vec![
        Line::styled(format!("  {dir}{}{position}", " ".repeat(pad)), dim()),
        Line::from(vec![
            Span::styled("  › ", yellow),
            Span::raw(truncate_left(p.query(), inner.saturating_sub(6))),
            cursor(),
        ]),
        Line::default(),
    ];

    let mut list: Vec<Line<'static>> = Vec::new();
    if let Some(reason) = p.error() {
        list.push(Line::styled(
            format!("  Cannot open this folder: {reason}"),
            Style::default().fg(TuiColor::Red),
        ));
    } else if entries.is_empty() {
        let text = if p.query().is_empty() {
            "  no folders here"
        } else {
            "  no match"
        };
        list.push(Line::styled(text, dim()));
    }
    let first = p
        .selected()
        .saturating_sub(rows.saturating_sub(1))
        .min(entries.len().saturating_sub(rows));
    for (i, entry) in entries.iter().enumerate().skip(first).take(rows) {
        let chosen = i == p.selected();
        let name = if entry.repo {
            entry.name.clone()
        } else {
            format!("{}/", entry.name)
        };
        let mark = if entry.added { "added" } else { "" };
        let room = inner.saturating_sub(8 + mark.len());
        let name = truncate(&name, room);
        let style = match (entry.added, entry.repo, chosen) {
            (true, _, _) | (false, false, false) => dim(),
            (false, true, true) => bold(),
            _ => Style::default(),
        };
        let gap = room.saturating_sub(name.chars().count()) + 1;
        let bullet = if p.is_marked(entry) {
            Span::styled("✔ ", Style::default().fg(TuiColor::Green))
        } else {
            Span::styled(if entry.repo { "● " } else { "  " }, style)
        };
        list.push(Line::from(vec![
            if chosen {
                Span::styled(format!("  {SELECT_BAR} "), yellow)
            } else {
                Span::raw("    ")
            },
            bullet,
            Span::styled(name, style),
            Span::styled(format!("{}{mark}", " ".repeat(gap)), dim()),
        ]));
    }
    list.resize(rows, Line::default());
    lines.extend(list);
    lines.push(problem(p));

    let picking = matches!(p.mode(), Mode::GroupPick { .. });
    let hints = match p.current() {
        _ if picking => "  space mark · → open · ← up · ⏎ create · esc cancel",
        Some(entry) if entry.added => "  already added · → open · ^n new group · esc cancel",
        Some(entry) if entry.repo => "  ⏎ add · → open · ^n new group · esc cancel",
        Some(_) => "  ⏎ open · ^f as group · ^n new group · esc cancel",
        None => "  ← up · ^n new group · esc cancel",
    };
    lines.push(Line::styled(hints, dim()));
    lines
}

fn render_dialog(f: &mut Frame, app: &App, dialog: &Dialog, body: Rect) {
    let width = DIALOG_WIDTH.min(body.width.saturating_sub(4));
    let (title, lines): (String, Vec<Line>) = match dialog {
        Dialog::Help => {
            let section = |name: &'static str| {
                Line::styled(format!("  {name}"), dim().add_modifier(Modifier::BOLD))
            };
            let key = |(k, v): &(&'static str, &'static str)| {
                Line::from(vec![
                    Span::styled(format!("  {k:<8}"), bold()),
                    Span::styled(*v, dim()),
                ])
            };
            let mut lines = vec![section("ANYWHERE")];
            lines.extend(
                [
                    ("^a", "switch between the agent and the sidebar"),
                    ("^a ^a", "send ctrl-a to the agent"),
                ]
                .iter()
                .map(key),
            );
            lines.push(Line::default());
            lines.push(section("SIDEBAR"));
            lines.extend(
                [
                    ("↑↓ j k", "move"),
                    ("⏎", "open worktree / fold project or group"),
                    ("tab", "next worktree that needs you"),
                    ("n", "new worktree in this project or group"),
                    ("p", "add project or group"),
                    ("e", "rename project, group or worktree"),
                    ("b", "change base branch"),
                    ("d", "remove worktree / ungroup"),
                    ("r / s", "restart / stop agent"),
                    ("< >", "resize the sidebar"),
                    ("q", "quit (agents keep running)"),
                    ("Q", "stop every agent and quit"),
                ]
                .iter()
                .map(key),
            );
            ("Keys".into(), lines)
        }
        // Editado na linha do menu; `render` não chama este desenho para ele
        Dialog::Rename { .. } => return,
        Dialog::ConfirmQuit { running } => (
            "Quit".into(),
            vec![
                Line::from(vec![
                    Span::raw("  Stop "),
                    Span::styled(
                        if *running == 1 {
                            "1 agent".to_owned()
                        } else {
                            format!("{running} agents")
                        },
                        bold(),
                    ),
                    Span::raw(" and quit?"),
                ]),
                Line::styled("  Worktrees and branches are kept.", dim()),
                Line::default(),
                Line::styled("  y stop and quit · esc cancel", dim()),
            ],
        ),
        Dialog::ConfirmDissolve { group } => {
            let name = app
                .workspace()
                .groups
                .iter()
                .find(|g| g.slug == *group)
                .map_or(group.as_str(), |g| g.name.as_str());
            (
                "Ungroup".into(),
                vec![
                    Line::from(vec![
                        Span::raw("  Ungroup "),
                        Span::styled(name.to_owned(), bold()),
                        Span::raw("?"),
                    ]),
                    Line::styled("  Its repositories become standalone projects.", dim()),
                    Line::styled("  Nothing is deleted.", dim()),
                    Line::default(),
                    Line::styled("  y ungroup · esc cancel", dim()),
                ],
            )
        }
        Dialog::AddProject(picker) => (
            match picker.mode() {
                Mode::Project => "Add project",
                Mode::GroupName { .. } | Mode::GroupPick { .. } => "New group",
            }
            .into(),
            add_project(picker, width, body.height.saturating_sub(2)),
        ),
        Dialog::BaseBranch { project, value } => (
            format!("Base branch for {project}"),
            vec![
                Line::styled("  New worktrees start from this branch", dim()),
                Line::from(vec![
                    Span::raw("  "),
                    Span::raw(value.clone()),
                    Span::styled("▏", Style::default().fg(TuiColor::Yellow)),
                ]),
                Line::default(),
                Line::styled("  ⏎ save · esc cancel", dim()),
            ],
        ),
        Dialog::ConfirmRemove { id, sent, refused } => {
            let w = app.worktree(id);
            let name = w.map_or(id.as_str(), |w| w.name.as_str());
            let branch = w.map_or(id.as_str(), |w| w.branch.as_str());
            let mut lines = vec![
                Line::from(vec![
                    Span::raw("  Remove "),
                    Span::styled(name.to_owned(), bold()),
                    Span::raw("?"),
                ]),
                Line::styled(
                    format!("  Deletes the worktree and the local branch {branch}."),
                    dim(),
                ),
                Line::styled("  The remote branch is kept.", dim()),
                Line::default(),
            ];
            match (sent, refused) {
                (_, Some(reason)) => {
                    lines.push(Line::styled(
                        format!("  Refused: {reason}"),
                        Style::default().fg(TuiColor::Red),
                    ));
                    lines.push(Line::styled("  f force · esc cancel", dim()));
                }
                (true, None) => lines.push(Line::styled(
                    "  removing…",
                    Style::default().fg(TuiColor::Yellow),
                )),
                (false, None) => lines.push(Line::styled("  y remove · n cancel", dim())),
            }
            ("Remove worktree".into(), lines)
        }
        Dialog::NewWorktree(d) => new_worktree(app, d, body.height.saturating_sub(2)),
    };
    let height = u16::try_from(lines.len()).unwrap_or(0) + 2;
    let rect = centered(body, width, height);
    f.render_widget(Clear, rect);
    f.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .block(dialog_block(&title)),
        rect,
    );
}

#[cfg(test)]
#[path = "render_tests.rs"]
mod tests;
