//! Daemon: dono dos terminais dos agentes. Uma geração por usuário (lock),
//! uma UI conectada por vez, hooks e CLI em conexões curtas.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;

use crate::protocol::{
    ClientIncoming, ClientKind, ClientMsg, Conn, ControlRequest, DaemonMsg, HelloReply,
    PROTOCOL_VERSION,
};

pub mod client;
pub mod notify;
pub mod service;

/// Onde ficam socket, lock e log. Caminho curto: `sun_path` do macOS aceita 104 bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimePaths {
    pub dir: PathBuf,
    pub socket: PathBuf,
    pub lock: PathBuf,
    pub log: PathBuf,
}

impl RuntimePaths {
    pub fn in_dir(dir: PathBuf) -> Self {
        RuntimePaths {
            socket: dir.join("daemon.sock"),
            lock: dir.join("daemon.lock"),
            log: dir.join("daemon.log"),
            dir,
        }
    }

    /// `LISA_WORKSPACE_RUNTIME_DIR`, senão `$XDG_RUNTIME_DIR/lisa` no Linux, senão `/tmp/lisa-<uid>`.
    pub fn resolve() -> Self {
        if let Some(dir) = std::env::var_os("LISA_WORKSPACE_RUNTIME_DIR") {
            return RuntimePaths::in_dir(PathBuf::from(dir));
        }
        if cfg!(target_os = "linux")
            && let Some(xdg) = std::env::var_os("XDG_RUNTIME_DIR")
        {
            return RuntimePaths::in_dir(PathBuf::from(xdg).join("lisa"));
        }
        let uid = rustix::process::getuid().as_raw();
        RuntimePaths::in_dir(PathBuf::from(format!("/tmp/lisa-{uid}")))
    }

    /// Cria o diretório 0700 e confere que pertence ao usuário atual.
    pub fn ensure_dir(&self) -> io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let meta = std::fs::metadata(&self.dir)?;
        if meta.uid() != rustix::process::getuid().as_raw() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{} belongs to another user", self.dir.display()),
            ));
        }
        std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700))
    }

    /// Lock exclusivo sem bloquear; `None` quando outro processo o segura.
    pub fn try_lock(&self) -> io::Result<Option<LockGuard>> {
        self.ensure_dir()?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&self.lock)?;
        match rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => Ok(Some(LockGuard { _file: file })),
            Err(e) if e == rustix::io::Errno::WOULDBLOCK => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
}

/// Lock do daemon; o kernel o libera quando o arquivo fecha (inclusive em crash).
#[derive(Debug)]
pub struct LockGuard {
    _file: File,
}

/// Identidade do binário. Binários diferentes trocam o daemon (R13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildInfo {
    pub binary_version: String,
    pub build_id: String,
}

impl BuildInfo {
    /// Versão + caminho + mtime do executável: um `cargo build` novo conta como outra geração.
    pub fn current() -> Self {
        let version = env!("CARGO_PKG_VERSION").to_owned();
        let exe = std::env::current_exe().ok();
        let mtime = exe
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.mtime())
            .unwrap_or(0);
        let path = exe.map(|p| p.display().to_string()).unwrap_or_default();
        BuildInfo {
            build_id: format!("{version}:{path}:{mtime}"),
            binary_version: version,
        }
    }
}

/// O que o daemon precisa das sessões de agente.
pub trait SessionHost: Send + Sync {
    fn live_agents(&self) -> u32;
    /// Encerra todos os agentes (grupos de processo).
    fn stop_all(&self);
    fn hook_event(&self, _pane: &str, _event: &str, _payload: &str) {}
    /// Canal para mandar mensagens à UI conectada; entregue uma vez, quando o daemon sobe.
    fn set_ui_sink(&self, _sink: UiSink) {}
    /// Mensagem de trabalho vinda da UI.
    fn handle(&self, _msg: ClientMsg) {}
    /// A UI conectada saiu (ou caiu).
    fn ui_detached(&self) {}
}

/// Escreve na UI conectada, se houver. Serializa as escritas com o resto do daemon.
#[derive(Clone)]
pub struct UiSink {
    shared: std::sync::Weak<Shared>,
}

impl UiSink {
    /// `false` quando não há UI conectada ou a escrita falhou.
    pub fn send(&self, msg: &DaemonMsg) -> bool {
        let Some(shared) = self.shared.upgrade() else {
            return false;
        };
        let mut ui = shared.ui.lock().unwrap_or_else(PoisonError::into_inner);
        match ui.as_mut() {
            Some((_, conn)) => conn.send_daemon(msg).is_ok(),
            None => false,
        }
    }
}

/// Host sem sessões, usado até as sessões existirem.
#[derive(Debug, Default)]
pub struct NoSessions;

impl SessionHost for NoSessions {
    fn live_agents(&self) -> u32 {
        0
    }
    fn stop_all(&self) {}
}

#[derive(Debug, PartialEq, Eq)]
pub enum RunOutcome {
    /// Este processo foi o daemon até receber o pedido de encerramento.
    Served,
    /// Outro daemon segura o lock; este saiu sem tocar em nada.
    AlreadyRunning,
}

struct Shared {
    build: BuildInfo,
    host: Arc<dyn SessionHost>,
    /// UI conectada: (id da conexão, conexão para escrita).
    ui: Mutex<Option<(u64, Conn)>>,
    next_id: AtomicU64,
    shutdown: AtomicBool,
    socket: PathBuf,
}

pub struct Daemon {
    paths: RuntimePaths,
    shared: Arc<Shared>,
}

impl Daemon {
    pub fn new(paths: RuntimePaths, build: BuildInfo, host: Arc<dyn SessionHost>) -> Self {
        let shared = Arc::new(Shared {
            build,
            host,
            ui: Mutex::new(None),
            next_id: AtomicU64::new(1),
            shutdown: AtomicBool::new(false),
            socket: paths.socket.clone(),
        });
        Daemon { paths, shared }
    }

    /// Atende até um pedido de encerramento. Só quem obtém o lock mexe no socket.
    pub fn run(self) -> io::Result<RunOutcome> {
        let Some(guard) = self.paths.try_lock()? else {
            return Ok(RunOutcome::AlreadyRunning);
        };
        self.shared.host.set_ui_sink(UiSink {
            shared: Arc::downgrade(&self.shared),
        });
        remove_socket(&self.paths.socket)?;
        let listener = UnixListener::bind(&self.paths.socket)?;

        for stream in listener.incoming() {
            if self.shared.shutdown.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else { continue };
            let shared = Arc::clone(&self.shared);
            thread::spawn(move || handle(shared, stream));
        }

        // Socket antes do lock: um daemon novo só sobe depois que o lock fica livre
        remove_socket(&self.paths.socket)?;
        drop(guard);
        Ok(RunOutcome::Served)
    }
}

fn remove_socket(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

fn request_shutdown(shared: &Shared) {
    shared.shutdown.store(true, Ordering::SeqCst);
    // Acorda o `accept` bloqueado
    let _ = UnixStream::connect(&shared.socket);
}

fn handle(shared: Arc<Shared>, stream: UnixStream) {
    let mut conn = Conn::new(stream);
    let Ok(hello) = conn.recv_hello() else { return };
    let reply = HelloReply {
        protocol_version: PROTOCOL_VERSION,
        binary_version: shared.build.binary_version.clone(),
        build_id: shared.build.build_id.clone(),
        live_agents: shared.host.live_agents(),
        accepted: true,
    };
    if conn.send_hello_reply(&reply).is_err() {
        return;
    }

    let id = shared.next_id.fetch_add(1, Ordering::SeqCst);
    if hello.client_kind == ClientKind::Ui {
        let Ok(writer) = conn.try_clone() else { return };
        let mut ui = shared.ui.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((_, mut previous)) = ui.replace((id, writer)) {
            let _ = previous.send_daemon(&DaemonMsg::AttachedElsewhere);
            previous.shutdown();
        }
    }

    while let Ok(incoming) = conn.recv_client() {
        match incoming {
            ClientIncoming::Control(ControlRequest::Shutdown { stop_agents }) => {
                if stop_agents {
                    shared.host.stop_all();
                }
                request_shutdown(&shared);
                break;
            }
            ClientIncoming::Work(ClientMsg::Ping) => {
                let sent = if hello.client_kind == ClientKind::Ui {
                    UiSink {
                        shared: Arc::downgrade(&shared),
                    }
                    .send(&DaemonMsg::Pong)
                } else {
                    conn.send_daemon(&DaemonMsg::Pong).is_ok()
                };
                if !sent {
                    break;
                }
            }
            ClientIncoming::Work(ClientMsg::HookEvent {
                pane,
                event,
                payload,
            }) => {
                shared.host.hook_event(&pane, &event, &payload);
            }
            ClientIncoming::Work(other) => {
                if hello.client_kind == ClientKind::Ui {
                    shared.host.handle(other);
                }
            }
        }
    }

    let was_current = {
        let mut ui = shared.ui.lock().unwrap_or_else(PoisonError::into_inner);
        let current = ui.as_ref().is_some_and(|(current, _)| *current == id);
        if current {
            *ui = None;
        }
        current
    };
    if was_current {
        shared.host.ui_detached();
    }
}
