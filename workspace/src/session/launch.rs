//! Monta o `Launch` de um agente a partir do catálogo, pelo shell de login.

use std::path::Path;

use super::pty::Launch;
use crate::agents::{self, AgentId, Effort, LaunchError, LaunchOptions, Permission, SessionMode};

/// Script que troca o shell pelo agente, recebendo programa e argumentos como `$0 "$@"`
/// (sem montar string de comando, então nada precisa de escape).
const EXEC_SCRIPT: &str = "exec \"$0\" \"$@\"";

pub struct LaunchRequest<'a> {
    pub agent: AgentId,
    pub permission: Permission,
    pub session: SessionMode,
    pub model: Option<String>,
    pub effort: Option<Effort>,
    /// Tarefa inicial; só entra em sessão nova.
    pub prompt: Option<String>,
    /// Argumentos do daemon (ex.: `--settings` dos hooks); entram antes do prompt.
    pub extra_args: Vec<String>,
    pub cwd: &'a Path,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

/// Shells que entendem `-lc` com `"$0" "$@"`.
const POSIX_SHELLS: [&str; 5] = ["sh", "bash", "zsh", "dash", "ksh"];

/// Shell de login do ambiente da UI quando é POSIX; senão `/bin/sh` (fish, nushell e
/// tcsh não aceitam o script de exec, e o PATH já vem no ambiente da UI).
fn login_shell(env: &[(String, String)]) -> String {
    env.iter()
        .find(|(k, _)| k == "SHELL")
        .map(|(_, v)| v.clone())
        .filter(|v| {
            std::path::Path::new(v)
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| POSIX_SHELLS.contains(&n))
        })
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
        &LaunchOptions {
            model: req.model.as_deref(),
            effort: req.effort,
            prompt: None,
        },
    )?);
    args.extend(req.extra_args);
    args.extend(agents::prompt_args(
        req.agent,
        &req.session,
        req.prompt.as_deref(),
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
            model: None,
            effort: None,
            prompt: None,
            extra_args: Vec::new(),
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
    fn prompt_reaches_the_agent_as_one_untouched_argument() {
        let prompt = "a 'b' \"c\" `d` $(e)\nf";
        let mut req = request(vec![("SHELL".into(), "/bin/zsh".into())]);
        req.prompt = Some(prompt.to_owned());
        let launch = build_launch(req).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(launch.args[1], EXEC_SCRIPT);
        assert_eq!(launch.args.last().map(String::as_str), Some(prompt));
    }

    #[test]
    fn daemon_arguments_come_before_the_prompt_separator() {
        let mut req = request(Vec::new());
        req.prompt = Some("do it".to_owned());
        req.extra_args = vec!["--settings".to_owned(), "/s.json".to_owned()];
        let launch = build_launch(req).unwrap_or_else(|e| panic!("{e}"));
        let tail = &launch.args[launch.args.len() - 4..];
        assert_eq!(tail, ["--settings", "/s.json", "--", "do it"]);
    }

    #[test]
    fn non_posix_login_shell_falls_back_to_sh() {
        for shell in ["/opt/homebrew/bin/fish", "/usr/local/bin/nu", "/bin/tcsh"] {
            let launch = build_launch(request(vec![("SHELL".into(), shell.into())]))
                .unwrap_or_else(|e| panic!("{e}"));
            assert_eq!(launch.program, "/bin/sh", "{shell}");
        }
    }

    #[test]
    fn missing_shell_falls_back_to_sh() {
        let launch = build_launch(request(Vec::new())).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(launch.program, "/bin/sh");
    }
}
