//! Operações git do Workspace. Nunca apagam trabalho sem pedido explícito.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// Timeout do fetch da branch base.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Variáveis de ambiente aplicadas às chamadas git de um pedido (vindas da UI).
#[derive(Debug, Clone, Default)]
pub struct Env(pub Vec<(OsString, OsString)>);

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("{0} is not inside a git repository")]
    NotARepository(PathBuf),
    #[error("{0} is a bare repository")]
    BareRepository(PathBuf),
    #[error("{0} is a linked worktree; add the main checkout instead")]
    LinkedWorktree(PathBuf),
    #[error("the repository is on a detached HEAD; choose a base branch explicitly")]
    DetachedHead,
    #[error("{0:?} does not produce a valid branch name")]
    InvalidName(String),
    #[error("branch {0} already exists")]
    BranchExists(String),
    #[error("{0} already exists")]
    DestinationExists(PathBuf),
    #[error("branch {0} does not exist locally or on the remote")]
    UnknownBranch(String),
    #[error("git {args} failed: {stderr}")]
    Command { args: String, stderr: String },
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Motivo que impede remover um worktree sem forçar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemovalBlock {
    /// Arquivos modificados ou não rastreados.
    Uncommitted(usize),
    /// Commits que não estão em nenhum ref remoto.
    Unpushed(usize),
    /// Não foi possível checar; nunca é seguro.
    Unknown(String),
}

impl std::fmt::Display for RemovalBlock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RemovalBlock::Uncommitted(n) => write!(f, "{n} uncommitted change(s)"),
            RemovalBlock::Unpushed(n) => write!(
                f,
                "{n} commit(s) not on any remote (a squash-merged branch whose remote was deleted also counts)"
            ),
            RemovalBlock::Unknown(reason) => write!(f, "could not check the worktree: {reason}"),
        }
    }
}

fn command(dir: &Path, env: &Env, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    for (k, v) in &env.0 {
        cmd.env(k, v);
    }
    cmd
}

fn output(dir: &Path, env: &Env, args: &[&str]) -> Result<Output, GitError> {
    Ok(command(dir, env, args).output()?)
}

fn checked(dir: &Path, env: &Env, args: &[&str]) -> Result<String, GitError> {
    let out = output(dir, env, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    } else {
        Err(GitError::Command {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        })
    }
}

fn ref_exists(dir: &Path, reference: &str) -> bool {
    output(
        dir,
        &Env::default(),
        &["rev-parse", "--verify", "--quiet", reference],
    )
    .is_ok_and(|o| o.status.success())
}

/// Toplevel do repositório que contém `path`, recusando bare e worktree ligado.
pub fn repo_toplevel(path: &Path) -> Result<PathBuf, GitError> {
    let path = path.canonicalize()?;
    let env = Env::default();
    let bare = checked(&path, &env, &["rev-parse", "--is-bare-repository"])
        .map_err(|_| GitError::NotARepository(path.clone()))?;
    if bare == "true" {
        return Err(GitError::BareRepository(path));
    }
    let top = PathBuf::from(checked(&path, &env, &["rev-parse", "--show-toplevel"])?);
    let git_dir = checked(&top, &env, &["rev-parse", "--absolute-git-dir"])?;
    let common = checked(
        &top,
        &env,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    if Path::new(&git_dir) != Path::new(&common) {
        return Err(GitError::LinkedWorktree(top));
    }
    Ok(top.canonicalize()?)
}

/// Remote usado para a branch base: `origin` quando existe, senão o primeiro.
pub fn detect_remote(top: &Path) -> Option<String> {
    let remotes = checked(top, &Env::default(), &["remote"]).ok()?;
    let names: Vec<&str> = remotes.lines().filter(|l| !l.is_empty()).collect();
    names
        .iter()
        .find(|n| **n == "origin")
        .or_else(|| names.first())
        .map(|n| (*n).to_owned())
}

/// Branch base padrão: HEAD do remote, depois main/master, depois a branch atual.
pub fn detect_base(top: &Path, remote: Option<&str>) -> Result<String, GitError> {
    let env = Env::default();
    if let Some(remote) = remote {
        let head = format!("refs/remotes/{remote}/HEAD");
        if let Ok(target) = checked(top, &env, &["symbolic-ref", "--short", &head])
            && let Some(branch) = target.strip_prefix(&format!("{remote}/"))
        {
            return Ok(branch.to_owned());
        }
        for candidate in ["main", "master"] {
            if ref_exists(top, &format!("refs/remotes/{remote}/{candidate}")) {
                return Ok(candidate.to_owned());
            }
        }
    }
    checked(top, &env, &["symbolic-ref", "--short", "HEAD"]).map_err(|_| GitError::DetachedHead)
}

/// A branch base existe localmente ou no remote do projeto.
pub fn branch_exists(top: &Path, remote: Option<&str>, branch: &str) -> bool {
    ref_exists(top, &format!("refs/heads/{branch}"))
        || remote.is_some_and(|r| ref_exists(top, &format!("refs/remotes/{r}/{branch}")))
}

/// Nome digitado pelo usuário → nome de branch seguro.
pub fn sanitize_branch(name: &str) -> Result<String, GitError> {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/') {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let branch = out
        .trim_matches(|c| matches!(c, '-' | '.' | '/'))
        .replace("..", "-")
        .replace("//", "/");
    if branch.is_empty() {
        Err(GitError::InvalidName(name.to_owned()))
    } else {
        Ok(branch)
    }
}

/// Fetch com timeout; `Err` carrega o motivo para virar aviso.
pub fn fetch(
    top: &Path,
    remote: &str,
    base: &str,
    env: &Env,
    timeout: Duration,
) -> Result<(), String> {
    let mut child = command(top, env, &["fetch", "--quiet", remote, base])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                return Err(stderr.trim().to_owned());
            }
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("fetch timed out after {}s", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Cria o worktree sem upstream; recusa colisões e nunca apaga nada.
pub fn add_worktree(
    top: &Path,
    remote: Option<&str>,
    base: &str,
    branch: &str,
    dest: &Path,
) -> Result<(), GitError> {
    if ref_exists(top, &format!("refs/heads/{branch}")) {
        return Err(GitError::BranchExists(branch.to_owned()));
    }
    let remote_branches = checked(
        top,
        &Env::default(),
        &[
            "for-each-ref",
            "--format=%(refname:strip=3)",
            "refs/remotes",
        ],
    )?;
    if remote_branches.lines().any(|b| b == branch) {
        return Err(GitError::BranchExists(branch.to_owned()));
    }
    if dest.exists() {
        return Err(GitError::DestinationExists(dest.to_owned()));
    }
    let start = match remote {
        Some(r) if ref_exists(top, &format!("refs/remotes/{r}/{base}")) => format!("{r}/{base}"),
        _ => base.to_owned(),
    };
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let dest_str = dest.to_string_lossy();
    checked(
        top,
        &Env::default(),
        &[
            "worktree",
            "add",
            "--quiet",
            "--no-track",
            "-b",
            branch,
            &dest_str,
            &start,
        ],
    )?;
    Ok(())
}

/// O que impede remover o worktree sem forçar, se houver.
pub fn removal_block(
    top: &Path,
    path: &Path,
    branch: &str,
    base: &str,
    has_remote: bool,
) -> Option<RemovalBlock> {
    let env = Env::default();
    let status = match checked(path, &env, &["status", "--porcelain"]) {
        Ok(s) => s,
        Err(e) => return Some(RemovalBlock::Unknown(e.to_string())),
    };
    let dirty = status.lines().filter(|l| !l.is_empty()).count();
    if dirty > 0 {
        return Some(RemovalBlock::Uncommitted(dirty));
    }
    let args: Vec<&str> = if has_remote {
        vec!["rev-list", "--count", branch, "--not", "--remotes"]
    } else {
        vec!["rev-list", "--count", branch, "--not", base]
    };
    match checked(top, &env, &args).map(|n| n.parse::<usize>()) {
        Ok(Ok(0)) => None,
        Ok(Ok(n)) => Some(RemovalBlock::Unpushed(n)),
        Ok(Err(e)) => Some(RemovalBlock::Unknown(e.to_string())),
        Err(e) => Some(RemovalBlock::Unknown(e.to_string())),
    }
}

/// Remove o worktree e a branch local. A branch remota nunca é tocada.
pub fn remove_worktree(top: &Path, path: &Path, branch: &str) -> Result<(), GitError> {
    let env = Env::default();
    if path.exists() {
        let path_str = path.to_string_lossy();
        checked(top, &env, &["worktree", "remove", "--force", &path_str])?;
    }
    checked(top, &env, &["worktree", "prune"])?;
    if ref_exists(top, &format!("refs/heads/{branch}")) {
        checked(top, &env, &["branch", "-D", branch])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_lowercases_and_collapses_symbols() {
        assert_eq!(
            sanitize_branch("Fix Login!").ok().as_deref(),
            Some("fix-login")
        );
    }

    #[test]
    fn sanitize_keeps_path_separators() {
        assert_eq!(
            sanitize_branch("feat/Nova Tela").ok().as_deref(),
            Some("feat/nova-tela")
        );
    }

    #[test]
    fn sanitize_rejects_names_without_valid_characters() {
        assert!(matches!(
            sanitize_branch("!!!"),
            Err(GitError::InvalidName(_))
        ));
    }
}
