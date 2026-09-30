//! Estados e notificações de ponta a ponta: hooks reais do binário `lisa-workspace`
//! disparados por um agente falso, notificador de sistema falso.

mod common;

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use common::*;
use lisa_workspace::daemon::notify::SystemNotifier;
use lisa_workspace::protocol::work::AgentState;
use lisa_workspace::protocol::{ClientMsg, DaemonMsg};

#[derive(Default)]
struct Recorder(Mutex<Vec<String>>);

impl SystemNotifier for Recorder {
    fn notify(&self, _title: &str, body: &str) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(body.to_owned());
    }
}

impl Recorder {
    fn count(&self) -> usize {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).len()
    }
}

fn with_recorder(env: &Env) -> (lisa_workspace::daemon::client::Connector, Arc<Recorder>) {
    let rec = Arc::new(Recorder::default());
    let r = Arc::clone(&rec);
    let c = start_with(env, move |w| {
        w.with_notifier(r.clone())
            .with_silence(Duration::from_millis(800))
    });
    (c, rec)
}

fn wait_count(rec: &Recorder, n: usize) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    while std::time::Instant::now() < deadline {
        if rec.count() >= n {
            return true;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    false
}

fn input(conn: &mut lisa_workspace::protocol::Conn, pane: &str, text: &str) {
    conn.send(&ClientMsg::Input {
        pane: pane.into(),
        bytes: format!("{text}\r").into_bytes(),
    })
    .unwrap_or_else(|e| panic!("{e}"));
}

fn look(conn: &mut lisa_workspace::protocol::Conn, pane: Option<&str>, window_focused: bool) {
    conn.send(&ClientMsg::Focus {
        worktree: pane.map(str::to_owned),
        window_focused,
    })
    .unwrap_or_else(|e| panic!("{e}"));
}

#[test]
fn permission_prompt_in_a_background_worktree_notifies_once() {
    let env = setup();
    let (c, rec) = with_recorder(&env);
    let mut conn = ui(&env, &c);
    let a = create(&mut conn, &env, "a");
    let b = create(&mut conn, &env, "b");
    look(&mut conn, Some(&a), true);
    input(&mut conn, &b, "permit");
    let (mut needs_you, mut alerted) = (false, false);
    until(&mut conn, |m| {
        match m {
            DaemonMsg::State(s) => {
                needs_you |= s
                    .worktrees
                    .iter()
                    .any(|w| w.id == b && w.state == AgentState::NeedsYou);
            }
            DaemonMsg::Alert { pane, .. } => alerted |= *pane == b,
            _ => {}
        }
        (needs_you && alerted).then_some(())
    });
    assert!(wait_count(&rec, 1));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(rec.count(), 1);
}

#[test]
fn done_in_the_selected_worktree_notifies_when_the_window_is_unfocused() {
    let env = setup();
    let (c, rec) = with_recorder(&env);
    let mut conn = ui(&env, &c);
    let a = create(&mut conn, &env, "a");
    look(&mut conn, Some(&a), false);
    input(&mut conn, &a, "finish");
    state(&mut conn, |s| {
        s.worktrees
            .iter()
            .any(|w| w.id == a && w.state == AgentState::Done)
    });
    assert!(wait_count(&rec, 1));
}

#[test]
fn done_in_the_worktree_being_looked_at_does_not_notify() {
    let env = setup();
    let (c, rec) = with_recorder(&env);
    let mut conn = ui(&env, &c);
    let a = create(&mut conn, &env, "a");
    look(&mut conn, Some(&a), true);
    input(&mut conn, &a, "finish");
    state(&mut conn, |s| {
        s.worktrees
            .iter()
            .any(|w| w.id == a && w.state == AgentState::Idle)
    });
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(rec.count(), 0);
}

#[test]
fn done_without_any_ui_connected_notifies() {
    let env = setup();
    let (c, rec) = with_recorder(&env);
    let mut conn = ui(&env, &c);
    let a = create(&mut conn, &env, "a");
    look(&mut conn, Some(&a), true);
    input(&mut conn, &a, "finish");
    // A UI sai logo depois de mandar o input
    drop(conn);
    assert!(wait_count(&rec, 1));
}

#[test]
fn session_start_hook_records_the_session_id_used_on_restart() {
    let env = setup();
    let (c, _rec) = with_recorder(&env);
    let mut conn = ui(&env, &c);
    let a = create(&mut conn, &env, "a");
    std::thread::sleep(Duration::from_millis(500));
    conn.send(&ClientMsg::StopAgent { id: a.clone() })
        .unwrap_or_else(|e| panic!("{e}"));
    state(&mut conn, |s| {
        s.worktrees.iter().any(|w| w.id == a && !w.running)
    });
    conn.send(&ClientMsg::RestartAgent { id: a.clone() })
        .unwrap_or_else(|e| panic!("{e}"));
    look(&mut conn, Some(&a), true);
    screen_contains(&mut conn, &a, "--resume sess-from-hook");
}

#[test]
fn osc_notify_from_an_agent_without_hooks_needs_you() {
    let env = setup();
    let (c, rec) = with_recorder(&env);
    let mut conn = ui(&env, &c);
    let a = create_with(&mut conn, &env, "plain", "aider");
    look(&mut conn, None, false);
    input(&mut conn, &a, "osc");
    state(&mut conn, |s| {
        s.worktrees
            .iter()
            .any(|w| w.id == a && w.state == AgentState::NeedsYou)
    });
    assert!(wait_count(&rec, 1));
}

#[test]
fn silence_marks_an_agent_without_signals_as_done_and_notifies() {
    let env = setup();
    let (c, rec) = with_recorder(&env);
    let mut conn = ui(&env, &c);
    let a = create_with(&mut conn, &env, "quiet", "aider");
    state(&mut conn, |s| {
        s.worktrees
            .iter()
            .any(|w| w.id == a && w.state == AgentState::Done)
    });
    assert!(wait_count(&rec, 1));
}

#[test]
fn hook_without_a_daemon_exits_zero_quickly() {
    let dir = tempfile::Builder::new()
        .prefix("lw")
        .tempdir_in("/tmp")
        .unwrap_or_else(|e| panic!("{e}"));
    let started = std::time::Instant::now();
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_lisa-workspace"))
        .args(["hook", "Stop"])
        .env("LISA_WORKSPACE_RUNTIME_DIR", dir.path())
        .env("LISA_PANE_ID", "x/y")
        .stdin(std::process::Stdio::null())
        .status()
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(status.success());
    assert!(started.elapsed() < Duration::from_secs(2));
}
