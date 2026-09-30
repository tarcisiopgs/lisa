//! Ambiente compartilhado dos testes de ponta a ponta do Workspace.
#![allow(dead_code)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use lisa_workspace::daemon::client::{Connector, Handshake};
use lisa_workspace::daemon::service::Workspace;
use lisa_workspace::daemon::{BuildInfo, Daemon, RuntimePaths};
use lisa_workspace::protocol::work::{PermissionWire, WorkspaceState};
use lisa_workspace::protocol::{ClientKind, ClientMsg, Conn, DaemonMsg};
use tempfile::TempDir;

pub struct Env {
    pub _tmp: TempDir,
    pub root: PathBuf,
    pub repo: PathBuf,
    pub bin: PathBuf,
    pub paths: RuntimePaths,
}

pub fn git(dir: &Path, args: &[&str]) {
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

pub fn write_exec(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap_or_else(|e| panic!("{e}"));
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .unwrap_or_else(|e| panic!("{e}"));
}

pub fn setup() -> Env {
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
    // Agente falso "claude": mostra os argumentos, ecoa linhas e dispara os hooks do
    // arquivo passado em --settings (permit → Notification, finish → Stop)
    write_exec(
        &bin.join("claude"),
        r#"#!/bin/sh
settings=""
prev=""
for a in "$@"; do [ "$prev" = "--settings" ] && settings="$a"; prev="$a"; done
hook() {
  exe=$(sed -n "s/.*\"command\": \"'\(.*\)' hook $1\".*/\1/p" "$settings" | head -1)
  printf '%s' "$2" | "$exe" hook "$1"
}
echo "fake-claude-ready args:$*"
[ -n "$settings" ] && hook SessionStart '{"session_id":"sess-from-hook"}'
while IFS= read -r line; do
  case "$line" in
    permit) hook Notification '{"notification_type":"permission_prompt"}';;
    finish) hook Stop '{}';;
    *) echo "echo:$line";;
  esac
done
"#,
    );
    // Agente falso sem hooks nem título: "aider"; `osc` emite OSC 777
    write_exec(
        &bin.join("aider"),
        "#!/bin/sh\necho aider-ready\nwhile IFS= read -r line; do\n  case \"$line\" in\n    osc) printf '\\033]777;notify;aider;attention\\007';;\n    *) echo \"echo:$line\";;\n  esac\ndone\n",
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

pub fn start(env: &Env) -> Connector {
    start_with(env, |w| w)
}

/// Sobe o daemon com um `Workspace` ajustado por `configure`.
pub fn start_with(
    env: &Env,
    configure: impl Fn(Workspace) -> Workspace + Send + Sync + 'static,
) -> Connector {
    let paths = env.paths.clone();
    let state_file = env.root.join("state/state.json");
    let worktrees = env.root.join("workspaces");
    let spawn_paths = paths.clone();
    let configure = Arc::new(configure);
    Connector::new(
        paths,
        BuildInfo {
            binary_version: "t".into(),
            build_id: "t".into(),
        },
        Box::new(move || {
            let p = spawn_paths.clone();
            let workspace = Workspace::open(state_file.clone(), worktrees.clone())
                .unwrap_or_else(|e| panic!("{e}"))
                .with_hook_exe(PathBuf::from(env!("CARGO_BIN_EXE_lisa-workspace")))
                .with_runtime_dir(p.dir.clone());
            let workspace = configure(workspace);
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

pub fn ui(env: &Env, connector: &Connector) -> Conn {
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
pub fn until<T>(conn: &mut Conn, mut pred: impl FnMut(&DaemonMsg) -> Option<T>) -> T {
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

pub fn state(conn: &mut Conn, mut pred: impl FnMut(&WorkspaceState) -> bool) -> WorkspaceState {
    until(conn, |m| match m {
        DaemonMsg::State(s) if pred(s) => Some(s.clone()),
        _ => None,
    })
}

pub fn screen_contains(conn: &mut Conn, pane: &str, needle: &str) {
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

pub fn create(conn: &mut Conn, env: &Env, name: &str) -> String {
    create_with(conn, env, name, "claude")
}

pub fn create_with(conn: &mut Conn, env: &Env, name: &str, agent: &str) -> String {
    let already = {
        conn.send(&ClientMsg::AddProject {
            path: env.repo.display().to_string(),
        })
        .unwrap_or_else(|e| panic!("{e}"));
        until(conn, |m| match m {
            DaemonMsg::State(s) if !s.projects.is_empty() => Some(s.projects[0].slug.clone()),
            DaemonMsg::Error(e) if e.contains("already registered") => Some(String::new()),
            _ => None,
        })
    };
    let project = if already.is_empty() {
        state(conn, |s| !s.projects.is_empty()).projects[0]
            .slug
            .clone()
    } else {
        already
    };
    conn.send(&ClientMsg::CreateWorktree {
        project,
        name: name.into(),
        agent: agent.into(),
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
