//! Subida, lock, handshake e troca de geração do daemon, com daemons reais em threads.

use std::io::Write;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use lisa_workspace::daemon::client::{ConnectError, Connector, Handshake};
use lisa_workspace::daemon::{BuildInfo, Daemon, RunOutcome, RuntimePaths, SessionHost};
use lisa_workspace::protocol::{ClientKind, ClientMsg, Conn, DaemonMsg, MAX_FRAME};
use tempfile::TempDir;

/// Host falso: número de agentes vivos configurável, registra `stop_all`.
#[derive(Default)]
struct FakeHost {
    agents: AtomicU32,
    stopped: AtomicBool,
}

impl SessionHost for FakeHost {
    fn live_agents(&self) -> u32 {
        self.agents.load(Ordering::SeqCst)
    }
    fn stop_all(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.agents.store(0, Ordering::SeqCst);
    }
}

fn build(id: &str) -> BuildInfo {
    BuildInfo {
        binary_version: id.to_owned(),
        build_id: format!("build-{id}"),
    }
}

fn short_tmp() -> TempDir {
    // Caminho curto: sun_path no macOS aceita só 104 bytes
    tempfile::Builder::new()
        .prefix("lw")
        .tempdir_in("/tmp")
        .unwrap_or_else(|e| panic!("{e}"))
}

fn start_daemon(paths: &RuntimePaths, b: BuildInfo, host: Arc<FakeHost>, served: Arc<AtomicUsize>) {
    let paths = paths.clone();
    thread::spawn(move || {
        if let Ok(RunOutcome::Served) = Daemon::new(paths, b, host).run() {
            served.fetch_add(1, Ordering::SeqCst);
        }
    });
}

fn connector(
    paths: &RuntimePaths,
    b: BuildInfo,
    spawn_build: BuildInfo,
    host: Arc<FakeHost>,
    served: Arc<AtomicUsize>,
) -> Connector {
    let spawn_paths = paths.clone();
    Connector::new(
        paths.clone(),
        b,
        Box::new(move || {
            start_daemon(
                &spawn_paths,
                spawn_build.clone(),
                host.clone(),
                served.clone(),
            );
            Ok(())
        }),
    )
}

fn attached(handshake: Result<Handshake, ConnectError>) -> (Conn, String) {
    match handshake {
        Ok(Handshake::Attached { conn, reply }) => (conn, reply.build_id),
        Ok(Handshake::VersionMismatch { reply, .. }) => {
            panic!("unexpected mismatch with {}", reply.build_id)
        }
        Err(e) => panic!("connect failed: {e}"),
    }
}

#[test]
fn two_uis_opening_at_once_start_exactly_one_reachable_daemon() {
    let tmp = short_tmp();
    let paths = RuntimePaths::in_dir(tmp.path().join("rt"));
    let served = Arc::new(AtomicUsize::new(0));
    let host = Arc::new(FakeHost::default());
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let c = connector(&paths, build("a"), build("a"), host.clone(), served.clone());
            thread::spawn(move || attached(c.connect(ClientKind::Cli)).1)
        })
        .collect();
    for h in handles {
        assert_eq!(h.join().unwrap_or_default(), "build-a");
    }
    // Um daemon atende; o outro sai sem tocar no socket
    let c = connector(&paths, build("a"), build("a"), host, served);
    let (mut conn, _) = attached(c.connect(ClientKind::Cli));
    conn.send(&ClientMsg::Ping)
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(conn.recv_daemon().ok(), Some(DaemonMsg::Pong));
}

#[test]
fn orphan_socket_is_replaced_by_a_new_daemon() {
    let tmp = short_tmp();
    let paths = RuntimePaths::in_dir(tmp.path().join("rt"));
    paths.ensure_dir().unwrap_or_else(|e| panic!("{e}"));
    drop(UnixListener::bind(&paths.socket).unwrap_or_else(|e| panic!("{e}")));
    assert!(paths.socket.exists());
    let host = Arc::new(FakeHost::default());
    let served = Arc::new(AtomicUsize::new(0));
    let c = connector(&paths, build("a"), build("a"), host, served);
    let (_conn, id) = attached(c.connect(ClientKind::Ui));
    assert_eq!(id, "build-a");
}

#[test]
fn held_lock_without_socket_fails_within_two_seconds_naming_the_log() {
    let tmp = short_tmp();
    let paths = RuntimePaths::in_dir(tmp.path().join("rt"));
    let _guard = paths
        .try_lock()
        .unwrap_or_else(|e| panic!("{e}"))
        .unwrap_or_else(|| panic!("lock"));
    let c = Connector::new(paths.clone(), build("a"), Box::new(|| Ok(())));
    let started = Instant::now();
    let err = c.connect(ClientKind::Ui);
    assert!(started.elapsed() < Duration::from_secs(3));
    match err {
        Err(ConnectError::Unreachable { log }) => assert_eq!(log, paths.log),
        other => panic!("unexpected {:?}", other.map(|_| ())),
    }
}

#[test]
fn hello_with_wrong_magic_is_refused_and_the_daemon_survives() {
    let tmp = short_tmp();
    let paths = RuntimePaths::in_dir(tmp.path().join("rt"));
    let host = Arc::new(FakeHost::default());
    let served = Arc::new(AtomicUsize::new(0));
    let c = connector(&paths, build("a"), build("a"), host, served);
    drop(attached(c.connect(ClientKind::Cli)));

    let mut raw = UnixStream::connect(&paths.socket).unwrap_or_else(|e| panic!("{e}"));
    raw.write_all(&[5, 0, 0, 0, b'N', b'O', b'P', b'E', 0])
        .unwrap_or_else(|e| panic!("{e}"));
    let mut conn = Conn::new(raw);
    assert!(conn.recv_hello_reply().is_err());

    let (mut ok, _) = attached(c.connect(ClientKind::Cli));
    ok.send(&ClientMsg::Ping).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(ok.recv_daemon().ok(), Some(DaemonMsg::Pong));
}

#[test]
fn different_binary_without_agents_is_replaced_silently() {
    let tmp = short_tmp();
    let paths = RuntimePaths::in_dir(tmp.path().join("rt"));
    let host = Arc::new(FakeHost::default());
    let served = Arc::new(AtomicUsize::new(0));
    start_daemon(&paths, build("old"), host.clone(), served.clone());
    let old = connector(
        &paths,
        build("old"),
        build("old"),
        host.clone(),
        served.clone(),
    );
    drop(attached(old.connect(ClientKind::Cli)));

    let new = connector(&paths, build("new"), build("new"), host, served);
    let (_conn, id) = attached(new.connect(ClientKind::Ui));
    assert_eq!(id, "build-new");
}

#[test]
fn different_binary_with_live_agents_asks_and_restart_stops_them() {
    let tmp = short_tmp();
    let paths = RuntimePaths::in_dir(tmp.path().join("rt"));
    let old_host = Arc::new(FakeHost::default());
    old_host.agents.store(2, Ordering::SeqCst);
    let served = Arc::new(AtomicUsize::new(0));
    start_daemon(&paths, build("old"), old_host.clone(), served.clone());
    let old = connector(
        &paths,
        build("old"),
        build("old"),
        old_host.clone(),
        served.clone(),
    );
    drop(attached(old.connect(ClientKind::Cli)));

    let new = connector(
        &paths,
        build("new"),
        build("new"),
        Arc::new(FakeHost::default()),
        served,
    );
    match new.connect(ClientKind::Ui) {
        Ok(Handshake::VersionMismatch {
            reply, can_keep, ..
        }) => {
            assert_eq!(reply.live_agents, 2);
            assert!(can_keep);
        }
        Ok(Handshake::Attached { .. }) => panic!("should ask before replacing"),
        Err(e) => panic!("{e}"),
    }
    let (_conn, reply) = new.replace(true).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(reply.build_id, "build-new");
    assert!(old_host.stopped.load(Ordering::SeqCst));
}

#[test]
fn second_ui_evicts_the_first_with_attached_elsewhere() {
    let tmp = short_tmp();
    let paths = RuntimePaths::in_dir(tmp.path().join("rt"));
    let host = Arc::new(FakeHost::default());
    let served = Arc::new(AtomicUsize::new(0));
    let c = connector(&paths, build("a"), build("a"), host, served);
    let (mut first, _) = attached(c.connect(ClientKind::Ui));
    let (_second, _) = attached(c.connect(ClientKind::Ui));
    assert_eq!(first.recv_daemon().ok(), Some(DaemonMsg::AttachedElsewhere));
    assert!(first.recv_daemon().is_err(), "connection should close");
}

#[test]
fn hook_connection_does_not_disconnect_the_ui() {
    let tmp = short_tmp();
    let paths = RuntimePaths::in_dir(tmp.path().join("rt"));
    let host = Arc::new(FakeHost::default());
    let served = Arc::new(AtomicUsize::new(0));
    let c = connector(&paths, build("a"), build("a"), host, served);
    let (mut ui, _) = attached(c.connect(ClientKind::Ui));
    let (mut hook, _) = attached(c.connect(ClientKind::Hook));
    hook.send(&ClientMsg::HookEvent {
        pane: "p1".into(),
        event: "Stop".into(),
        payload: String::new(),
    })
    .unwrap_or_else(|e| panic!("{e}"));
    drop(hook);
    ui.send(&ClientMsg::Ping).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(ui.recv_daemon().ok(), Some(DaemonMsg::Pong));
}

#[test]
fn frame_larger_than_the_limit_closes_the_connection() {
    let tmp = short_tmp();
    let paths = RuntimePaths::in_dir(tmp.path().join("rt"));
    let host = Arc::new(FakeHost::default());
    let served = Arc::new(AtomicUsize::new(0));
    let c = connector(&paths, build("a"), build("a"), host, served);
    let (conn, _) = attached(c.connect(ClientKind::Cli));
    let mut raw = conn.into_stream();
    let too_big = u32::try_from(MAX_FRAME + 1).unwrap_or(u32::MAX);
    raw.write_all(&too_big.to_le_bytes())
        .unwrap_or_else(|e| panic!("{e}"));
    let mut conn = Conn::new(raw);
    assert!(conn.recv_daemon().is_err());
}

#[test]
fn runtime_dir_that_is_a_symlink_is_refused_before_connecting() {
    let tmp = short_tmp();
    let real = tmp.path().join("elsewhere");
    std::fs::create_dir_all(&real).unwrap_or_else(|e| panic!("{e}"));
    // Um daemon "estranho" escuta no destino do symlink
    let listener = UnixListener::bind(real.join("daemon.sock")).unwrap_or_else(|e| panic!("{e}"));
    listener
        .set_nonblocking(true)
        .unwrap_or_else(|e| panic!("{e}"));
    let link = tmp.path().join("rt");
    std::os::unix::fs::symlink(&real, &link).unwrap_or_else(|e| panic!("{e}"));
    let paths = RuntimePaths::in_dir(link);
    let c = Connector::new(paths, build("a"), Box::new(|| Ok(())));
    assert!(c.connect(ClientKind::Ui).is_err());
    assert!(
        listener.accept().is_err(),
        "the client must not connect through the symlink"
    );
}

#[test]
fn runtime_dir_with_loose_permissions_is_tightened() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = short_tmp();
    let dir = tmp.path().join("rt");
    std::fs::create_dir_all(&dir).unwrap_or_else(|e| panic!("{e}"));
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777))
        .unwrap_or_else(|e| panic!("{e}"));
    RuntimePaths::in_dir(dir.clone())
        .ensure_dir()
        .unwrap_or_else(|e| panic!("{e}"));
    let mode = std::fs::symlink_metadata(&dir)
        .map(|m| m.permissions().mode() & 0o777)
        .unwrap_or(0);
    assert_eq!(mode, 0o700);
}
