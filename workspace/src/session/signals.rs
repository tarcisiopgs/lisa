//! Sinais extraídos do output dos agentes: OSC de notificação (que o emulador
//! ignora) e classificação do título.

/// Pedido de atenção vindo do agente.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
    Attention,
}

/// Limite de um OSC guardado entre pedaços de output.
const MAX_OSC: usize = 4096;

#[derive(Debug, Default)]
enum ScanState {
    #[default]
    Ground,
    Escape,
    Osc,
    /// Viu ESC dentro de um OSC (possível terminador ST).
    OscEscape,
}

/// Varre o fluxo de bytes atrás de OSC 777 (`notify`) e OSC 9 (mensagem),
/// mantendo o estado entre pedaços.
#[derive(Debug, Default)]
pub struct OscScanner {
    state: ScanState,
    buf: Vec<u8>,
}

impl OscScanner {
    pub fn scan(&mut self, bytes: &[u8]) -> Vec<Notice> {
        let mut out = Vec::new();
        for &b in bytes {
            self.state = match (&self.state, b) {
                (ScanState::Ground, 0x1b) => ScanState::Escape,
                (ScanState::Ground, _) => ScanState::Ground,
                (ScanState::Escape, b']') => {
                    self.buf.clear();
                    ScanState::Osc
                }
                (ScanState::Escape, 0x1b) => ScanState::Escape,
                (ScanState::Escape, _) => ScanState::Ground,
                (ScanState::Osc, 0x07) => {
                    out.extend(self.finish());
                    ScanState::Ground
                }
                (ScanState::Osc, 0x1b) => ScanState::OscEscape,
                (ScanState::Osc, _) => {
                    if self.buf.len() < MAX_OSC {
                        self.buf.push(b);
                    }
                    ScanState::Osc
                }
                (ScanState::OscEscape, b'\\') => {
                    out.extend(self.finish());
                    ScanState::Ground
                }
                (ScanState::OscEscape, _) => ScanState::Ground,
            };
        }
        out
    }

    fn finish(&mut self) -> Option<Notice> {
        let body = std::mem::take(&mut self.buf);
        if body.starts_with(b"777;notify;") {
            return Some(Notice::Attention);
        }
        // OSC 9;4 é barra de progresso, não notificação
        if let Some(rest) = body.strip_prefix(b"9;")
            && !rest.starts_with(b"4;")
            && !rest.is_empty()
        {
            return Some(Notice::Attention);
        }
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleKind {
    Idle,
    Working,
}

/// Título do Claude Code: `✳` parado, spinner (braille ou dingbat) trabalhando.
pub fn classify_title(title: &str) -> Option<TitleKind> {
    let first = title.chars().next()?;
    match first {
        '\u{2733}' => Some(TitleKind::Idle),
        '\u{2800}'..='\u{28ff}'
        | '\u{2722}'
        | '\u{2736}'
        | '\u{273b}'
        | '\u{273d}'
        | '\u{00b7}'
        | '*' => Some(TitleKind::Working),
        _ => None,
    }
}

#[cfg(test)]
#[path = "signals_tests.rs"]
mod tests;
