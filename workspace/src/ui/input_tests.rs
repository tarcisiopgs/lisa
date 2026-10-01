use super::*;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn modes() -> Modes {
    Modes::default()
}

#[test]
fn plain_character_is_sent_as_utf8() {
    assert_eq!(
        encode_key(key(KeyCode::Char('ã')), &modes()),
        "ã".as_bytes()
    );
}

#[test]
fn enter_sends_carriage_return() {
    assert_eq!(encode_key(key(KeyCode::Enter), &modes()), b"\r");
}

#[test]
fn ctrl_c_sends_etx() {
    assert_eq!(
        encode_key(
            KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
            &modes()
        ),
        [3]
    );
}

#[test]
fn arrow_in_normal_cursor_mode_uses_csi() {
    assert_eq!(encode_key(key(KeyCode::Up), &modes()), b"\x1b[A");
}

#[test]
fn arrow_in_application_cursor_mode_uses_ss3() {
    let m = Modes {
        app_cursor: true,
        ..Modes::default()
    };
    assert_eq!(encode_key(key(KeyCode::Up), &m), b"\x1bOA");
}

#[test]
fn modified_arrow_keeps_csi_even_in_application_mode() {
    let m = Modes {
        app_cursor: true,
        ..Modes::default()
    };
    assert_eq!(
        encode_key(KeyEvent::new(KeyCode::Right, KeyModifiers::SHIFT), &m),
        b"\x1b[1;2C"
    );
}

#[test]
fn shift_enter_uses_csi_u_when_the_agent_enabled_kitty_disambiguation() {
    let m = Modes {
        kitty_flags: 1,
        ..Modes::default()
    };
    assert_eq!(
        encode_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT), &m),
        b"\x1b[13;2u"
    );
}

#[test]
fn paste_is_wrapped_when_bracketed_paste_is_on() {
    let m = Modes {
        bracketed_paste: true,
        ..Modes::default()
    };
    assert_eq!(encode_paste("a\nb", &m), b"\x1b[200~a\nb\x1b[201~");
}

#[test]
fn paste_is_raw_when_bracketed_paste_is_off() {
    assert_eq!(encode_paste("hi", &modes()), b"hi");
}

// ---- Mouse ----

use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};

fn mouse(kind: MouseEventKind, modifiers: KeyModifiers) -> MouseEvent {
    MouseEvent {
        kind,
        column: 0,
        row: 0,
        modifiers,
    }
}

fn sgr() -> Modes {
    Modes {
        mouse_report: true,
        sgr_mouse: true,
        ..Modes::default()
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn sgr_mouse_reports_press_release_and_wheel_one_based() {
    let none = KeyModifiers::NONE;
    let press = mouse(MouseEventKind::Down(MouseButton::Left), none);
    assert_eq!(text(&encode_mouse(&press, 0, 0, &sgr())), "\x1b[<0;1;1M");
    let release = mouse(MouseEventKind::Up(MouseButton::Right), none);
    assert_eq!(text(&encode_mouse(&release, 9, 4, &sgr())), "\x1b[<2;10;5m");
    let up = mouse(MouseEventKind::ScrollUp, none);
    assert_eq!(
        text(&encode_mouse(&up, 300, 60, &sgr())),
        "\x1b[<64;301;61M"
    );
    let down = mouse(MouseEventKind::ScrollDown, none);
    assert_eq!(text(&encode_mouse(&down, 0, 0, &sgr())), "\x1b[<65;1;1M");
}

#[test]
fn sgr_mouse_adds_drag_and_modifier_bits() {
    let drag = mouse(
        MouseEventKind::Drag(MouseButton::Left),
        KeyModifiers::CONTROL | KeyModifiers::ALT,
    );
    assert_eq!(text(&encode_mouse(&drag, 2, 3, &sgr())), "\x1b[<56;3;4M");
}

#[test]
fn legacy_mouse_uses_one_byte_per_value_and_three_for_release() {
    let modes = Modes {
        mouse_report: true,
        ..Modes::default()
    };
    let none = KeyModifiers::NONE;
    let press = mouse(MouseEventKind::Down(MouseButton::Left), none);
    assert_eq!(
        encode_mouse(&press, 0, 0, &modes),
        [0x1b, b'[', b'M', 32, 33, 33]
    );
    let release = mouse(MouseEventKind::Up(MouseButton::Left), none);
    assert_eq!(
        encode_mouse(&release, 0, 0, &modes),
        [0x1b, b'[', b'M', 35, 33, 33]
    );
    // Além do que um byte carrega, não há como dizer a posição
    assert!(encode_mouse(&press, 250, 0, &modes).is_empty());
}

#[test]
fn bare_motion_has_no_encoding() {
    let moved = mouse(MouseEventKind::Moved, KeyModifiers::NONE);
    assert!(encode_mouse(&moved, 1, 1, &sgr()).is_empty());
}
