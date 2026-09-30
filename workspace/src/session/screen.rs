//! Tela de um agente, emulada no daemon com `alacritty_terminal`.

use std::sync::{Arc, Mutex, PoisonError};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line as GridLine};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color as VteColor, NamedColor, Processor, Rgb};

pub use crate::protocol::work::{
    ATTR_BOLD, ATTR_DIM, ATTR_HIDDEN, ATTR_INVERSE, ATTR_ITALIC, ATTR_STRIKE, ATTR_UNDERLINE,
    ATTR_WIDE, ATTR_WIDE_SPACER, Cell, Color, CursorPos, Line, Modes, Snapshot, SnapshotDiff,
};

/// Cores respondidas às consultas OSC 10/11/12 (tema escuro neutro).
const FOREGROUND: Rgb = Rgb {
    r: 0xd8,
    g: 0xd8,
    b: 0xd8,
};
const BACKGROUND: Rgb = Rgb {
    r: 0x16,
    g: 0x16,
    b: 0x16,
};
/// Tamanho de célula informado às consultas de pixels (CSI 14t).
const CELL_WIDTH: u16 = 8;
const CELL_HEIGHT: u16 = 16;

#[derive(Clone, Default)]
struct Listener(Arc<Mutex<Vec<Event>>>);

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(event);
    }
}

/// O que um trecho de output produziu além da tela.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct FeedResult {
    /// Bytes a devolver ao PTY (respostas a consultas).
    pub replies: Vec<u8>,
    /// Título novo, se mudou.
    pub title: Option<String>,
    pub bell: bool,
}

pub struct Screen {
    term: Term<Listener>,
    parser: Processor,
    events: Listener,
    title: String,
    cols: u16,
    rows: u16,
}

impl Screen {
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        let events = Listener::default();
        let config = Config {
            scrolling_history: scrollback,
            kitty_keyboard: true,
            ..Config::default()
        };
        let size = TermSize::new(usize::from(cols.max(1)), usize::from(rows.max(1)));
        Screen {
            term: Term::new(config, &size, events.clone()),
            parser: Processor::new(),
            events,
            title: String::new(),
            cols: cols.max(1),
            rows: rows.max(1),
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> FeedResult {
        self.parser.advance(&mut self.term, bytes);
        let events =
            std::mem::take(&mut *self.events.0.lock().unwrap_or_else(PoisonError::into_inner));
        let mut out = FeedResult::default();
        for event in events {
            match event {
                Event::PtyWrite(text) => out.replies.extend(text.into_bytes()),
                Event::Title(title) => {
                    self.title.clone_from(&title);
                    out.title = Some(title);
                }
                Event::ResetTitle => {
                    self.title.clear();
                    out.title = Some(String::new());
                }
                Event::Bell => out.bell = true,
                Event::ColorRequest(index, format) => {
                    out.replies.extend(format(color_for(index)).into_bytes());
                }
                Event::TextAreaSizeRequest(format) => {
                    let size = WindowSize {
                        num_lines: self.rows,
                        num_cols: self.cols,
                        cell_width: CELL_WIDTH,
                        cell_height: CELL_HEIGHT,
                    };
                    out.replies.extend(format(size).into_bytes());
                }
                _ => {}
            }
        }
        out
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        self.term.resize(TermSize::new(
            usize::from(self.cols),
            usize::from(self.rows),
        ));
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    /// Linhas guardadas no scrollback.
    pub fn history_len(&self) -> usize {
        self.term.grid().history_size()
    }

    pub fn snapshot(&self) -> Snapshot {
        let grid = self.term.grid();
        let rows = grid.screen_lines();
        let cols = grid.columns();
        let lines = (0..rows)
            .map(|r| {
                let row = &grid[GridLine(i32::try_from(r).unwrap_or(i32::MAX))];
                Line {
                    cells: (0..cols).map(|c| convert_cell(&row[Column(c)])).collect(),
                }
            })
            .collect();
        let mode = *self.term.mode();
        let point = grid.cursor.point;
        Snapshot {
            cols: self.cols,
            rows: self.rows,
            lines,
            cursor: CursorPos {
                row: u16::try_from(point.line.0.max(0)).unwrap_or(0),
                col: u16::try_from(point.column.0).unwrap_or(0),
                visible: mode.contains(TermMode::SHOW_CURSOR),
            },
            title: self.title.clone(),
            modes: modes(mode),
        }
    }
}

fn modes(mode: TermMode) -> Modes {
    let kitty = [
        TermMode::DISAMBIGUATE_ESC_CODES,
        TermMode::REPORT_EVENT_TYPES,
        TermMode::REPORT_ALTERNATE_KEYS,
        TermMode::REPORT_ALL_KEYS_AS_ESC,
        TermMode::REPORT_ASSOCIATED_TEXT,
    ]
    .iter()
    .enumerate()
    .filter(|(_, flag)| mode.contains(**flag))
    .fold(0u8, |acc, (bit, _)| acc | (1 << bit));
    Modes {
        app_cursor: mode.contains(TermMode::APP_CURSOR),
        bracketed_paste: mode.contains(TermMode::BRACKETED_PASTE),
        mouse_report: mode.intersects(TermMode::MOUSE_MODE),
        sgr_mouse: mode.contains(TermMode::SGR_MOUSE),
        focus_events: mode.contains(TermMode::FOCUS_IN_OUT),
        alt_screen: mode.contains(TermMode::ALT_SCREEN),
        kitty_flags: kitty,
    }
}

fn convert_color(color: VteColor) -> Color {
    match color {
        VteColor::Spec(rgb) => Color::Rgb(rgb.r, rgb.g, rgb.b),
        VteColor::Indexed(i) => Color::Indexed(i),
        VteColor::Named(named) => {
            let n = named as usize;
            if n < 16 {
                Color::Indexed(u8::try_from(n).unwrap_or(0))
            } else if (NamedColor::DimBlack as usize..=NamedColor::DimWhite as usize).contains(&n) {
                Color::Indexed(u8::try_from(n - NamedColor::DimBlack as usize).unwrap_or(0))
            } else {
                Color::Default
            }
        }
    }
}

fn convert_cell(cell: &alacritty_terminal::term::cell::Cell) -> Cell {
    let pairs = [
        (Flags::BOLD, ATTR_BOLD),
        (Flags::ITALIC, ATTR_ITALIC),
        (Flags::ALL_UNDERLINES, ATTR_UNDERLINE),
        (Flags::INVERSE, ATTR_INVERSE),
        (Flags::DIM, ATTR_DIM),
        (Flags::STRIKEOUT, ATTR_STRIKE),
        (Flags::WIDE_CHAR, ATTR_WIDE),
        (Flags::WIDE_CHAR_SPACER, ATTR_WIDE_SPACER),
        (Flags::HIDDEN, ATTR_HIDDEN),
    ];
    let attrs = pairs
        .iter()
        .filter(|(flag, _)| cell.flags.intersects(*flag))
        .fold(0, |acc, (_, attr)| acc | attr);
    Cell {
        ch: cell.c,
        fg: convert_color(cell.fg),
        bg: convert_color(cell.bg),
        attrs,
    }
}

/// Cor para as consultas OSC 4/10/11/12.
fn color_for(index: usize) -> Rgb {
    match index {
        i if i == NamedColor::Foreground as usize || i == NamedColor::Cursor as usize => FOREGROUND,
        i if i == NamedColor::Background as usize => BACKGROUND,
        i => xterm_palette(i),
    }
}

/// Paleta xterm padrão de 256 cores.
fn xterm_palette(index: usize) -> Rgb {
    const BASE: [(u8, u8, u8); 16] = [
        (0, 0, 0),
        (205, 0, 0),
        (0, 205, 0),
        (205, 205, 0),
        (0, 0, 238),
        (205, 0, 205),
        (0, 205, 205),
        (229, 229, 229),
        (127, 127, 127),
        (255, 0, 0),
        (0, 255, 0),
        (255, 255, 0),
        (92, 92, 255),
        (255, 0, 255),
        (0, 255, 255),
        (255, 255, 255),
    ];
    let level = |v: usize| {
        if v == 0 {
            0
        } else {
            u8::try_from(55 + v * 40).unwrap_or(255)
        }
    };
    match index {
        0..=15 => {
            let (r, g, b) = BASE[index];
            Rgb { r, g, b }
        }
        16..=231 => {
            let i = index - 16;
            Rgb {
                r: level(i / 36),
                g: level((i / 6) % 6),
                b: level(i % 6),
            }
        }
        232..=255 => {
            let v = u8::try_from(8 + (index - 232) * 10).unwrap_or(255);
            Rgb { r: v, g: v, b: v }
        }
        _ => FOREGROUND,
    }
}

#[cfg(test)]
#[path = "screen_tests.rs"]
mod tests;
