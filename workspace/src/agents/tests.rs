use super::*;

fn argv(agent: AgentId, permission: Permission, session: SessionMode) -> Vec<String> {
    match launch_args(agent, permission, &session, &LaunchOptions::default()) {
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
        &LaunchOptions::default(),
    );
    assert!(matches!(result, Err(LaunchError::InvalidSessionId(_))));
}

#[test]
fn full_autonomy_on_agent_without_flag_is_rejected() {
    let result = launch_args(
        AgentId::Opencode,
        Permission::FullAutonomy,
        &SessionMode::New { session_id: None },
        &LaunchOptions::default(),
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

fn fresh() -> SessionMode {
    SessionMode::New { session_id: None }
}

fn with(id: AgentId, opts: LaunchOptions<'_>) -> Vec<String> {
    launch_args(id, Permission::Normal, &fresh(), &opts).unwrap_or_else(|e| panic!("{e}"))
}

#[test]
fn no_options_keeps_todays_command_line() {
    assert!(with(AgentId::Claude, LaunchOptions::default()).is_empty());
}

#[test]
fn claude_gets_model_effort_and_prompt_after_a_separator() {
    let opts = LaunchOptions {
        model: Some("opus"),
        effort: Some(Effort::High),
        prompt: Some("fix it"),
    };
    assert_eq!(
        with(AgentId::Claude, opts),
        ["--model", "opus", "--effort", "high", "--", "fix it"]
    );
}

#[test]
fn codex_effort_is_a_config_override() {
    let opts = LaunchOptions {
        model: Some("gpt-6.1-sol"),
        effort: Some(Effort::Medium),
        prompt: None,
    };
    assert_eq!(
        with(AgentId::Codex, opts),
        ["-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=medium"]
    );
}

#[test]
fn gemini_prompt_is_one_flag_argument() {
    let opts = LaunchOptions {
        model: Some("pro"),
        effort: None,
        prompt: Some("-v is broken"),
    };
    assert_eq!(
        with(AgentId::Gemini, opts),
        ["-m", "pro", "--prompt-interactive=-v is broken"]
    );
}

#[test]
fn autonomy_flags_come_before_the_prompt() {
    let opts = LaunchOptions {
        model: None,
        effort: None,
        prompt: Some("resume the upload"),
    };
    let args = launch_args(AgentId::Claude, Permission::FullAutonomy, &fresh(), &opts)
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        args,
        ["--dangerously-skip-permissions", "--", "resume the upload"]
    );
}

#[test]
fn resume_never_carries_the_prompt() {
    let opts = LaunchOptions {
        model: Some("opus"),
        effort: None,
        prompt: Some("x"),
    };
    let args = launch_args(
        AgentId::Claude,
        Permission::Normal,
        &SessionMode::Resume { session_id: None },
        &opts,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(args, ["--continue", "--model", "opus"]);
}

#[test]
fn invalid_combinations_are_refused() {
    let refuse = |id, opts: LaunchOptions<'_>| launch_args(id, Permission::Normal, &fresh(), &opts);
    assert_eq!(
        refuse(
            AgentId::Claude,
            LaunchOptions {
                model: Some("gpt-9"),
                ..Default::default()
            }
        ),
        Err(LaunchError::UnknownModel("gpt-9".into()))
    );
    assert!(matches!(
        refuse(
            AgentId::Claude,
            LaunchOptions {
                model: Some("haiku"),
                effort: Some(Effort::High),
                prompt: None,
            }
        ),
        Err(LaunchError::UnsupportedEffort { .. })
    ));
    assert!(matches!(
        refuse(
            AgentId::Codex,
            LaunchOptions {
                model: Some("gpt-6-luna"),
                effort: Some(Effort::Ultra),
                prompt: None,
            }
        ),
        Err(LaunchError::UnsupportedEffort { .. })
    ));
    assert!(matches!(
        refuse(
            AgentId::Claude,
            LaunchOptions {
                effort: Some(Effort::High),
                ..Default::default()
            }
        ),
        Err(LaunchError::UnsupportedEffort { .. })
    ));
    assert_eq!(
        refuse(
            AgentId::Opencode,
            LaunchOptions {
                prompt: Some("x"),
                ..Default::default()
            }
        ),
        Err(LaunchError::PromptUnsupported(AgentId::Opencode))
    );
    let big = "a".repeat(MAX_PROMPT_BYTES + 1);
    assert_eq!(
        refuse(
            AgentId::Claude,
            LaunchOptions {
                prompt: Some(&big),
                ..Default::default()
            }
        ),
        Err(LaunchError::PromptTooLarge)
    );
}

#[test]
fn every_tier_points_at_a_model_and_effort_the_catalog_has() {
    for id in AgentId::ALL {
        let Some(c) = catalog(id) else { continue };
        for (m, e) in c.tiers {
            let spec = model(id, m).unwrap_or_else(|| panic!("{} tier model {m}", id.name()));
            if let Some(e) = e {
                assert!(spec.efforts.contains(&e), "{} {m}", id.name());
            }
        }
        for m in c.models {
            if let Some(d) = m.default_effort {
                assert!(m.efforts.contains(&d), "{} {}", id.name(), m.id);
            }
        }
    }
}

#[test]
fn unverified_agents_never_reach_the_create_dialog() {
    let creatable = creatable_agents();
    for id in [
        AgentId::Grok,
        AgentId::Codebuddy,
        AgentId::Antigravity,
        AgentId::Muse,
        AgentId::Omp,
        AgentId::Cursor,
    ] {
        assert!(!creatable.contains(&id), "{}", id.name());
        assert!(catalog(id).is_some_and(|c| !c.verified), "{}", id.name());
    }
}

#[test]
fn only_three_catalogs_are_verified() {
    let verified: Vec<_> = AgentId::ALL
        .into_iter()
        .filter(|id| catalog(*id).is_some_and(|c| c.verified))
        .collect();
    assert_eq!(verified, [AgentId::Claude, AgentId::Gemini, AgentId::Codex]);
}
