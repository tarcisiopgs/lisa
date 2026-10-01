use super::*;

fn screen() -> Screen {
    Screen::new(20, 5, 2_000)
}

fn row_text(snap: &Snapshot, row: usize) -> String {
    snap.lines[row]
        .cells
        .iter()
        .map(|c| c.ch)
        .collect::<String>()
        .trim_end()
        .to_owned()
}

#[test]
fn plain_output_lands_on_the_first_row() {
    let mut s = screen();
    s.feed(b"hello");
    assert_eq!(row_text(&s.snapshot(), 0), "hello");
}

#[test]
fn osc_title_is_reported_and_kept() {
    let mut s = screen();
    let out = s.feed(b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
    assert_eq!(out.title.as_deref(), Some("\u{2733} Claude Code"));
    assert_eq!(s.snapshot().title, "\u{2733} Claude Code");
}

#[test]
fn leaving_the_alt_screen_restores_the_main_screen_and_scrollback() {
    let mut s = screen();
    for i in 0..8 {
        s.feed(format!("line{i}\r\n").as_bytes());
    }
    let history = s.history_len();
    assert!(history > 0);
    s.feed(b"\x1b[?1049h\x1b[2Jalt");
    assert!(s.snapshot().modes.alt_screen);
    s.feed(b"\x1b[?1049l");
    let snap = s.snapshot();
    assert!(!snap.modes.alt_screen);
    assert_eq!(row_text(&snap, 0), "line4");
    assert_eq!(s.history_len(), history);
}

#[test]
fn wide_characters_occupy_two_columns() {
    let mut s = screen();
    s.feed("界a".as_bytes());
    let snap = s.snapshot();
    let cells = &snap.lines[0].cells;
    assert_eq!(cells[0].ch, '界');
    assert!(cells[0].attrs & ATTR_WIDE != 0);
    assert_eq!(cells[2].ch, 'a');
}

#[test]
fn cursor_position_query_gets_a_reply() {
    let mut s = screen();
    let out = s.feed(b"ab\x1b[6n");
    assert_eq!(out.replies, b"\x1b[1;3R");
}

#[test]
fn background_color_query_gets_a_reply() {
    let mut s = screen();
    let out = s.feed(b"\x1b]11;?\x07");
    let reply = String::from_utf8_lossy(&out.replies).into_owned();
    assert!(reply.starts_with("\x1b]11;rgb:"), "{reply:?}");
}

#[test]
fn pixel_size_query_gets_a_reply() {
    let mut s = screen();
    let out = s.feed(b"\x1b[14t");
    let reply = String::from_utf8_lossy(&out.replies).into_owned();
    assert!(reply.starts_with("\x1b[4;"), "{reply:?}");
}

#[test]
fn bracketed_paste_mode_is_exposed() {
    let mut s = screen();
    s.feed(b"\x1b[?2004h");
    assert!(s.snapshot().modes.bracketed_paste);
}

#[test]
fn application_cursor_mode_is_exposed() {
    let mut s = screen();
    s.feed(b"\x1b[?1h");
    assert!(s.snapshot().modes.app_cursor);
}

#[test]
fn bell_is_reported() {
    let mut s = screen();
    assert!(s.feed(b"\x07").bell);
}

#[test]
fn a_diff_applied_to_the_previous_snapshot_reproduces_the_current_one() {
    let mut s = screen();
    s.feed(b"first\r\nsecond");
    let before = s.snapshot();
    s.feed(b"\r\nthird\x1b]0;t\x07");
    let after = s.snapshot();
    let diff = after
        .diff(&before)
        .unwrap_or_else(|| panic!("same size must diff"));
    assert_eq!(diff.lines.len(), 1);
    let mut rebuilt = before;
    rebuilt.apply(&diff);
    assert_eq!(rebuilt, after);
}

#[test]
fn resize_changes_the_snapshot_size_and_forces_a_full_snapshot() {
    let mut s = screen();
    let before = s.snapshot();
    s.resize(30, 8);
    let after = s.snapshot();
    assert_eq!((after.cols, after.rows), (30, 8));
    assert!(after.diff(&before).is_none());
}

#[test]
fn scrollback_is_capped() {
    let mut s = Screen::new(20, 5, 100);
    for i in 0..500 {
        s.feed(format!("{i}\r\n").as_bytes());
    }
    assert_eq!(s.history_len(), 100);
}

// ---- Histórico ----

/// Dez linhas numeradas numa tela de cinco: as primeiras vão para o histórico.
fn scrolled_screen() -> Screen {
    let mut s = screen();
    for i in 1..=10 {
        s.feed(format!("line {i}\r\n").as_bytes());
    }
    s
}

#[test]
fn the_view_shows_the_end_until_it_is_scrolled() {
    let s = scrolled_screen();
    let snap = s.snapshot();
    assert_eq!(snap.scrolled, 0);
    assert_eq!(row_text(&snap, 0), "line 7");
}

#[test]
fn scrolling_back_shows_history_and_hides_the_cursor() {
    let mut s = scrolled_screen();
    s.scroll(3);
    let snap = s.snapshot();
    assert_eq!(snap.scrolled, 3);
    assert_eq!(row_text(&snap, 0), "line 4");
    assert_eq!(row_text(&snap, 4), "line 8");
    assert!(!snap.cursor.visible);
}

#[test]
fn scrolling_stops_at_both_ends() {
    let mut s = scrolled_screen();
    s.scroll(1_000);
    let top = s.snapshot();
    assert_eq!(row_text(&top, 0), "line 1");
    assert_eq!(usize::try_from(top.scrolled).unwrap_or(0), s.history_len());
    s.scroll(-1_000);
    assert_eq!(s.snapshot().scrolled, 0);
}

#[test]
fn scrolling_to_the_bottom_returns_to_the_live_screen() {
    let mut s = scrolled_screen();
    s.scroll(4);
    s.scroll_to_bottom();
    let snap = s.snapshot();
    assert_eq!(snap.scrolled, 0);
    assert_eq!(row_text(&snap, 0), "line 7");
}

#[test]
fn output_arriving_while_scrolled_does_not_move_the_view() {
    let mut s = scrolled_screen();
    s.scroll(3);
    s.feed(b"line 11\r\n");
    assert_eq!(row_text(&s.snapshot(), 0), "line 4");
}
