use super::*;

fn argv(agent: AgentId, permission: Permission, session: SessionMode) -> Vec<String> {
    match launch_args(agent, permission, &session) {
        Ok(args) => args,
        Err(err) => panic!("launch_args failed: {err}"),
    }
}

#[test]
fn claude_normal_pins_session_id_without_skip_permissions() {
    let args = argv(
        AgentId::Claude,
        Permission::Normal,
        SessionMode::New {
            session_id: Some("0b7f3c1e-1111-4222-8333-944445555666".into()),
        },
    );
    assert_eq!(
        args,
        ["--session-id", "0b7f3c1e-1111-4222-8333-944445555666"]
    );
}

#[test]
fn claude_full_autonomy_adds_skip_permissions() {
    let args = argv(
        AgentId::Claude,
        Permission::FullAutonomy,
        SessionMode::New { session_id: None },
    );
    assert_eq!(args, ["--dangerously-skip-permissions"]);
}

#[test]
fn codex_full_autonomy_bypasses_approvals_and_never_ephemeral() {
    let args = argv(
        AgentId::Codex,
        Permission::FullAutonomy,
        SessionMode::New { session_id: None },
    );
    assert_eq!(args, ["--dangerously-bypass-approvals-and-sandbox"]);
    assert!(!args.iter().any(|a| a == "--ephemeral"));
}

#[test]
fn gemini_full_autonomy_uses_yolo() {
    let args = argv(
        AgentId::Gemini,
        Permission::FullAutonomy,
        SessionMode::New { session_id: None },
    );
    assert_eq!(args, ["--yolo"]);
}

#[test]
fn codex_resume_without_id_uses_last() {
    let args = argv(
        AgentId::Codex,
        Permission::Normal,
        SessionMode::Resume { session_id: None },
    );
    assert_eq!(args, ["resume", "--last"]);
}

#[test]
fn codex_resume_by_id_puts_subcommand_before_flags() {
    let args = argv(
        AgentId::Codex,
        Permission::FullAutonomy,
        SessionMode::Resume {
            session_id: Some("abc-123".into()),
        },
    );
    assert_eq!(
        args,
        [
            "resume",
            "abc-123",
            "--dangerously-bypass-approvals-and-sandbox"
        ]
    );
}

#[test]
fn aider_resume_restores_chat_history_without_session() {
    let args = argv(
        AgentId::Aider,
        Permission::Normal,
        SessionMode::Resume {
            session_id: Some("ignored".into()),
        },
    );
    assert_eq!(args, ["--restore-chat-history"]);
}

#[test]
fn opencode_resume_by_id_uses_session_flag() {
    let args = argv(
        AgentId::Opencode,
        Permission::Normal,
        SessionMode::Resume {
            session_id: Some("ses_1".into()),
        },
    );
    assert_eq!(args, ["--session", "ses_1"]);
}

#[test]
fn goose_runs_interactive_session_subcommand() {
    let args = argv(
        AgentId::Goose,
        Permission::Normal,
        SessionMode::New { session_id: None },
    );
    assert_eq!(args, ["session"]);
}

#[test]
fn session_id_with_control_character_is_rejected() {
    let result = launch_args(
        AgentId::Claude,
        Permission::Normal,
        &SessionMode::Resume {
            session_id: Some("abc\u{1b}[2J".into()),
        },
    );
    assert!(matches!(result, Err(LaunchError::InvalidSessionId(_))));
}

#[test]
fn full_autonomy_on_agent_without_flag_is_rejected() {
    let result = launch_args(
        AgentId::Opencode,
        Permission::FullAutonomy,
        &SessionMode::New { session_id: None },
    );
    assert!(matches!(
        result,
        Err(LaunchError::AutonomyUnsupported(AgentId::Opencode))
    ));
}

#[test]
fn cursor_is_hidden_from_creation_until_interactive_mode_is_verified() {
    assert!(!spec(AgentId::Cursor).interactive_verified);
    assert!(!creatable_agents().contains(&AgentId::Cursor));
}

#[test]
fn every_lisa_provider_name_has_an_agent() {
    for name in [
        "claude", "gemini", "opencode", "copilot", "cursor", "goose", "aider", "codex", "kilo",
        "mimo",
    ] {
        assert!(AgentId::from_name(name).is_some(), "missing agent {name}");
    }
}

#[test]
fn agent_without_binary_on_path_is_unavailable() {
    let path = std::env::temp_dir().join("lisa-empty-path-for-tests");
    assert!(resolve_binary(AgentId::Claude, Some(path.as_os_str())).is_none());
}

#[test]
fn cursor_accepts_either_binary_name() {
    assert_eq!(spec(AgentId::Cursor).binaries, ["agent", "cursor-agent"]);
}
