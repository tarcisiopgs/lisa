//! Teclas e colagens do terminal hospedeiro → bytes para o PTY do agente,
//! respeitando os modos que o agente ligou no painel.

use crossterm::event::{KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use terminput::{Encoding, KittyFlags};

pub use crate::protocol::work::Modes;

/// Flags Kitty do painel (bits 0..=4 no protocolo) → flags do encoder.
fn kitty_flags(bits: u8) -> KittyFlags {
    let pairs = [
        (1, KittyFlags::DISAMBIGUATE_ESCAPE_CODES),
        (1 << 1, KittyFlags::REPORT_EVENT_TYPES),
        (1 << 2, KittyFlags::REPORT_ALTERNATE_KEYS),
        (1 << 3, KittyFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES),
    ];
    pairs
        .iter()
        .filter(|(bit, _)| bits & bit != 0)
        .fold(KittyFlags::empty(), |acc, (_, flag)| acc | *flag)
}

/// Bytes para uma tecla; vazio quando a tecla não tem codificação.
pub fn encode_key(key: KeyEvent, modes: &Modes) -> Vec<u8> {
    let Ok(event) = terminput_crossterm::to_terminput(crossterm::event::Event::Key(key)) else {
        return Vec::new();
    };
    let encoding = if modes.kitty_flags == 0 {
        Encoding::Xterm
    } else {
        Encoding::Kitty(kitty_flags(modes.kitty_flags))
    };
    let mut buf = [0u8; 32];
    let Ok(n) = event.encode(&mut buf, encoding) else {
        return Vec::new();
    };
    let mut bytes = buf[..n].to_vec();
    // DECCKM: setas, Home e End sem modificador viram SS3 (`ESC O x`)
    if modes.app_cursor
        && key.modifiers == KeyModifiers::NONE
        && bytes.len() == 3
        && bytes[0] == 0x1b
        && bytes[1] == b'['
        && matches!(bytes[2], b'A' | b'B' | b'C' | b'D' | b'H' | b'F')
    {
        bytes[1] = b'O';
    }
    bytes
}

/// Bytes para um evento de mouse na célula `col`×`row` do painel (a partir de zero), no
/// protocolo que o agente ligou. Vazio para o que não tem codificação: movimento sem
/// botão e, no protocolo antigo, posições além da coluna ou linha 223.
pub fn encode_mouse(event: &MouseEvent, col: u16, row: u16, modes: &Modes) -> Vec<u8> {
    let button = |b: MouseButton| match b {
        MouseButton::Left => 0u16,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
    };
    let (code, release) = match event.kind {
        MouseEventKind::Down(b) => (button(b), false),
        MouseEventKind::Up(b) => (button(b), true),
        MouseEventKind::Drag(b) => (button(b) + 32, false),
        MouseEventKind::ScrollUp => (64, false),
        MouseEventKind::ScrollDown => (65, false),
        _ => return Vec::new(),
    };
    let mods = [
        (KeyModifiers::SHIFT, 4),
        (KeyModifiers::ALT, 8),
        (KeyModifiers::CONTROL, 16),
    ]
    .iter()
    .filter(|(m, _)| event.modifiers.contains(*m))
    .map(|(_, bit)| bit)
    .sum::<u16>();
    let (x, y) = (col + 1, row + 1);
    if modes.sgr_mouse {
        let end = if release { 'm' } else { 'M' };
        return format!("\x1b[<{};{x};{y}{end}", code + mods).into_bytes();
    }
    // X10: um byte por valor, com 32 somado; soltar o botão é sempre o código 3
    let code = if release { 3 } else { code } + mods;
    match (
        u8::try_from(32 + code),
        u8::try_from(32 + x),
        u8::try_from(32 + y),
    ) {
        (Ok(b), Ok(x), Ok(y)) => vec![0x1b, b'[', b'M', b, x, y],
        _ => Vec::new(),
    }
}

pub fn encode_paste(text: &str, modes: &Modes) -> Vec<u8> {
    if modes.bracketed_paste {
        let mut out = b"\x1b[200~".to_vec();
        out.extend(text.as_bytes());
        out.extend(b"\x1b[201~");
        out
    } else {
        text.as_bytes().to_vec()
    }
}

#[cfg(test)]
#[path = "input_tests.rs"]
mod tests;
