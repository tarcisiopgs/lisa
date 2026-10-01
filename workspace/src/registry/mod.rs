//! Registro de projetos e worktrees. Só o daemon escreve (escrita atômica).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::git::{self, GitError, RemovalBlock};

const SCHEMA_VERSION: u32 = 2;

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("{0} is already registered")]
    AlreadyRegistered(PathBuf),
    #[error("unknown project {0}")]
    UnknownProject(String),
    #[error("unknown worktree {0}")]
    UnknownWorktree(String),
    #[error("a group named {0} already exists")]
    GroupExists(String),
    #[error("a group needs at least one repository")]
    EmptyGroup,
    #[error("a group needs a name")]
    UnnamedGroup,
    #[error("unknown group {0}")]
    UnknownGroup(String),
    #[error("worktree has {0}; confirm to force removal")]
    Blocked(RemovalBlock),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Project {
    pub slug: String,
    pub name: String,
    pub path: PathBuf,
    pub base_branch: String,
    pub remote: Option<String>,
    /// Slug do grupo; ausente em projeto solto e em estados anteriores à versão 2.
    #[serde(default)]
    pub group: Option<String>,
}

/// Agrupa projetos no menu; não é unidade de execução.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Group {
    pub slug: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Worktree {
    /// `<slug do projeto>/<branch>`
    pub id: String,
    pub project: String,
    pub name: String,
    pub branch: String,
    pub path: PathBuf,
    pub agent: Option<String>,
    pub permission: Option<String>,
    pub session_id: Option<String>,
    /// Modelo e effort escolhidos na criação; ausentes em estados da 2.0.0.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Diretório ou branch sumiram fora da Lisa; calculado, não persistido.
    #[serde(skip)]
    pub broken: bool,
}

/// Worktree a criar: decidido com o registro travado, executado sem ele.
#[derive(Debug, Clone)]
pub struct WorktreePlan {
    pub project: Project,
    pub name: String,
    pub branch: String,
    pub dest: PathBuf,
}

/// Fetch da base e `git worktree add`, sem tocar no registro (pode levar segundos).
/// Devolve um aviso quando o fetch falhou e a base veio do último ref conhecido.
pub fn execute_plan(plan: &WorktreePlan, env: &git::Env) -> Result<Option<String>, RegistryError> {
    let project = &plan.project;
    let warning = project.remote.as_deref().and_then(|remote| {
        git::fetch(
            &project.path,
            remote,
            &project.base_branch,
            env,
            git::FETCH_TIMEOUT,
        )
        .err()
        .map(|reason| {
            format!(
                "could not fetch {remote}/{}; using the last known version ({reason})",
                project.base_branch
            )
        })
    });
    git::add_worktree(
        &project.path,
        project.remote.as_deref(),
        &project.base_branch,
        &plan.branch,
        &plan.dest,
    )?;
    Ok(warning)
}

#[derive(Debug)]
pub struct CreateOutcome {
    pub worktree: Worktree,
    /// Ex.: fetch falhou e a base veio do último ref remoto conhecido.
    pub warning: Option<String>,
}

#[derive(Debug)]
pub struct Loaded {
    pub registry: Registry,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registry {
    schema_version: u32,
    projects: Vec<Project>,
    worktrees: Vec<Worktree>,
    #[serde(default)]
    groups: Vec<Group>,
    #[serde(skip, default = "default_worktree_root")]
    worktree_root: PathBuf,
}

impl Default for Registry {
    fn default() -> Self {
        Registry {
            schema_version: SCHEMA_VERSION,
            projects: Vec::new(),
            worktrees: Vec::new(),
            groups: Vec::new(),
            worktree_root: default_worktree_root(),
        }
    }
}

/// `~/.lisa/workspaces`
pub fn default_worktree_root() -> PathBuf {
    lisa_home().join("workspaces")
}

/// `~/.lisa`
pub fn lisa_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(".lisa")
}

fn slugify(name: &str) -> String {
    let slug = git::sanitize_branch(name)
        .unwrap_or_default()
        .replace('/', "-");
    if slug.is_empty() {
        "project".to_owned()
    } else {
        slug
    }
}

/// Resto do nome do projeto depois do nome do grupo, em minúsculas. Separadores do
/// grupo casam com qualquer separador do projeto, e o prefixo tem de acabar em fronteira.
fn strip_group(group: &str, name: &str) -> Option<String> {
    let group = group.to_lowercase();
    let name = name.to_lowercase();
    let mut rest = name.as_str();
    let mut tokens = 0;
    for token in group
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
    {
        rest = rest
            .trim_start_matches(|c: char| !c.is_alphanumeric())
            .strip_prefix(token)?;
        tokens += 1;
    }
    if tokens == 0 || rest.starts_with(char::is_alphanumeric) {
        return None;
    }
    let rest = rest.trim_start_matches(|c: char| !c.is_alphanumeric());
    (!rest.is_empty()).then(|| rest.to_owned())
}

/// Marcas dos repositórios de um grupo, na ordem recebida: o nome sem o prefixo do grupo.
/// Marcas que colidem voltam ao nome completo.
pub fn repo_tags(group_name: &str, project_names: &[&str]) -> Vec<String> {
    let tags: Vec<String> = project_names
        .iter()
        .map(|name| strip_group(group_name, name).unwrap_or_else(|| name.to_lowercase()))
        .collect();
    tags.iter()
        .zip(project_names)
        .map(|(tag, name)| {
            if tags.iter().filter(|t| *t == tag).count() > 1 {
                name.to_lowercase()
            } else {
                tag.clone()
            }
        })
        .collect()
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Registry {
    pub fn with_worktree_root(mut self, root: PathBuf) -> Self {
        self.worktree_root = root;
        self
    }

    pub fn projects(&self) -> &[Project] {
        &self.projects
    }

    pub fn worktrees(&self) -> &[Worktree] {
        &self.worktrees
    }

    pub fn project(&self, slug: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.slug == slug)
    }

    pub fn worktree(&self, id: &str) -> Option<&Worktree> {
        self.worktrees.iter().find(|w| w.id == id)
    }

    pub fn worktree_mut(&mut self, id: &str) -> Option<&mut Worktree> {
        self.worktrees.iter_mut().find(|w| w.id == id)
    }

    pub fn groups(&self) -> &[Group] {
        &self.groups
    }

    /// Lê do git o que um projeto novo precisa; o slug é dado ao inserir.
    fn probe(top: PathBuf) -> Result<Project, RegistryError> {
        let remote = git::detect_remote(&top);
        let base_branch = git::detect_base(&top, remote.as_deref())?;
        let name = top
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "project".to_owned());
        Ok(Project {
            slug: String::new(),
            name,
            path: top,
            base_branch,
            remote,
            group: None,
        })
    }

    fn insert(&mut self, mut project: Project) -> String {
        let base_slug = slugify(&project.name);
        let mut slug = base_slug.clone();
        let mut n = 2;
        while self.project(&slug).is_some() {
            slug = format!("{base_slug}-{n}");
            n += 1;
        }
        project.slug = slug.clone();
        self.projects.push(project);
        slug
    }

    /// Registra o repositório que contém `path`; devolve o slug.
    pub fn add_project(&mut self, path: &Path, _env: &git::Env) -> Result<String, RegistryError> {
        let top = git::repo_toplevel(path)?;
        if self.projects.iter().any(|p| p.path == top) {
            return Err(RegistryError::AlreadyRegistered(top));
        }
        let project = Self::probe(top)?;
        Ok(self.insert(project))
    }

    /// Cria o grupo com os repositórios dos caminhos: registra os que faltam e move os já
    /// mapeados. Tudo ou nada: valida todos os caminhos antes de alterar o registro.
    pub fn add_group(
        &mut self,
        name: &str,
        paths: &[PathBuf],
        _env: &git::Env,
    ) -> Result<String, RegistryError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(RegistryError::UnnamedGroup);
        }
        if paths.is_empty() {
            return Err(RegistryError::EmptyGroup);
        }
        let lower = name.to_lowercase();
        if self.groups.iter().any(|g| g.name.to_lowercase() == lower) {
            return Err(RegistryError::GroupExists(name.to_owned()));
        }
        let mut tops: Vec<PathBuf> = Vec::new();
        for path in paths {
            let top = git::repo_toplevel(path)?;
            if !tops.contains(&top) {
                tops.push(top);
            }
        }
        let mut fresh = Vec::new();
        for top in &tops {
            if !self.projects.iter().any(|p| p.path == *top) {
                fresh.push(Self::probe(top.clone())?);
            }
        }

        let base_slug = slugify(name);
        let mut slug = base_slug.clone();
        let mut n = 2;
        while self.groups.iter().any(|g| g.slug == slug) {
            slug = format!("{base_slug}-{n}");
            n += 1;
        }
        for project in fresh {
            self.insert(project);
        }
        for project in &mut self.projects {
            if tops.contains(&project.path) {
                project.group = Some(slug.clone());
            }
        }
        self.groups.push(Group {
            slug: slug.clone(),
            name: name.to_owned(),
        });
        // Grupo que perdeu todos os membros para o novo deixa de existir
        let projects = &self.projects;
        self.groups
            .retain(|g| projects.iter().any(|p| p.group.as_deref() == Some(&g.slug)));
        Ok(slug)
    }

    /// Remove o grupo; os membros viram projetos soltos.
    pub fn dissolve_group(&mut self, slug: &str) -> Result<(), RegistryError> {
        if !self.groups.iter().any(|g| g.slug == slug) {
            return Err(RegistryError::UnknownGroup(slug.to_owned()));
        }
        for project in &mut self.projects {
            if project.group.as_deref() == Some(slug) {
                project.group = None;
            }
        }
        self.groups.retain(|g| g.slug != slug);
        Ok(())
    }

    /// Marca de cada projeto de grupo: slug do projeto → marca.
    pub fn tags(&self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for group in &self.groups {
            let members: Vec<&Project> = self
                .projects
                .iter()
                .filter(|p| p.group.as_deref() == Some(&group.slug))
                .collect();
            let names: Vec<&str> = members.iter().map(|p| p.name.as_str()).collect();
            let tags = repo_tags(&group.name, &names);
            for (project, tag) in members.iter().zip(&tags) {
                // Repositórios de mesmo nome em pastas diferentes: só o slug os separa
                let unique = tags.iter().filter(|t| *t == tag).count() == 1;
                let tag = if unique {
                    tag.clone()
                } else {
                    project.slug.clone()
                };
                out.insert(project.slug.clone(), tag);
            }
        }
        out
    }

    /// Troca a branch base; vale só para worktrees novos.
    pub fn set_base_branch(&mut self, slug: &str, base: &str) -> Result<(), RegistryError> {
        let project = self
            .projects
            .iter_mut()
            .find(|p| p.slug == slug)
            .ok_or_else(|| RegistryError::UnknownProject(slug.to_owned()))?;
        if !git::branch_exists(&project.path, project.remote.as_deref(), base) {
            return Err(GitError::UnknownBranch(base.to_owned()).into());
        }
        project.base_branch = base.to_owned();
        Ok(())
    }

    /// Decide nome da branch e destino. Não executa git.
    pub fn plan_worktree(&self, slug: &str, name: &str) -> Result<WorktreePlan, RegistryError> {
        let project = self
            .project(slug)
            .cloned()
            .ok_or_else(|| RegistryError::UnknownProject(slug.to_owned()))?;
        let branch = git::sanitize_branch(name)?;
        let dest = self
            .worktree_root
            .join(&project.slug)
            .join(branch.replace('/', "-"));
        Ok(WorktreePlan {
            project,
            name: name.trim().to_owned(),
            branch,
            dest,
        })
    }

    /// Registra um worktree já criado no disco.
    pub fn add_planned(&mut self, plan: &WorktreePlan) -> Worktree {
        let worktree = Worktree {
            id: format!("{}/{}", plan.project.slug, plan.branch),
            project: plan.project.slug.clone(),
            name: plan.name.clone(),
            branch: plan.branch.clone(),
            path: plan.dest.clone(),
            agent: None,
            permission: None,
            session_id: None,
            model: None,
            effort: None,
            broken: false,
        };
        self.worktrees.push(worktree.clone());
        worktree
    }

    /// Planeja, executa e registra de uma vez (segura o registro durante o git).
    pub fn create_worktree(
        &mut self,
        slug: &str,
        name: &str,
        env: &git::Env,
    ) -> Result<CreateOutcome, RegistryError> {
        let plan = self.plan_worktree(slug, name)?;
        let warning = execute_plan(&plan, env)?;
        let worktree = self.add_planned(&plan);
        Ok(CreateOutcome { worktree, warning })
    }

    /// Worktree e projeto para checar e remover sem segurar o registro.
    pub fn removal_target(&self, id: &str) -> Result<(Worktree, Project), RegistryError> {
        let wt = self
            .worktree(id)
            .cloned()
            .ok_or_else(|| RegistryError::UnknownWorktree(id.to_owned()))?;
        let project = self
            .project(&wt.project)
            .cloned()
            .ok_or_else(|| RegistryError::UnknownProject(wt.project.clone()))?;
        Ok((wt, project))
    }

    /// Tira o worktree do registro (o git já foi feito).
    pub fn forget_worktree(&mut self, id: &str) {
        self.worktrees.retain(|w| w.id != id);
    }

    /// O que impede remover sem forçar, se houver.
    pub fn removal_check(&self, id: &str) -> Result<Option<RemovalBlock>, RegistryError> {
        let wt = self
            .worktree(id)
            .ok_or_else(|| RegistryError::UnknownWorktree(id.to_owned()))?;
        if wt.broken || !wt.path.exists() {
            return Ok(None);
        }
        let project = self
            .project(&wt.project)
            .ok_or_else(|| RegistryError::UnknownProject(wt.project.clone()))?;
        Ok(git::removal_block(
            &project.path,
            &wt.path,
            &wt.branch,
            &project.base_branch,
            project.remote.is_some(),
        ))
    }

    /// Remove worktree e branch local; sem `force`, recusa se houver trabalho a proteger.
    pub fn remove_worktree(&mut self, id: &str, force: bool) -> Result<(), RegistryError> {
        if !force && let Some(block) = self.removal_check(id)? {
            return Err(RegistryError::Blocked(block));
        }
        let wt = self
            .worktree(id)
            .cloned()
            .ok_or_else(|| RegistryError::UnknownWorktree(id.to_owned()))?;
        if let Some(project) = self.project(&wt.project) {
            git::remove_worktree(&project.path, &wt.path, &wt.branch)?;
        }
        self.worktrees.retain(|w| w.id != id);
        Ok(())
    }

    /// Marca como quebrados os worktrees cujo diretório sumiu.
    pub fn refresh_health(&mut self) {
        for wt in &mut self.worktrees {
            wt.broken = !wt.path.is_dir();
        }
    }

    /// Escrita atômica: arquivo temporário + rename.
    pub fn save(&self, file: &Path) -> Result<(), RegistryError> {
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(&tmp, file)?;
        Ok(())
    }

    /// Arquivo ausente vira registro vazio; arquivo corrompido vira backup e aviso.
    pub fn load(file: &Path) -> Result<Loaded, RegistryError> {
        let bytes = match std::fs::read(file) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Loaded {
                    registry: Registry::default(),
                    warning: None,
                });
            }
            Err(e) => return Err(e.into()),
        };
        match serde_json::from_slice::<Registry>(&bytes) {
            Ok(mut registry) => {
                registry.schema_version = SCHEMA_VERSION;
                registry.refresh_health();
                Ok(Loaded {
                    registry,
                    warning: None,
                })
            }
            Err(err) => {
                let backup = file.with_extension(format!("json.corrupt-{}", unix_now()));
                std::fs::rename(file, &backup)?;
                Ok(Loaded {
                    registry: Registry::default(),
                    warning: Some(format!(
                        "the workspace state was unreadable ({err}); it was moved to {} and Lisa started empty",
                        backup.display()
                    )),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_drops_the_group_prefix_and_separators() {
        assert_eq!(
            repo_tags("B-Metric", &["b-metric-api", "b-metric-web"]),
            ["api", "web"]
        );
        assert_eq!(repo_tags("B-Metric", &["B-Metric - API"]), ["api"]);
        assert_eq!(repo_tags("b metric", &["b_metric.infra"]), ["infra"]);
    }

    #[test]
    fn tag_falls_back_to_the_name_when_there_is_no_prefix_or_nothing_left() {
        assert_eq!(repo_tags("FindUP", &["findup", "api"]), ["findup", "api"]);
        assert_eq!(repo_tags("Glowz", &["glowzilla"]), ["glowzilla"]);
    }

    #[test]
    fn colliding_tags_use_the_full_name() {
        assert_eq!(
            repo_tags("Acme", &["acme-api", "acme_api", "acme-web"]),
            ["acme-api", "acme_api", "web"]
        );
    }

    #[test]
    fn tag_keeps_non_ascii_names_whole() {
        assert_eq!(repo_tags("Ação", &["ação-serviço"]), ["serviço"]);
    }
}
