//! PTY com processos reais: output, input, resize, código de saída e parada do grupo.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use lisa_workspace::session::pty::{Launch, Pty};

fn launch(script: &str) -> Launch {
    Launch {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        cwd: std::env::temp_dir(),
        env: Vec::new(),
        cols: 80,
        rows: 24,
    }
}

struct Run {
    pty: Pty,
    output: mpsc::Receiver<Vec<u8>>,
    exit: mpsc::Receiver<u32>,
}

fn spawn(l: &Launch) -> Run {
    let (out_tx, output) = mpsc::channel();
    let (exit_tx, exit) = mpsc::channel();
    let pty = Pty::spawn(
        l,
        move |bytes| {
            let _ = out_tx.send(bytes);
        },
        move |code| {
            let _ = exit_tx.send(code);
        },
    )
    .unwrap_or_else(|e| panic!("spawn: {e}"));
    Run { pty, output, exit }
}

/// Junta output até `needle` aparecer ou o prazo acabar.
fn wait_for(run: &Run, needle: &str, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    let mut text = String::new();
    while Instant::now() < deadline && !text.contains(needle) {
        if let Ok(chunk) = run.output.recv_timeout(Duration::from_millis(50)) {
            text.push_str(&String::from_utf8_lossy(&chunk));
        }
    }
    text
}

fn alive(pid: i32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|s| s.success())
}

#[test]
fn output_from_the_child_is_delivered() {
    let run = spawn(&launch("echo hello-pty"));
    assert!(wait_for(&run, "hello-pty", Duration::from_secs(5)).contains("hello-pty"));
}

#[test]
fn input_reaches_the_child() {
    let run = spawn(&launch("read line; echo got:$line"));
    run.pty.write(b"ping\r".to_vec());
    assert!(wait_for(&run, "got:ping", Duration::from_secs(5)).contains("got:ping"));
}

#[test]
fn non_zero_exit_code_is_reported() {
    let run = spawn(&launch("exit 3"));
    assert_eq!(run.exit.recv_timeout(Duration::from_secs(5)).ok(), Some(3));
}

#[test]
fn resize_is_seen_by_the_child() {
    let run = spawn(&launch("sleep 0.5; stty size"));
    run.pty.resize(40, 10);
    assert!(wait_for(&run, "10 40", Duration::from_secs(5)).contains("10 40"));
}

#[test]
fn stopping_kills_the_child_and_its_subprocess() {
    let run = spawn(&launch("sleep 60 & echo child:$!; wait"));
    let text = wait_for(&run, "\n", Duration::from_secs(5));
    let pid: i32 = text
        .split("child:")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("no child pid in {text:?}"));
    assert!(alive(pid));
    run.pty.stop(Duration::from_millis(500));
    let deadline = Instant::now() + Duration::from_secs(3);
    while alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(pid), "subprocess survived stop");
    assert!(run.exit.recv_timeout(Duration::from_secs(3)).is_ok());
}

#[test]
fn explicit_env_replaces_the_daemon_env_and_drops_claudecode() {
    let mut l = launch("echo foo=$FOO cc=${CLAUDECODE:-unset} term=$TERM");
    l.env = vec![
        ("FOO".into(), "bar".into()),
        ("CLAUDECODE".into(), "1".into()),
        ("PATH".into(), "/usr/bin:/bin".into()),
    ];
    let run = spawn(&l);
    let text = wait_for(&run, "term=", Duration::from_secs(5));
    assert!(text.contains("foo=bar"), "{text}");
    assert!(text.contains("cc=unset"), "{text}");
    assert!(text.contains("term=xterm-256color"), "{text}");
}

#[test]
fn working_directory_is_applied() {
    let dir: PathBuf = std::env::temp_dir().canonicalize().unwrap_or_default();
    let mut l = launch("pwd -P");
    l.cwd = dir.clone();
    let run = spawn(&l);
    let needle = dir.to_string_lossy().into_owned();
    assert!(wait_for(&run, &needle, Duration::from_secs(5)).contains(&needle));
}
