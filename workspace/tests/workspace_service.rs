//! Serviço do Workspace de ponta a ponta: daemon real, repositório git temporário e
//! um agente falso. O agente é injetado por um `SHELL` de teste que ignora `-lc` e
//! executa o binário falso de mesmo nome, sem ganchos de teste no código de produção.

mod common;

use common::*;
use lisa_workspace::daemon::service::Workspace;
use lisa_workspace::protocol::work::{AgentState, PermissionWire};
use lisa_workspace::protocol::{ClientMsg, DaemonMsg};

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
        model: None,
        effort: None,
        prompt: None,
    })
    .unwrap_or_else(|e| panic!("{e}"));
    let err = until(&mut conn, |m| match m {
        DaemonMsg::Error(e) => Some(e.clone()),
        _ => None,
    });
    assert!(err.contains("gemini"), "{err}");
    assert!(!env.root.join("workspaces/repo/nope").exists());
}

const TASK: &str = "fix 'it' $(now) `x`\nplease";

#[test]
fn chosen_model_effort_and_prompt_reach_the_agent() {
    let env = setup();
    let c = start(&env);
    let mut conn = ui(&env, &c);
    create_full(
        &mut conn,
        &env,
        "routed",
        "claude",
        Some("opus"),
        Some("high"),
        Some(TASK),
    );
    let args = argv(&env, "routed");
    let tail = &args[args.len() - 6..];
    assert_eq!(tail, ["--model", "opus", "--effort", "high", "--", TASK]);
}

#[test]
fn restart_keeps_model_and_effort_and_drops_the_prompt() {
    let env = setup();
    let c = start(&env);
    let mut conn = ui(&env, &c);
    let id = create_full(
        &mut conn,
        &env,
        "again",
        "claude",
        Some("opus"),
        Some("high"),
        Some(TASK),
    );
    argv(&env, "again");
    conn.send(&ClientMsg::StopAgent { id: id.clone() })
        .unwrap_or_else(|e| panic!("{e}"));
    state(&mut conn, |s| {
        s.worktrees.iter().any(|w| w.id == id && !w.running)
    });
    forget_argv(&env, "again");
    conn.send(&ClientMsg::RestartAgent { id })
        .unwrap_or_else(|e| panic!("{e}"));
    let args = argv(&env, "again");
    let joined = args.join(" ");
    assert!(joined.contains("--model opus --effort high"), "{joined}");
    assert!(!args.iter().any(|a| a == "--" || a == TASK), "{joined}");
}

fn refused(model: Option<&str>, agent: &str, prompt: Option<&str>, name: &str) -> (String, Env) {
    let env = setup();
    let c = start(&env);
    let mut conn = ui(&env, &c);
    let project = project(&mut conn, &env);
    conn.send(&ClientMsg::CreateWorktree {
        project,
        name: name.into(),
        agent: agent.into(),
        permission: PermissionWire::Normal,
        model: model.map(str::to_owned),
        effort: None,
        prompt: prompt.map(str::to_owned),
    })
    .unwrap_or_else(|e| panic!("{e}"));
    let err = until(&mut conn, |m| match m {
        DaemonMsg::Error(e) => Some(e.clone()),
        _ => None,
    });
    (err, env)
}

#[test]
fn unknown_model_is_refused_before_any_worktree_exists() {
    let (err, env) = refused(Some("gpt-9"), "claude", None, "badmodel");
    assert!(err.contains("gpt-9"), "{err}");
    assert!(!env.root.join("workspaces/repo/badmodel").exists());
}

#[test]
fn prompt_for_an_agent_without_delivery_is_refused() {
    let (err, env) = refused(None, "aider", Some("do it"), "notask");
    assert!(err.contains("aider"), "{err}");
    assert!(!env.root.join("workspaces/repo/notask").exists());
}

#[test]
fn state_from_2_0_0_loads_without_model_fields() {
    let env = setup();
    let c = start(&env);
    let mut conn = ui(&env, &c);
    let id = create(&mut conn, &env, "old");
    drop(conn);
    let file = env.root.join("state/state.json");
    let raw = std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("{e}"));
    let mut json: serde_json::Value = serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{e}"));
    // Como a 2.0.0 gravava: sem os campos de modelo e effort
    for wt in json["worktrees"].as_array_mut().into_iter().flatten() {
        if let Some(o) = wt.as_object_mut() {
            o.remove("model");
            o.remove("effort");
        }
    }
    let other = env.root.join("old-state.json");
    std::fs::write(&other, json.to_string()).unwrap_or_else(|e| panic!("{e}"));
    let reopened =
        Workspace::open(other, env.root.join("workspaces")).unwrap_or_else(|e| panic!("{e}"));
    assert!(reopened.state().worktrees.iter().any(|w| w.id == id));
}
