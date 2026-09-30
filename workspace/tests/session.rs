//! Gerenciador de sessões: tela no daemon, acúmulo sem cliente, parada e resume.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use lisa_workspace::daemon::SessionHost;
use lisa_workspace::session::pty::Launch;
use lisa_workspace::session::{PaneEvent, SessionManager};

fn sh(script: &str) -> Launch {
    Launch {
        program: "/bin/bash".into(),
        args: vec!["-c".into(), script.into()],
        cwd: std::env::temp_dir(),
        env: Vec::new(),
        cols: 60,
        rows: 10,
    }
}

fn manager() -> (SessionManager, mpsc::Receiver<PaneEvent>) {
    let (tx, rx) = mpsc::channel();
    (SessionManager::new(tx, 2_000), rx)
}

fn screen_text(m: &SessionManager, pane: &str) -> String {
    m.snapshot(pane)
        .map(|s| {
            s.lines
                .iter()
                .map(|l| l.cells.iter().map(|c| c.ch).collect::<String>())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn eventually(m: &SessionManager, pane: &str, needle: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if screen_text(m, pane).contains(needle) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    false
}

#[test]
fn agent_output_reaches_the_daemon_side_screen() {
    let (m, rx) = manager();
    m.start("p1", sh("echo ready; sleep 5"))
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(eventually(&m, "p1", "ready"));
    assert!(
        rx.try_iter()
            .any(|e| matches!(e, PaneEvent::Dirty(p) if p == "p1"))
    );
}

#[test]
fn output_accumulates_while_no_client_is_reading() {
    let (m, _rx) = manager();
    m.start(
        "p1",
        sh("for i in 1 2 3 4 5; do echo tick$i; sleep 0.1; done; sleep 5"),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    std::thread::sleep(Duration::from_millis(900));
    assert!(screen_text(&m, "p1").contains("tick5"));
}

#[test]
fn cursor_position_query_is_answered_through_the_pty() {
    let (m, _rx) = manager();
    m.start(
        "p1",
        sh("printf '\\033[6n'; IFS= read -rs -d R pos; echo got-reply; sleep 5"),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert!(eventually(&m, "p1", "got-reply"));
}

#[test]
fn input_is_forwarded_to_the_agent() {
    let (m, _rx) = manager();
    m.start("p1", sh("read line; echo echo:$line; sleep 5"))
        .unwrap_or_else(|e| panic!("{e}"));
    m.input("p1", b"hi\r".to_vec());
    assert!(eventually(&m, "p1", "echo:hi"));
}

#[test]
fn stopping_ends_the_session_and_reports_exit() {
    let (m, rx) = manager();
    m.start("p1", sh("sleep 60"))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(m.live_agents(), 1);
    m.stop("p1");
    let exited = rx
        .iter()
        .take(50)
        .any(|e| matches!(e, PaneEvent::Exited { pane, .. } if pane == "p1"));
    assert!(exited);
    assert_eq!(m.live_agents(), 0);
}

#[test]
fn agent_exiting_with_error_keeps_code_and_last_output() {
    let (m, rx) = manager();
    m.start("p1", sh("echo boom; exit 1"))
        .unwrap_or_else(|e| panic!("{e}"));
    let code = rx.iter().find_map(|e| match e {
        PaneEvent::Exited { pane, code } if pane == "p1" => Some(code),
        _ => None,
    });
    assert_eq!(code, Some(1));
    assert_eq!(m.exit_code("p1"), Some(1));
    assert!(screen_text(&m, "p1").contains("boom"));
}

#[test]
fn failed_resume_falls_back_to_a_fresh_session_with_a_warning() {
    let (m, rx) = manager();
    m.start_with_fallback(
        "p1",
        sh("echo no-session; exit 1"),
        sh("echo fresh; sleep 5"),
        Duration::from_secs(3),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert!(eventually(&m, "p1", "fresh"));
    assert!(
        rx.try_iter()
            .any(|e| matches!(e, PaneEvent::Warning { pane, .. } if pane == "p1"))
    );
    assert_eq!(m.live_agents(), 1);
}

#[test]
fn stop_all_stops_every_agent() {
    let (m, _rx) = manager();
    m.start("a", sh("sleep 60"))
        .unwrap_or_else(|e| panic!("{e}"));
    m.start("b", sh("sleep 60"))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(m.live_agents(), 2);
    m.stop_all();
    let deadline = Instant::now() + Duration::from_secs(5);
    while m.live_agents() > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(30));
    }
    assert_eq!(m.live_agents(), 0);
}
