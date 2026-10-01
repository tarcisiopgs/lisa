//! Sessões de agente: um PTY e uma tela emulada por painel, vivos no daemon
//! independentemente de haver UI conectada.

use std::collections::HashMap;
use std::io;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crate::daemon::SessionHost;
use crate::protocol::work::Snapshot;

pub mod hooks;
pub mod launch;
pub mod pty;
pub mod screen;
pub mod signals;
pub mod state;

use pty::{Launch, Pty};
use screen::Screen;

/// Carência entre SIGTERM e SIGKILL ao parar um agente.
pub const STOP_GRACE: Duration = Duration::from_secs(2);

/// Eventos das sessões para o daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneEvent {
    /// A tela mudou.
    Dirty(String),
    Title {
        pane: String,
        title: String,
    },
    Bell(String),
    /// Bytes crus de output, para os detectores de estado.
    Output {
        pane: String,
        bytes: Vec<u8>,
    },
    Exited {
        pane: String,
        code: u32,
    },
    Warning {
        pane: String,
        message: String,
    },
}

struct Session {
    screen: Mutex<Screen>,
    pty: OnceLock<Pty>,
    /// Respostas a consultas feitas antes de o PTY ficar disponível.
    pending: Mutex<Vec<u8>>,
    exit: Mutex<Option<u32>>,
}

impl Session {
    fn reply(&self, bytes: Vec<u8>) {
        match self.pty.get() {
            Some(pty) => {
                pty.write(bytes);
            }
            None => self
                .pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .extend(bytes),
        }
    }

    fn running(&self) -> bool {
        self.pty.get().is_some()
            && self
                .exit
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .is_none()
    }
}

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    events: Sender<PaneEvent>,
    scrollback: usize,
}

impl SessionManager {
    pub fn new(events: Sender<PaneEvent>, scrollback: usize) -> Self {
        SessionManager {
            sessions: Mutex::new(HashMap::new()),
            events,
            scrollback,
        }
    }

    fn get(&self, pane: &str) -> Option<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(pane)
            .cloned()
    }

    /// Sobe o agente no painel, parando um anterior se houver.
    pub fn start(&self, pane: &str, launch: Launch) -> io::Result<()> {
        if let Some(old) = self.get(pane)
            && let Some(pty) = old.pty.get()
        {
            pty.stop(STOP_GRACE);
        }

        let session = Arc::new(Session {
            screen: Mutex::new(Screen::new(launch.cols, launch.rows, self.scrollback)),
            pty: OnceLock::new(),
            pending: Mutex::new(Vec::new()),
            exit: Mutex::new(None),
        });

        let out_session = Arc::clone(&session);
        let out_events = self.events.clone();
        let out_pane = pane.to_owned();
        let exit_session = Arc::clone(&session);
        let exit_events = self.events.clone();
        let exit_pane = pane.to_owned();

        let pty = Pty::spawn(
            &launch,
            move |bytes| {
                let result = out_session
                    .screen
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .feed(&bytes);
                if !result.replies.is_empty() {
                    out_session.reply(result.replies);
                }
                if let Some(title) = result.title {
                    let _ = out_events.send(PaneEvent::Title {
                        pane: out_pane.clone(),
                        title,
                    });
                }
                if result.bell {
                    let _ = out_events.send(PaneEvent::Bell(out_pane.clone()));
                }
                let _ = out_events.send(PaneEvent::Output {
                    pane: out_pane.clone(),
                    bytes,
                });
                let _ = out_events.send(PaneEvent::Dirty(out_pane.clone()));
            },
            move |code| {
                *exit_session
                    .exit
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner) = Some(code);
                let _ = exit_events.send(PaneEvent::Exited {
                    pane: exit_pane,
                    code,
                });
            },
        )?;

        let pending = std::mem::take(
            &mut *session
                .pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        );
        if !pending.is_empty() {
            pty.write(pending);
        }
        let _ = session.pty.set(pty);
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(pane.to_owned(), session);
        Ok(())
    }

    /// Sobe `primary` (um resume); se ele falhar dentro de `window`, sobe `fallback`,
    /// avisa e devolve `true`.
    pub fn start_with_fallback(
        &self,
        pane: &str,
        primary: Launch,
        fallback: Launch,
        window: Duration,
    ) -> io::Result<bool> {
        self.start(pane, primary)?;
        let started = Instant::now();
        while started.elapsed() < window {
            if let Some(code) = self.exit_code(pane) {
                if code != 0 {
                    self.start(pane, fallback)?;
                    let _ = self.events.send(PaneEvent::Warning {
                        pane: pane.to_owned(),
                        message:
                            "could not resume the previous conversation; started a new session"
                                .into(),
                    });
                    return Ok(true);
                }
                break;
            }
            thread::sleep(Duration::from_millis(30));
        }
        Ok(false)
    }

    pub fn input(&self, pane: &str, bytes: Vec<u8>) {
        if let Some(session) = self.get(pane) {
            // Quem digita quer ver onde está digitando: a vista volta para o fim
            session
                .screen
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .scroll_to_bottom();
            if let Some(pty) = session.pty.get() {
                pty.write(bytes);
            }
        }
    }

    /// Rola a vista do painel pelo histórico; positivo volta no tempo.
    pub fn scroll(&self, pane: &str, lines: i32) {
        if let Some(session) = self.get(pane) {
            session
                .screen
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .scroll(lines);
        }
    }

    pub fn resize(&self, pane: &str, cols: u16, rows: u16) {
        if let Some(session) = self.get(pane) {
            session
                .screen
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .resize(cols, rows);
            if let Some(pty) = session.pty.get() {
                pty.resize(cols, rows);
            }
        }
    }

    pub fn snapshot(&self, pane: &str) -> Option<Snapshot> {
        self.get(pane).map(|s| {
            s.screen
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .snapshot()
        })
    }

    /// Linhas guardadas no scrollback do painel.
    pub fn history_len(&self, pane: &str) -> Option<usize> {
        self.get(pane).map(|s| {
            s.screen
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .history_len()
        })
    }

    pub fn exit_code(&self, pane: &str) -> Option<u32> {
        self.get(pane)
            .and_then(|s| *s.exit.lock().unwrap_or_else(PoisonError::into_inner))
    }

    pub fn is_running(&self, pane: &str) -> bool {
        self.get(pane).is_some_and(|s| s.running())
    }

    pub fn stop(&self, pane: &str) {
        if let Some(pty) = self.get(pane).as_ref().and_then(|s| s.pty.get()) {
            pty.stop(STOP_GRACE);
        }
    }

    /// Tira o painel do gerenciador (depois de parado).
    pub fn forget(&self, pane: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(pane);
    }
}

impl SessionHost for SessionManager {
    fn live_agents(&self) -> u32 {
        let sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        u32::try_from(sessions.values().filter(|s| s.running()).count()).unwrap_or(u32::MAX)
    }

    fn stop_all(&self) {
        // Threads disparadas com o lock seguro; o join acontece depois de soltá-lo
        let handles: Vec<_> = self
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .map(|s| {
                thread::spawn(move || {
                    if let Some(pty) = s.pty.get() {
                        pty.stop(STOP_GRACE);
                    }
                })
            })
            .collect();
        for h in handles {
            let _ = h.join();
        }
    }
}
