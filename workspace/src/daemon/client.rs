//! Lado cliente: conectar, subir o daemon quando não existe e trocar gerações.

use std::fs::OpenOptions;
use std::io;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::{BuildInfo, RuntimePaths};
use crate::protocol::{
    ClientKind, Conn, ControlRequest, Hello, HelloReply, MAGIC, PROTOCOL_VERSION, ProtocolError,
};

/// Quanto a UI espera o daemon responder.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(20);

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("the workspace daemon did not respond; see {}", log.display())]
    Unreachable { log: PathBuf },
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error(transparent)]
    Io(#[from] io::Error),
}

#[derive(Debug)]
pub enum Handshake {
    Attached {
        conn: Conn,
        reply: HelloReply,
    },
    /// Daemon de outro binário com agentes vivos: o usuário decide.
    VersionMismatch {
        conn: Conn,
        reply: HelloReply,
        /// A UI ainda fala a versão de protocolo do daemon antigo.
        can_keep: bool,
    },
}

pub type Spawner = Box<dyn Fn() -> io::Result<()> + Send + Sync>;

pub struct Connector {
    paths: RuntimePaths,
    build: BuildInfo,
    spawn: Spawner,
    timeout: Duration,
}

impl Connector {
    pub fn new(paths: RuntimePaths, build: BuildInfo, spawn: Spawner) -> Self {
        Connector {
            paths,
            build,
            spawn,
            timeout: CONNECT_TIMEOUT,
        }
    }

    /// Conector de produção: sobe `lisa-workspace daemon` a partir deste executável.
    pub fn for_current_exe() -> Self {
        let paths = RuntimePaths::resolve();
        let spawn_paths = paths.clone();
        Connector::new(
            paths,
            BuildInfo::current(),
            Box::new(move || spawn_current_exe(&spawn_paths)),
        )
    }

    pub fn paths(&self) -> &RuntimePaths {
        &self.paths
    }

    pub fn connect(&self, kind: ClientKind) -> Result<Handshake, ConnectError> {
        let (conn, reply) = self.open(kind)?;
        if reply.build_id == self.build.build_id {
            return Ok(Handshake::Attached { conn, reply });
        }
        if reply.live_agents == 0 {
            drop(conn);
            let (conn, reply) = self.replace_as(kind, false)?;
            return Ok(Handshake::Attached { conn, reply });
        }
        let can_keep = reply.protocol_version == PROTOCOL_VERSION;
        Ok(Handshake::VersionMismatch {
            conn,
            reply,
            can_keep,
        })
    }

    /// Encerra o daemon atual (e os agentes, se pedido) e sobe um do binário atual.
    pub fn replace(&self, stop_agents: bool) -> Result<(Conn, HelloReply), ConnectError> {
        self.replace_as(ClientKind::Ui, stop_agents)
    }

    fn replace_as(
        &self,
        kind: ClientKind,
        stop_agents: bool,
    ) -> Result<(Conn, HelloReply), ConnectError> {
        if let Ok(stream) = UnixStream::connect(&self.paths.socket) {
            let mut conn = Conn::new(stream);
            self.handshake(&mut conn, ClientKind::Cli)?;
            conn.send_control(&ControlRequest::Shutdown { stop_agents })?;
        }
        self.wait_lock_free()?;
        self.open(kind)
    }

    fn wait_lock_free(&self) -> Result<(), ConnectError> {
        let started = Instant::now();
        loop {
            if self.paths.try_lock()?.is_some() {
                return Ok(());
            }
            if started.elapsed() >= self.timeout {
                return Err(ConnectError::Unreachable {
                    log: self.paths.log.clone(),
                });
            }
            thread::sleep(POLL);
        }
    }

    fn handshake(&self, conn: &mut Conn, kind: ClientKind) -> Result<HelloReply, ConnectError> {
        conn.send_hello(&Hello {
            magic: MAGIC,
            protocol_version: PROTOCOL_VERSION,
            binary_version: self.build.binary_version.clone(),
            build_id: self.build.build_id.clone(),
            client_kind: kind,
        })?;
        Ok(conn.recv_hello_reply()?)
    }

    /// Conecta; sem daemon, sobe um e espera até o timeout.
    fn open(&self, kind: ClientKind) -> Result<(Conn, HelloReply), ConnectError> {
        if let Ok(stream) = UnixStream::connect(&self.paths.socket) {
            let mut conn = Conn::new(stream);
            if let Ok(reply) = self.handshake(&mut conn, kind) {
                return Ok((conn, reply));
            }
        }
        (self.spawn)()?;
        let started = Instant::now();
        loop {
            if let Ok(stream) = UnixStream::connect(&self.paths.socket) {
                let mut conn = Conn::new(stream);
                if let Ok(reply) = self.handshake(&mut conn, kind) {
                    return Ok((conn, reply));
                }
            }
            if started.elapsed() >= self.timeout {
                return Err(ConnectError::Unreachable {
                    log: self.paths.log.clone(),
                });
            }
            thread::sleep(POLL);
        }
    }
}

/// Conecta a um daemon já rodando, sem subir outro nem esperar (hooks).
pub fn connect_existing(paths: &RuntimePaths, build: &BuildInfo, kind: ClientKind) -> Option<Conn> {
    let stream = UnixStream::connect(&paths.socket).ok()?;
    let mut conn = Conn::new(stream);
    conn.set_read_timeout(Some(Duration::from_secs(1))).ok()?;
    conn.send_hello(&Hello {
        magic: MAGIC,
        protocol_version: PROTOCOL_VERSION,
        binary_version: build.binary_version.clone(),
        build_id: build.build_id.clone(),
        client_kind: kind,
    })
    .ok()?;
    let reply = conn.recv_hello_reply().ok()?;
    (reply.protocol_version == PROTOCOL_VERSION).then_some(conn)
}

/// Re-executa este binário como daemon, com stdio no arquivo de log.
pub fn spawn_current_exe(paths: &RuntimePaths) -> io::Result<()> {
    paths.ensure_dir()?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log)?;
    Command::new(std::env::current_exe()?)
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .spawn()?;
    Ok(())
}
