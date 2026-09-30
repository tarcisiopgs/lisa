//! Máquina dos quatro estados do agente (R10). A saída do processo é autoritativa.

use crate::protocol::work::AgentState;

/// O que pode mudar o estado de um agente.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    /// O processo subiu (criação ou reinício).
    Spawned,
    /// Pedido de permissão ou atenção (hook, OSC 777/9, BEL).
    NeedsYou,
    /// O agente terminou a vez (hook Stop/idle_prompt).
    Done,
    /// O usuário mandou input ao agente.
    UserInput,
    /// Qualquer output do agente.
    Output,
    /// Título indicando trabalho em andamento.
    TitleWorking,
    /// Título indicando agente ocioso.
    TitleIdle,
    /// Silêncio prolongado de output.
    Silence,
    /// O usuário olhou o worktree (selecionado com a janela em foco).
    Looked,
    Exited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Transition {
    pub from: AgentState,
    pub to: AgentState,
}

#[derive(Debug, Clone)]
pub struct Tracker {
    state: AgentState,
    running: bool,
    /// Agente com hooks ou título classificável: o silêncio não conta.
    rich: bool,
    /// Houve input do usuário desde a última transição.
    input_pending: bool,
}

impl Tracker {
    pub fn new(rich: bool) -> Self {
        Tracker {
            state: AgentState::Idle,
            running: false,
            rich,
            input_pending: false,
        }
    }

    pub fn state(&self) -> AgentState {
        self.state
    }

    pub fn running(&self) -> bool {
        self.running
    }

    pub fn rich(&self) -> bool {
        self.rich
    }

    /// Passa a ignorar o silêncio (o agente mostrou ter sinais melhores).
    pub fn mark_rich(&mut self) {
        self.rich = true;
    }

    pub fn on(&mut self, signal: Signal) -> Option<Transition> {
        use AgentState::{Done, Idle, NeedsYou, Working};
        if !self.running && signal != Signal::Spawned {
            return None;
        }
        let next = match (self.state, signal) {
            (_, Signal::Spawned) => {
                self.running = true;
                self.input_pending = false;
                Working
            }
            (_, Signal::Exited) => {
                self.running = false;
                Idle
            }
            (_, Signal::UserInput) => {
                self.input_pending = true;
                return None;
            }
            (Working, Signal::NeedsYou) | (Done | Idle, Signal::NeedsYou) => NeedsYou,
            (Working | NeedsYou, Signal::Done) => Done,
            (Working, Signal::TitleIdle) => Done,
            (Working, Signal::Silence) if !self.rich => Done,
            (Done, Signal::Looked) => Idle,
            (NeedsYou | Done | Idle, Signal::Output) if self.input_pending => Working,
            (NeedsYou | Done | Idle, Signal::TitleWorking) => Working,
            _ => return None,
        };
        if next == self.state && signal != Signal::Spawned {
            return None;
        }
        let transition = Transition {
            from: self.state,
            to: next,
        };
        self.state = next;
        if next == Working || next == Idle {
            self.input_pending = false;
        }
        Some(transition)
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
