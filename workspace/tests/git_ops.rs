//! Operações de projeto e worktree contra repositórios git reais em diretórios temporários.

use std::path::{Path, PathBuf};
use std::process::Command;

use lisa_workspace::git::{self, GitError, RemovalBlock};
use lisa_workspace::registry::{CreateOutcome, Registry, RegistryError};
use tempfile::TempDir;

fn run(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .status()
        .unwrap_or_else(|e| panic!("git {args:?}: {e}"));
    assert!(status.success(), "git {args:?} failed");
}

fn commit(dir: &Path, file: &str) {
    std::fs::write(dir.join(file), file).unwrap_or_else(|e| panic!("{e}"));
    run(dir, &["add", "."]);
    run(dir, &["commit", "-q", "-m", file]);
}

/// Um remote bare com `main` e um clone de trabalho.
struct Fixture {
    _tmp: TempDir,
    remote: PathBuf,
    repo: PathBuf,
    root: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = TempDir::new().unwrap_or_else(|e| panic!("{e}"));
    let remote = tmp.path().join("remote.git");
    let seed = tmp.path().join("seed");
    let repo = tmp.path().join("repo");
    let root = tmp.path().join("workspaces");
    std::fs::create_dir_all(&seed).unwrap_or_else(|e| panic!("{e}"));
    run(
        tmp.path(),
        &["init", "-q", "--bare", "-b", "main", "remote.git"],
    );
    run(&seed, &["init", "-q", "-b", "main"]);
    commit(&seed, "README");
    run(
        &seed,
        &[
            "remote",
            "add",
            "origin",
            remote.to_str().unwrap_or_default(),
        ],
    );
    run(&seed, &["push", "-q", "origin", "main"]);
    run(
        tmp.path(),
        &["clone", "-q", remote.to_str().unwrap_or_default(), "repo"],
    );
    Fixture {
        _tmp: tmp,
        remote,
        repo,
        root,
    }
}

fn registry(fx: &Fixture) -> Registry {
    Registry::default().with_worktree_root(fx.root.clone())
}

#[test]
fn adding_a_subdirectory_registers_the_repo_toplevel() {
    let fx = fixture();
    let sub = fx.repo.join("nested");
    std::fs::create_dir_all(&sub).unwrap_or_else(|e| panic!("{e}"));
    let mut reg = registry(&fx);
    let slug = reg
        .add_project(&sub, &git::Env::default())
        .unwrap_or_else(|e| panic!("{e}"));
    let project = reg.project(&slug).unwrap_or_else(|| panic!("project"));
    assert_eq!(project.path, fx.repo.canonicalize().unwrap_or_default());
    assert_eq!(project.base_branch, "main");
    assert_eq!(project.remote.as_deref(), Some("origin"));
}

#[test]
fn adding_the_same_repo_through_a_symlink_is_a_duplicate() {
    let fx = fixture();
    let link = fx.repo.parent().unwrap_or(&fx.repo).join("link");
    std::os::unix::fs::symlink(&fx.repo, &link).unwrap_or_else(|e| panic!("{e}"));
    let mut reg = registry(&fx);
    reg.add_project(&fx.repo, &git::Env::default())
        .unwrap_or_else(|e| panic!("{e}"));
    let err = reg.add_project(&link, &git::Env::default());
    assert!(matches!(err, Err(RegistryError::AlreadyRegistered(_))));
}

#[test]
fn adding_a_non_git_folder_fails_naming_the_path() {
    let fx = fixture();
    let plain = fx.root.parent().unwrap_or(&fx.root).join("plain");
    std::fs::create_dir_all(&plain).unwrap_or_else(|e| panic!("{e}"));
    let err = registry(&fx).add_project(&plain, &git::Env::default());
    match err {
        Err(RegistryError::Git(GitError::NotARepository(p))) => assert!(p.ends_with("plain")),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn repo_without_remote_uses_current_branch_and_skips_fetch() {
    let fx = fixture();
    let local = fx.root.parent().unwrap_or(&fx.root).join("local");
    std::fs::create_dir_all(&local).unwrap_or_else(|e| panic!("{e}"));
    run(&local, &["init", "-q", "-b", "trunk"]);
    commit(&local, "a");
    let mut reg = registry(&fx);
    let slug = reg
        .add_project(&local, &git::Env::default())
        .unwrap_or_else(|e| panic!("{e}"));
    let project = reg.project(&slug).unwrap_or_else(|| panic!("project"));
    assert_eq!(project.base_branch, "trunk");
    assert_eq!(project.remote, None);
}

#[test]
fn two_projects_with_the_same_name_get_distinct_slugs() {
    let fx = fixture();
    let a = fx.root.parent().unwrap_or(&fx.root).join("a/api");
    let b = fx.root.parent().unwrap_or(&fx.root).join("b/api");
    for dir in [&a, &b] {
        std::fs::create_dir_all(dir).unwrap_or_else(|e| panic!("{e}"));
        run(dir, &["init", "-q", "-b", "main"]);
        commit(dir, "x");
    }
    let mut reg = registry(&fx);
    let sa = reg
        .add_project(&a, &git::Env::default())
        .unwrap_or_else(|e| panic!("{e}"));
    let sb = reg
        .add_project(&b, &git::Env::default())
        .unwrap_or_else(|e| panic!("{e}"));
    assert_ne!(sa, sb);
}

#[test]
fn creating_a_worktree_starts_from_freshly_fetched_base_without_upstream() {
    let fx = fixture();
    // Um commit novo chega ao remote depois do clone
    let other = fx.root.parent().unwrap_or(&fx.root).join("other");
    run(
        fx.root.parent().unwrap_or(&fx.root),
        &[
            "clone",
            "-q",
            fx.remote.to_str().unwrap_or_default(),
            "other",
        ],
    );
    commit(&other, "later");
    run(&other, &["push", "-q", "origin", "main"]);

    let mut reg = registry(&fx);
    let slug = reg
        .add_project(&fx.repo, &git::Env::default())
        .unwrap_or_else(|e| panic!("{e}"));
    let outcome = reg
        .create_worktree(&slug, "Fix Login!", &git::Env::default())
        .unwrap_or_else(|e| panic!("{e}"));
    let CreateOutcome { worktree, warning } = outcome;
    assert!(warning.is_none());
    assert_eq!(worktree.branch, "fix-login");
    assert!(worktree.path.join("later").exists());
    let upstream = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "@{upstream}"])
        .current_dir(&worktree.path)
        .output()
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(
        !upstream.status.success(),
        "worktree must not track an upstream"
    );
}

#[test]
fn unreachable_remote_falls_back_to_last_known_base_with_warning() {
    let fx = fixture();
    let mut reg = registry(&fx);
    let slug = reg
        .add_project(&fx.repo, &git::Env::default())
        .unwrap_or_else(|e| panic!("{e}"));
    run(
        &fx.repo,
        &["remote", "set-url", "origin", "/nonexistent/remote.git"],
    );
    let outcome = reg
        .create_worktree(&slug, "offline", &git::Env::default())
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(outcome.warning.is_some());
    assert!(outcome.worktree.path.join("README").exists());
}

#[test]
fn existing_local_branch_is_refused_and_left_intact() {
    let fx = fixture();
    run(&fx.repo, &["branch", "taken"]);
    let mut reg = registry(&fx);
    let slug = reg
        .add_project(&fx.repo, &git::Env::default())
        .unwrap_or_else(|e| panic!("{e}"));
    let err = reg.create_worktree(&slug, "taken", &git::Env::default());
    assert!(matches!(
        err,
        Err(RegistryError::Git(GitError::BranchExists(_)))
    ));
    run(&fx.repo, &["rev-parse", "--verify", "refs/heads/taken"]);
}

#[test]
fn existing_destination_directory_is_refused_and_left_intact() {
    let fx = fixture();
    let mut reg = registry(&fx);
    let slug = reg
        .add_project(&fx.repo, &git::Env::default())
        .unwrap_or_else(|e| panic!("{e}"));
    let dest = fx.root.join(&slug).join("busy");
    std::fs::create_dir_all(&dest).unwrap_or_else(|e| panic!("{e}"));
    std::fs::write(dest.join("keep"), "x").unwrap_or_else(|e| panic!("{e}"));
    let err = reg.create_worktree(&slug, "busy", &git::Env::default());
    assert!(matches!(
        err,
        Err(RegistryError::Git(GitError::DestinationExists(_)))
    ));
    assert!(dest.join("keep").exists());
}

fn created(fx: &Fixture, name: &str) -> (Registry, String, PathBuf) {
    let mut reg = registry(fx);
    let slug = reg
        .add_project(&fx.repo, &git::Env::default())
        .unwrap_or_else(|e| panic!("{e}"));
    let wt = reg
        .create_worktree(&slug, name, &git::Env::default())
        .unwrap_or_else(|e| panic!("{e}"))
        .worktree;
    let path = wt.path.clone();
    (reg, wt.id, path)
}

#[test]
fn removing_a_worktree_with_a_modified_file_is_refused() {
    let fx = fixture();
    let (reg, id, path) = created(&fx, "dirty");
    std::fs::write(path.join("README"), "changed").unwrap_or_else(|e| panic!("{e}"));
    let block = reg.removal_check(&id).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(block, Some(RemovalBlock::Uncommitted(1)));
}

#[test]
fn removing_a_worktree_with_unpushed_commits_reports_the_count() {
    let fx = fixture();
    let (reg, id, path) = created(&fx, "ahead");
    commit(&path, "one");
    commit(&path, "two");
    let block = reg.removal_check(&id).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(block, Some(RemovalBlock::Unpushed(2)));
}

#[test]
fn pushed_branch_without_upstream_is_safe_to_remove() {
    let fx = fixture();
    let (mut reg, id, path) = created(&fx, "shipped");
    commit(&path, "work");
    run(&path, &["push", "-q", "origin", "shipped"]);
    assert_eq!(
        reg.removal_check(&id).unwrap_or_else(|e| panic!("{e}")),
        None
    );
    reg.remove_worktree(&id, false)
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(!path.exists());
    let local = Command::new("git")
        .args(["rev-parse", "--verify", "refs/heads/shipped"])
        .current_dir(&fx.repo)
        .output()
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(!local.status.success(), "local branch should be deleted");
    run(&fx.remote, &["rev-parse", "--verify", "refs/heads/shipped"]);
}

#[test]
fn forced_removal_deletes_a_dirty_worktree() {
    let fx = fixture();
    let (mut reg, id, path) = created(&fx, "forced");
    std::fs::write(path.join("README"), "changed").unwrap_or_else(|e| panic!("{e}"));
    assert!(reg.remove_worktree(&id, false).is_err());
    reg.remove_worktree(&id, true)
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(!path.exists());
}

#[test]
fn changing_the_base_branch_only_affects_new_worktrees() {
    let fx = fixture();
    run(&fx.repo, &["checkout", "-q", "-b", "develop"]);
    commit(&fx.repo, "dev-only");
    run(&fx.repo, &["push", "-q", "origin", "develop"]);
    run(&fx.repo, &["checkout", "-q", "main"]);
    let (mut reg, first_id, first_path) = created(&fx, "first");
    let slug = reg
        .worktree(&first_id)
        .map(|w| w.project.clone())
        .unwrap_or_default();
    reg.set_base_branch(&slug, "develop")
        .unwrap_or_else(|e| panic!("{e}"));
    let second = reg
        .create_worktree(&slug, "second", &git::Env::default())
        .unwrap_or_else(|e| panic!("{e}"))
        .worktree;
    assert!(second.path.join("dev-only").exists());
    assert!(!first_path.join("dev-only").exists());
}

#[test]
fn worktree_deleted_outside_lisa_is_marked_broken_on_load() {
    let fx = fixture();
    let (mut reg, id, path) = created(&fx, "gone");
    std::fs::remove_dir_all(&path).unwrap_or_else(|e| panic!("{e}"));
    reg.refresh_health();
    assert!(reg.worktree(&id).is_some_and(|w| w.broken));
}

#[test]
fn state_file_round_trips_and_corrupt_file_is_backed_up() {
    let fx = fixture();
    let (reg, id, _) = created(&fx, "persist");
    let file = fx.root.join("state.json");
    reg.save(&file).unwrap_or_else(|e| panic!("{e}"));
    let loaded = Registry::load(&file).unwrap_or_else(|e| panic!("{e}"));
    assert!(loaded.registry.worktree(&id).is_some());
    assert!(loaded.warning.is_none());

    std::fs::write(&file, "{ not json").unwrap_or_else(|e| panic!("{e}"));
    let recovered = Registry::load(&file).unwrap_or_else(|e| panic!("{e}"));
    assert!(recovered.registry.projects().is_empty());
    assert!(recovered.warning.is_some());
    let backups = std::fs::read_dir(&fx.root)
        .map(|d| {
            d.filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().contains("corrupt"))
                .count()
        })
        .unwrap_or(0);
    assert_eq!(backups, 1);
}
