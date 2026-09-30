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
