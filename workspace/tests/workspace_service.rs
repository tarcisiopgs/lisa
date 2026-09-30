//! Serviço do Workspace de ponta a ponta: daemon real, repositório git temporário e
//! um agente falso. O agente é injetado por um `SHELL` de teste que ignora `-lc` e
//! executa o binário falso de mesmo nome, sem ganchos de teste no código de produção.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use lisa_workspace::daemon::client::{Connector, Handshake};
use lisa_workspace::daemon::service::Workspace;
use lisa_workspace::daemon::{BuildInfo, Daemon, RuntimePaths};
use lisa_workspace::protocol::work::{AgentState, PermissionWire, WorkspaceState};
use lisa_workspace::protocol::{ClientKind, ClientMsg, Conn, DaemonMsg};
use tempfile::TempDir;

struct Env {
    _tmp: TempDir,
    root: PathBuf,
    repo: PathBuf,
    bin: PathBuf,
    paths: RuntimePaths,
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .status()
        .is_ok_and(|s| s.success());
    assert!(ok, "git {args:?}");
}

fn write_exec(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap_or_else(|e| panic!("{e}"));
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .unwrap_or_else(|e| panic!("{e}"));
}

fn setup() -> Env {
    let tmp = tempfile::Builder::new()
        .prefix("lw")
        .tempdir_in("/tmp")
        .unwrap_or_else(|e| panic!("{e}"));
    let root = tmp.path().to_path_buf();
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap_or_else(|e| panic!("{e}"));
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("README"), "x").unwrap_or_else(|e| panic!("{e}"));
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);

    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap_or_else(|e| panic!("{e}"));
    // SHELL de teste: `shell -lc SCRIPT agent args...` → executa bin/agent args...
    write_exec(
        &bin.join("fakeshell"),
        &format!("#!/bin/sh\nshift 2\nexec {}/\"$@\"\n", bin.display()),
    );
    // Agente falso: mostra os argumentos e ecoa cada linha digitada
    write_exec(
        &bin.join("claude"),
        "#!/bin/sh\necho \"fake-claude-ready args:$*\"\nwhile IFS= read -r line; do echo \"echo:$line\"; done\n",
    );
    let paths = RuntimePaths::in_dir(root.join("rt"));
    Env {
        _tmp: tmp,
        root,
        repo,
        bin,
        paths,
    }
}

fn start(env: &Env) -> Connector {
    let paths = env.paths.clone();
    let state_file = env.root.join("state/state.json");
    let worktrees = env.root.join("workspaces");
    let spawn_paths = paths.clone();
    Connector::new(
        paths,
        BuildInfo {
            binary_version: "t".into(),
            build_id: "t".into(),
        },
        Box::new(move || {
            let p = spawn_paths.clone();
            let workspace = Workspace::open(state_file.clone(), worktrees.clone())
                .unwrap_or_else(|e| panic!("{e}"));
            thread::spawn(move || {
                let _ = Daemon::new(
                    p,
                    BuildInfo {
                        binary_version: "t".into(),
                        build_id: "t".into(),
                    },
                    Arc::new(workspace),
                )
                .run();
            });
            Ok(())
        }),
    )
}

fn ui(env: &Env, connector: &Connector) -> Conn {
    let mut conn = match connector.connect(ClientKind::Ui) {
        Ok(Handshake::Attached { conn, .. }) => conn,
        other => panic!("attach failed: {:?}", other.map(|_| ())),
    };
    let ui_env = vec![
        (
            "SHELL".into(),
            env.bin.join("fakeshell").display().to_string(),
        ),
        (
            "PATH".into(),
            format!("{}:/usr/bin:/bin", env.bin.display()),
        ),
    ];
    conn.set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap_or_else(|e| panic!("{e}"));
    conn.send(&ClientMsg::Attach {
        cols: 80,
        rows: 20,
        env: ui_env,
    })
    .unwrap_or_else(|e| panic!("{e}"));
    conn
}

/// Lê mensagens até `pred` aceitar uma ou o prazo acabar.
fn until<T>(conn: &mut Conn, mut pred: impl FnMut(&DaemonMsg) -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        match conn.recv_daemon() {
            Ok(msg) => {
                if let Some(v) = pred(&msg) {
                    return v;
                }
            }
            Err(e) => panic!("connection lost: {e}"),
        }
    }
    panic!("timed out waiting for message");
}

fn state(conn: &mut Conn, mut pred: impl FnMut(&WorkspaceState) -> bool) -> WorkspaceState {
    until(conn, |m| match m {
        DaemonMsg::State(s) if pred(s) => Some(s.clone()),
        _ => None,
    })
}

fn screen_contains(conn: &mut Conn, pane: &str, needle: &str) {
    let mut text = String::new();
    until(conn, |m| {
        match m {
            DaemonMsg::Snapshot { pane: p, snapshot } if p == pane => {
                text = snapshot
                    .lines
                    .iter()
                    .map(|l| l.cells.iter().map(|c| c.ch).collect::<String>())
                    .collect();
            }
            DaemonMsg::Diff { pane: p, diff } if p == pane => {
                for (_, line) in &diff.lines {
                    text.push_str(&line.cells.iter().map(|c| c.ch).collect::<String>());
                }
            }
            _ => {}
        }
        text.contains(needle).then_some(())
    });
}

fn create(conn: &mut Conn, env: &Env, name: &str) -> String {
    conn.send(&ClientMsg::AddProject {
        path: env.repo.display().to_string(),
    })
    .unwrap_or_else(|e| panic!("{e}"));
    let s = state(conn, |s| !s.projects.is_empty());
    let project = s.projects[0].slug.clone();
    conn.send(&ClientMsg::CreateWorktree {
        project,
        name: name.into(),
        agent: "claude".into(),
        permission: PermissionWire::Normal,
    })
    .unwrap_or_else(|e| panic!("{e}"));
    let s = state(conn, |s| s.worktrees.iter().any(|w| w.name == name));
    s.worktrees
        .iter()
        .find(|w| w.name == name)
        .map(|w| w.id.clone())
        .unwrap_or_default()
}

#[test]
fn creating_a_worktree_starts_the_agent_and_focusing_streams_its_screen() {
    let env = setup();
    let c = start(&env);
    let mut conn = ui(&env, &c);
    let id = create(&mut conn, &env, "feature");
    conn.send(&ClientMsg::Focus {
        worktree: Some(id.clone()),
        window_focused: true,
    })
    .unwrap_or_else(|e| panic!("{e}"));
    screen_contains(&mut conn, &id, "fake-claude-ready args:--session-id");
}

#[test]
fn input_goes_to_the_focused_agent() {
    let env = setup();
    let c = start(&env);
    let mut conn = ui(&env, &c);
    let id = create(&mut conn, &env, "typing");
    conn.send(&ClientMsg::Focus {
        worktree: Some(id.clone()),
        window_focused: true,
    })
    .unwrap_or_else(|e| panic!("{e}"));
    screen_contains(&mut conn, &id, "fake-claude-ready");
    conn.send(&ClientMsg::Input {
        pane: id.clone(),
        bytes: b"hello\r".to_vec(),
    })
    .unwrap_or_else(|e| panic!("{e}"));
    screen_contains(&mut conn, &id, "echo:hello");
}

#[test]
fn removing_a_dirty_worktree_is_refused_and_the_agent_keeps_running() {
    let env = setup();
    let c = start(&env);
    let mut conn = ui(&env, &c);
    let id = create(&mut conn, &env, "dirty");
    let wt = env.root.join("workspaces/repo/dirty");
    std::fs::write(wt.join("README"), "changed").unwrap_or_else(|e| panic!("{e}"));
    conn.send(&ClientMsg::RemoveWorktree {
        id: id.clone(),
        force: false,
    })
    .unwrap_or_else(|e| panic!("{e}"));
    let reason = until(&mut conn, |m| match m {
        DaemonMsg::RemovalRefused { id: i, reason } if *i == id => Some(reason.clone()),
        _ => None,
    });
    assert!(reason.contains("uncommitted"), "{reason}");
    // O agente segue vivo: responde a input
    conn.send(&ClientMsg::Focus {
        worktree: Some(id.clone()),
        window_focused: true,
    })
    .unwrap_or_else(|e| panic!("{e}"));
    conn.send(&ClientMsg::Input {
        pane: id.clone(),
        bytes: b"still\r".to_vec(),
    })
    .unwrap_or_else(|e| panic!("{e}"));
    screen_contains(&mut conn, &id, "echo:still");
    assert!(wt.exists());
}

#[test]
fn removing_a_clean_worktree_stops_the_agent_and_drops_it() {
    let env = setup();
    let c = start(&env);
    let mut conn = ui(&env, &c);
    let id = create(&mut conn, &env, "clean");
    conn.send(&ClientMsg::RemoveWorktree {
        id: id.clone(),
        force: false,
    })
    .unwrap_or_else(|e| panic!("{e}"));
    state(&mut conn, |s| s.worktrees.iter().all(|w| w.id != id));
    assert!(!env.root.join("workspaces/repo/clean").exists());
}

#[test]
fn restarting_a_stopped_agent_resumes_its_session() {
    let env = setup();
    let c = start(&env);
    let mut conn = ui(&env, &c);
    let id = create(&mut conn, &env, "resume");
    conn.send(&ClientMsg::StopAgent { id: id.clone() })
        .unwrap_or_else(|e| panic!("{e}"));
    state(&mut conn, |s| {
        s.worktrees
            .iter()
            .any(|w| w.id == id && !w.running && w.state == AgentState::Idle)
    });
    conn.send(&ClientMsg::RestartAgent { id: id.clone() })
        .unwrap_or_else(|e| panic!("{e}"));
    conn.send(&ClientMsg::Focus {
        worktree: Some(id.clone()),
        window_focused: true,
    })
    .unwrap_or_else(|e| panic!("{e}"));
    screen_contains(&mut conn, &id, "args:--resume");
}

#[test]
fn state_survives_a_daemon_restart_with_agents_marked_stopped() {
    let env = setup();
    let c = start(&env);
    let mut conn = ui(&env, &c);
    let id = create(&mut conn, &env, "persist");
    drop(conn);
    // Um daemon novo (outro processo, na prática) lê o registro salvo
    let reopened = Workspace::open(
        env.root.join("state/state.json"),
        env.root.join("workspaces"),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let s = reopened.state();
    let wt = s
        .worktrees
        .iter()
        .find(|w| w.id == id)
        .unwrap_or_else(|| panic!("worktree lost"));
    assert!(!wt.running);
    assert_eq!(wt.agent.as_deref(), Some("claude"));
}

#[test]
fn creating_with_an_agent_missing_from_path_fails_before_creating_the_worktree() {
    let env = setup();
    let c = start(&env);
    let mut conn = ui(&env, &c);
    conn.send(&ClientMsg::AddProject {
        path: env.repo.display().to_string(),
    })
    .unwrap_or_else(|e| panic!("{e}"));
    let s = state(&mut conn, |s| !s.projects.is_empty());
    conn.send(&ClientMsg::CreateWorktree {
        project: s.projects[0].slug.clone(),
        name: "nope".into(),
        agent: "gemini".into(),
        permission: PermissionWire::Normal,
    })
    .unwrap_or_else(|e| panic!("{e}"));
    let err = until(&mut conn, |m| match m {
        DaemonMsg::Error(e) => Some(e.clone()),
        _ => None,
    });
    assert!(err.contains("gemini"), "{err}");
    assert!(!env.root.join("workspaces/repo/nope").exists());
}
