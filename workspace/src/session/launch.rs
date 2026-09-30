//! Monta o `Launch` de um agente a partir do catálogo, pelo shell de login.

use std::path::Path;

use super::pty::Launch;
use crate::agents::{self, AgentId, LaunchError, Permission, SessionMode};

/// Script que troca o shell pelo agente, recebendo programa e argumentos como `$0 "$@"`
/// (sem montar string de comando, então nada precisa de escape).
const EXEC_SCRIPT: &str = "exec \"$0\" \"$@\"";

pub struct LaunchRequest<'a> {
    pub agent: AgentId,
    pub permission: Permission,
    pub session: SessionMode,
    pub cwd: &'a Path,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

/// Shell de login do ambiente da UI, senão `/bin/sh`.
fn login_shell(env: &[(String, String)]) -> String {
    env.iter()
        .find(|(k, _)| k == "SHELL")
        .map(|(_, v)| v.clone())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "/bin/sh".to_owned())
}

pub fn build_launch(req: LaunchRequest<'_>) -> Result<Launch, LaunchError> {
    let spec = agents::spec(req.agent);
    let binary = spec.binaries.first().copied().unwrap_or(spec.name);
    let mut args = vec!["-lc".to_owned(), EXEC_SCRIPT.to_owned(), binary.to_owned()];
    args.extend(agents::launch_args(
        req.agent,
        req.permission,
        &req.session,
    )?);
    Ok(Launch {
        program: login_shell(&req.env),
        args,
        cwd: req.cwd.to_owned(),
        env: req.env,
        cols: req.cols,
        rows: req.rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(env: Vec<(String, String)>) -> LaunchRequest<'static> {
        LaunchRequest {
            agent: AgentId::Claude,
            permission: Permission::Normal,
            session: SessionMode::New {
                session_id: Some("abc".into()),
            },
            cwd: Path::new("/tmp"),
            env,
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn agent_runs_through_the_users_login_shell() {
        let launch = build_launch(request(vec![("SHELL".into(), "/bin/zsh".into())]))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(launch.program, "/bin/zsh");
        assert_eq!(
            launch.args,
            ["-lc", EXEC_SCRIPT, "claude", "--session-id", "abc"]
        );
    }

    #[test]
    fn missing_shell_falls_back_to_sh() {
        let launch = build_launch(request(Vec::new())).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(launch.program, "/bin/sh");
    }
}
