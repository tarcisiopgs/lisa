//! Mensagens de trabalho. Evoluem com `PROTOCOL_VERSION`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientMsg {
    Ping,
    /// Evento de hook de agente (`lisa-workspace hook`).
    HookEvent {
        pane: String,
        event: String,
        payload: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DaemonMsg {
    Pong,
    /// Outra UI se conectou; esta deve sair.
    AttachedElsewhere,
    Error(String),
}
