//! Catálogo de agentes: como cada CLI sobe em modo interativo, com autonomia
//! total e com resume. Espelha os nomes de provider da Lisa em TypeScript.

use std::ffi::OsStr;
use std::path::PathBuf;

mod catalog;

pub use catalog::{
    Effort, EffortArg, MAX_PROMPT_BYTES, ModelCatalog, ModelSpec, PromptArg, catalog, model,
};

/// Agentes que a Lisa conhece. Os nomes batem com `src/providers/` do lado Node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentId {
    Claude,
    Gemini,
    Opencode,
    Copilot,
    Cursor,
    Goose,
    Aider,
    Codex,
    Kilo,
    Mimo,
}

impl AgentId {
    pub const ALL: [AgentId; 10] = [
        AgentId::Claude,
        AgentId::Gemini,
        AgentId::Opencode,
        AgentId::Copilot,
        AgentId::Cursor,
        AgentId::Goose,
        AgentId::Aider,
        AgentId::Codex,
        AgentId::Kilo,
        AgentId::Mimo,
    ];

    pub fn name(self) -> &'static str {
        spec(self).name
    }

    pub fn from_name(name: &str) -> Option<AgentId> {
        AgentId::ALL.into_iter().find(|id| id.name() == name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    /// Comportamento interativo normal do agente: ele pede permissão.
    Normal,
    /// Flag de pular permissões do agente.
    FullAutonomy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionMode {
    /// Sessão nova; `session_id` só é usado pelos agentes que aceitam um id definido pela Lisa.
    New { session_id: Option<String> },
    /// Retoma por id quando houver, senão "a última sessão nesta pasta".
    Resume { session_id: Option<String> },
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LaunchError {
    #[error("session id {0:?} contains characters that are not allowed")]
    InvalidSessionId(String),
    #[error("{} has no full-autonomy flag in interactive mode", .0.name())]
    AutonomyUnsupported(AgentId),
    #[error("unknown model {0:?}")]
    UnknownModel(String),
    #[error("model {model} does not support effort {effort}")]
    UnsupportedEffort { model: String, effort: &'static str },
    #[error("{} cannot receive a task at launch", .0.name())]
    PromptUnsupported(AgentId),
    #[error("task is too long (max 100,000 bytes)")]
    PromptTooLarge,
}

/// Escolhas opcionais de um lançamento; vazio mantém os padrões da CLI.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LaunchOptions<'a> {
    pub model: Option<&'a str>,
    pub effort: Option<Effort>,
    /// Entregue só em sessão nova.
    pub prompt: Option<&'a str>,
}

/// Como uma CLI de agente sobe em modo interativo.
#[derive(Debug)]
pub struct AgentSpec {
    pub name: &'static str,
    /// Binários aceitos, na ordem de preferência.
    pub binaries: &'static [&'static str],
    /// Argumentos fixos antes de qualquer outro (ex.: subcomando).
    pub base_args: &'static [&'static str],
    /// Flags de autonomia total; `None` quando o modo interativo não tem.
    pub autonomy_args: Option<&'static [&'static str]>,
    /// Flag que aceita um id de sessão definido pela Lisa ao criar.
    pub new_session_flag: Option<&'static str>,
    pub resume: Resume,
    /// Modo interativo conferido; agentes não conferidos ficam fora da criação.
    pub interactive_verified: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum Resume {
    /// `<flag> <id>` por id, `last` para a última sessão da pasta.
    Flag {
        by_id: &'static str,
        last: &'static [&'static str],
    },
    /// Subcomando antes das flags: `<sub> <id>` ou `<sub> <last...>`.
    Subcommand {
        sub: &'static str,
        last: &'static [&'static str],
    },
    /// Sem sessões: só reabre o histórico da pasta.
    HistoryOnly(&'static [&'static str]),
}

static SPECS: [AgentSpec; 10] = [
    AgentSpec {
        name: "claude",
        binaries: &["claude"],
        base_args: &[],
        autonomy_args: Some(&["--dangerously-skip-permissions"]),
        new_session_flag: Some("--session-id"),
        resume: Resume::Flag {
            by_id: "--resume",
            last: &["--continue"],
        },
        interactive_verified: true,
    },
    AgentSpec {
        name: "gemini",
        binaries: &["gemini"],
        base_args: &[],
        autonomy_args: Some(&["--yolo"]),
        new_session_flag: Some("--session-id"),
        resume: Resume::Flag {
            by_id: "--resume",
            last: &["--resume", "latest"],
        },
        interactive_verified: true,
    },
    AgentSpec {
        name: "opencode",
        binaries: &["opencode"],
        base_args: &[],
        autonomy_args: None,
        new_session_flag: None,
        resume: Resume::Flag {
            by_id: "--session",
            last: &["--continue"],
        },
        interactive_verified: true,
    },
    AgentSpec {
        name: "copilot",
        binaries: &["copilot"],
        base_args: &[],
        autonomy_args: Some(&["--allow-all"]),
        new_session_flag: None,
        resume: Resume::Flag {
            by_id: "--resume",
            last: &["--continue"],
        },
        interactive_verified: true,
    },
    AgentSpec {
        name: "cursor",
        binaries: &["agent", "cursor-agent"],
        base_args: &[],
        autonomy_args: Some(&["--force"]),
        new_session_flag: None,
        resume: Resume::Flag {
            by_id: "--resume",
            last: &["--continue"],
        },
        interactive_verified: false,
    },
    AgentSpec {
        name: "goose",
        binaries: &["goose"],
        base_args: &["session"],
        autonomy_args: None,
        new_session_flag: None,
        resume: Resume::Flag {
            by_id: "--resume --session-id",
            last: &["--resume"],
        },
        interactive_verified: true,
    },
    AgentSpec {
        name: "aider",
        binaries: &["aider"],
        base_args: &[],
        autonomy_args: Some(&["--yes-always"]),
        new_session_flag: None,
        resume: Resume::HistoryOnly(&["--restore-chat-history"]),
        interactive_verified: true,
    },
    AgentSpec {
        name: "codex",
        binaries: &["codex"],
        base_args: &[],
        autonomy_args: Some(&["--dangerously-bypass-approvals-and-sandbox"]),
        new_session_flag: None,
        resume: Resume::Subcommand {
            sub: "resume",
            last: &["--last"],
        },
        interactive_verified: true,
    },
    AgentSpec {
        name: "kilo",
        binaries: &["kilo"],
        base_args: &[],
        autonomy_args: Some(&["--auto"]),
        new_session_flag: None,
        resume: Resume::Flag {
            by_id: "--session",
            last: &["--continue"],
        },
        interactive_verified: true,
    },
    AgentSpec {
        name: "mimo",
        binaries: &["mimo"],
        base_args: &[],
        autonomy_args: None,
        new_session_flag: None,
        resume: Resume::Flag {
            by_id: "--session",
            last: &["--continue"],
        },
        interactive_verified: true,
    },
];

pub fn spec(id: AgentId) -> &'static AgentSpec {
    let index = AgentId::ALL.iter().position(|a| *a == id).unwrap_or(0);
    &SPECS[index]
}

/// Agentes que podem aparecer no diálogo de criação.
pub fn creatable_agents() -> Vec<AgentId> {
    AgentId::ALL
        .into_iter()
        .filter(|id| spec(*id).interactive_verified)
        .collect()
}

/// Ids de sessão vão para a linha de comando: só caracteres seguros, tamanho limitado.
fn validate_session_id(id: &str) -> Result<(), LaunchError> {
    let valid = !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'));
    if valid {
        Ok(())
    } else {
        Err(LaunchError::InvalidSessionId(id.to_owned()))
    }
}

/// Argumentos (sem o binário) para subir o agente.
pub fn launch_args(
    id: AgentId,
    permission: Permission,
    session: &SessionMode,
    opts: &LaunchOptions<'_>,
) -> Result<Vec<String>, LaunchError> {
    let spec = spec(id);
    let mut args: Vec<String> = spec.base_args.iter().map(|a| (*a).to_owned()).collect();

    match session {
        SessionMode::New { session_id } => {
            if let (Some(flag), Some(sid)) = (spec.new_session_flag, session_id) {
                validate_session_id(sid)?;
                args.push(flag.to_owned());
                args.push(sid.clone());
            }
        }
        SessionMode::Resume { session_id } => {
            if let Some(sid) = session_id {
                validate_session_id(sid)?;
            }
            match (spec.resume, session_id) {
                (Resume::Flag { by_id, .. }, Some(sid)) => {
                    args.extend(by_id.split(' ').map(str::to_owned));
                    args.push(sid.clone());
                }
                (Resume::Flag { last, .. }, None) => {
                    args.extend(last.iter().map(|a| (*a).to_owned()));
                }
                (Resume::Subcommand { sub, .. }, Some(sid)) => {
                    args.insert(0, sub.to_owned());
                    args.insert(1, sid.clone());
                }
                (Resume::Subcommand { sub, last }, None) => {
                    let mut prefix = vec![sub.to_owned()];
                    prefix.extend(last.iter().map(|a| (*a).to_owned()));
                    args.splice(0..0, prefix);
                }
                (Resume::HistoryOnly(flags), _) => {
                    args.extend(flags.iter().map(|a| (*a).to_owned()));
                }
            }
        }
    }

    args.extend(model_args(id, opts)?);

    if permission == Permission::FullAutonomy {
        let flags = spec
            .autonomy_args
            .ok_or(LaunchError::AutonomyUnsupported(id))?;
        args.extend(flags.iter().map(|a| (*a).to_owned()));
    }

    // O prompt é sempre o último argumento, e só em sessão nova
    let new_session = matches!(session, SessionMode::New { .. });
    if let Some(prompt) = opts.prompt {
        let form = catalog(id)
            .and_then(|c| c.prompt)
            .ok_or(LaunchError::PromptUnsupported(id))?;
        if prompt.len() > MAX_PROMPT_BYTES {
            return Err(LaunchError::PromptTooLarge);
        }
        if new_session {
            match form {
                PromptArg::Positional => {
                    args.push("--".to_owned());
                    args.push(prompt.to_owned());
                }
                PromptArg::Flag(flag) => args.push(format!("{flag}={prompt}")),
            }
        }
    }

    Ok(args)
}

/// Argumentos de modelo e effort, conferidos contra o catálogo.
fn model_args(id: AgentId, opts: &LaunchOptions<'_>) -> Result<Vec<String>, LaunchError> {
    let mut args = Vec::new();
    let Some(name) = opts.model else {
        return match opts.effort {
            Some(effort) => Err(LaunchError::UnsupportedEffort {
                model: "default".to_owned(),
                effort: effort.name(),
            }),
            None => Ok(args),
        };
    };
    let unknown = || LaunchError::UnknownModel(name.to_owned());
    let catalog = catalog(id).ok_or_else(unknown)?;
    let model = model(id, name).ok_or_else(unknown)?;
    args.push(catalog.model_flag.to_owned());
    args.push(model.id.to_owned());
    if let Some(effort) = opts.effort {
        let form = catalog
            .effort_arg
            .filter(|_| model.efforts.contains(&effort))
            .ok_or_else(|| LaunchError::UnsupportedEffort {
                model: model.id.to_owned(),
                effort: effort.name(),
            })?;
        match form {
            EffortArg::Flag(flag) => {
                args.push(flag.to_owned());
                args.push(effort.name().to_owned());
            }
            EffortArg::ConfigKey(key) => {
                args.push("-c".to_owned());
                args.push(format!("{key}={}", effort.name()));
            }
        }
    }
    Ok(args)
}

/// Caminho do binário do agente no PATH informado (ou no PATH do processo).
pub fn resolve_binary(id: AgentId, path: Option<&OsStr>) -> Option<PathBuf> {
    let path = match path {
        Some(p) => p.to_owned(),
        None => std::env::var_os("PATH")?,
    };
    spec(id).binaries.iter().find_map(|bin| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(bin))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(test)]
mod tests;
