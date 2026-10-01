//! Interface do modo Workspace: loop de terminal sobre o `App`.

use std::io::{self, Write};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::Duration;

use crossterm::event::{
    self, EnableBracketedPaste, EnableFocusChange, Event, KeyEventKind, KeyboardEnhancementFlags,
    PushKeyboardEnhancementFlags,
};
use crossterm::execute;

use crate::daemon::client::{Connector, Handshake};
use crate::protocol::{ClientKind, Conn, DaemonMsg};
use crate::router::jev::{Decider, HttpJev};
use crate::router::{Answers, RouteError, config};

pub mod app;
pub mod input;
pub mod picker;
pub mod render;
pub mod terminal;

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
    let _raw = terminal::RawModeGuard::enable()?;
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

/// Resposta do roteador a uma consulta, com o id dela.
type RouteAnswer = (u64, Result<Answers, RouteError>);

/// Consulta o roteador numa thread, para o diálogo nunca travar esperando a rede.
fn spawn_route(decider: Arc<dyn Decider>, tx: Sender<RouteAnswer>, id: u64, task: String) {
    thread::spawn(move || {
        // A UI pode ter saído: a resposta só é descartada
        let _ = tx.send((id, decider.ask(&task)));
    });
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
    // Daqui em diante qualquer saída (inclusive `?` e pânico) restaura o terminal
    let guard = terminal::TerminalGuard::new(enhanced);

    let size = terminal.size()?;
    let mut app = App::new(size.width, size.height);
    if let Ok(cwd) = std::env::current_dir() {
        app.set_dirs(cwd, std::env::var_os("HOME").map(std::path::PathBuf::from));
    }
    let mut prefs = terminal::Prefs::load(&terminal::prefs_path());
    app.set_default_autonomy(prefs.default_autonomy);
    app.set_sidebar_width(prefs.sidebar_width);
    let (router_config, config_warning) = config::load(&config::config_path());
    app.set_router_config(router_config);
    if let Some(warning) = config_warning {
        app.warn(warning);
    }
    let decider: Arc<dyn Decider> = Arc::new(HttpJev::from_env());
    let (route_tx, route_rx) = mpsc::channel::<RouteAnswer>();
    for msg in app.attach_msgs(ui_env()) {
        writer.send(&msg)?;
    }
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
                        for msg in app.attach_msgs(ui_env()) {
                            writer.send(&msg)?;
                        }
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

        while let Ok((id, answer)) = route_rx.try_recv() {
            app.on_route(id, answer);
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
                Action::Route { id, task } => {
                    spawn_route(Arc::clone(&decider), route_tx.clone(), id, task);
                }
                Action::Bell => {
                    let _ = out.write_all(b"\x07");
                    let _ = out.flush();
                }
                Action::RememberAutonomy(on) => {
                    prefs.default_autonomy = on;
                    prefs.save(&terminal::prefs_path());
                }
                Action::RememberSidebarWidth(width) => {
                    prefs.sidebar_width = Some(width);
                    prefs.save(&terminal::prefs_path());
                }
                Action::Quit => {
                    exit_message = app.exit_message().map(str::to_owned);
                    break 'main;
                }
            }
        }
    }

    drop(guard);
    if let Some(msg) = exit_message {
        eprintln!("{msg}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    struct Fixed(Duration);

    impl Decider for Fixed {
        fn ask(&self, _task: &str) -> Result<Answers, RouteError> {
            thread::sleep(self.0);
            Err(RouteError::NoKey)
        }
    }

    #[test]
    fn a_route_request_answers_on_the_channel_with_its_id() {
        let (tx, rx) = mpsc::channel();
        spawn_route(Arc::new(Fixed(Duration::ZERO)), tx, 7, "t".to_owned());
        let answer = rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(answer, (7, Err(RouteError::NoKey)));
    }

    #[test]
    fn a_slow_decider_does_not_block_the_caller() {
        let (tx, rx) = mpsc::channel();
        let started = Instant::now();
        spawn_route(
            Arc::new(Fixed(Duration::from_millis(300))),
            tx,
            1,
            "t".to_owned(),
        );
        assert!(started.elapsed() < Duration::from_millis(50));
        assert!(rx.try_recv().is_err());
        assert!(rx.recv_timeout(Duration::from_secs(2)).is_ok());
    }

    #[test]
    fn an_answer_after_the_ui_is_gone_is_dropped_quietly() {
        let (tx, rx) = mpsc::channel();
        drop(rx);
        spawn_route(Arc::new(Fixed(Duration::ZERO)), tx, 1, "t".to_owned());
        thread::sleep(Duration::from_millis(50));
    }
}
