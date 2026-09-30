//! Interface do modo Workspace: loop de terminal sobre o `App`.

use std::io::{self, Write};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::Duration;

use crossterm::event::{
    self, DisableBracketedPaste, DisableFocusChange, EnableBracketedPaste, EnableFocusChange,
    Event, KeyEventKind, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
    PushKeyboardEnhancementFlags,
};
use crossterm::execute;

use crate::daemon::client::{Connector, Handshake};
use crate::protocol::{ClientKind, Conn, DaemonMsg};

pub mod app;
pub mod input;
pub mod render;

use app::{Action, App};

/// Intervalo de espera por eventos do terminal entre frames.
const TICK: Duration = Duration::from_millis(16);

enum Swap {
    Keep,
    Restart,
    Quit,
}

/// Pergunta, antes da TUI, o que fazer com um daemon de outra versão com agentes vivos.
fn prompt_swap(live_agents: u32, can_keep: bool) -> io::Result<Swap> {
    let mut err = io::stderr();
    writeln!(
        err,
        "Lisa was updated. {live_agents} agent(s) are running on the previous version."
    )?;
    if can_keep {
        writeln!(err, "  k  keep them running on the previous version")?;
    } else {
        writeln!(
            err,
            "  (keeping the previous version is not possible: the protocol changed)"
        )?;
    }
    writeln!(err, "  r  restart the agents on the new version")?;
    writeln!(err, "  q  quit")?;
    crossterm::terminal::enable_raw_mode()?;
    let choice = loop {
        if let Event::Key(key) = event::read()?
            && key.kind == KeyEventKind::Press
        {
            match key.code {
                event::KeyCode::Char('k') if can_keep => break Swap::Keep,
                event::KeyCode::Char('r') => break Swap::Restart,
                event::KeyCode::Char('q') | event::KeyCode::Esc => break Swap::Quit,
                _ => {}
            }
        }
    };
    crossterm::terminal::disable_raw_mode()?;
    Ok(choice)
}

fn attach(connector: &Connector) -> anyhow::Result<Option<Conn>> {
    Ok(match connector.connect(ClientKind::Ui)? {
        Handshake::Attached { conn, .. } => Some(conn),
        Handshake::VersionMismatch {
            conn,
            reply,
            can_keep,
        } => match prompt_swap(reply.live_agents, can_keep)? {
            Swap::Keep => Some(conn),
            Swap::Restart => Some(connector.replace(true)?.0),
            Swap::Quit => None,
        },
    })
}

/// Lê mensagens do daemon numa thread; `None` avisa que a conexão caiu.
fn spawn_reader(conn: Conn) -> Receiver<Option<DaemonMsg>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut conn = conn;
        loop {
            match conn.recv_daemon() {
                Ok(msg) => {
                    if tx.send(Some(msg)).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = tx.send(None);
                    break;
                }
            }
        }
    });
    rx
}

fn ui_env() -> Vec<(String, String)> {
    std::env::vars().collect()
}

pub fn run() -> anyhow::Result<()> {
    let connector = Connector::for_current_exe();
    let Some(conn) = attach(&connector)? else {
        return Ok(());
    };
    let mut writer = conn.try_clone()?;
    let mut rx = spawn_reader(conn);

    let mut terminal = ratatui::init();
    let enhanced = crossterm::terminal::supports_keyboard_enhancement().unwrap_or(false);
    let mut out = io::stdout();
    let _ = execute!(out, EnableBracketedPaste, EnableFocusChange);
    if enhanced {
        let _ = execute!(
            out,
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
        );
    }

    let size = terminal.size()?;
    let mut app = App::new(size.width, size.height);
    writer.send(&app.attach_msg(ui_env()))?;
    let exit_message: Option<String>;
    let mut reconnected = false;

    'main: loop {
        terminal.draw(|f| render::render(f, &app))?;
        let mut actions = Vec::new();

        loop {
            match rx.try_recv() {
                Ok(Some(msg)) => actions.extend(app.on_daemon(msg)),
                Ok(None) | Err(TryRecvError::Disconnected) => {
                    // O daemon caiu: uma tentativa de reconectar (sobe outro se preciso)
                    if !reconnected
                        && let Ok(Handshake::Attached { conn, .. }) =
                            connector.connect(ClientKind::Ui)
                    {
                        reconnected = true;
                        writer = conn.try_clone()?;
                        rx = spawn_reader(conn);
                        writer.send(&app.attach_msg(ui_env()))?;
                        continue 'main;
                    }
                    exit_message = Some(format!(
                        "The workspace daemon stopped. Agents may have stopped too; see {}",
                        connector.paths().log.display()
                    ));
                    break 'main;
                }
                Err(TryRecvError::Empty) => break,
            }
        }

        if event::poll(TICK)? {
            match event::read()? {
                Event::Key(key) if key.kind != KeyEventKind::Release => {
                    actions.extend(app.on_key(key))
                }
                Event::Paste(text) => actions.extend(app.on_paste(&text)),
                Event::Resize(cols, rows) => actions.extend(app.on_resize(cols, rows)),
                Event::FocusGained => actions.extend(app.on_focus(true)),
                Event::FocusLost => actions.extend(app.on_focus(false)),
                _ => {}
            }
        }

        for action in actions {
            match action {
                Action::Send(msg) => {
                    if writer.send(&msg).is_err() {
                        // A leitura percebe a queda e decide entre reconectar e sair
                        continue;
                    }
                }
                Action::Bell => {
                    let _ = out.write_all(b"\x07");
                    let _ = out.flush();
                }
                Action::Quit => {
                    exit_message = app.exit_message().map(str::to_owned);
                    break 'main;
                }
            }
        }
    }

    if enhanced {
        let _ = execute!(out, PopKeyboardEnhancementFlags);
    }
    let _ = execute!(out, DisableBracketedPaste, DisableFocusChange);
    ratatui::restore();
    if let Some(msg) = exit_message {
        eprintln!("{msg}");
    }
    Ok(())
}
