//! Preferências do roteador em `~/.lisa/workspace/router.toml`. Tudo é opcional, e um
//! arquivo inválido nunca impede a UI de abrir: vale o padrão, com aviso.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::RouterConfig;
use crate::agents::AgentId;

pub fn config_path() -> PathBuf {
    crate::registry::lisa_home().join("workspace/router.toml")
}

#[derive(Debug, Default, Deserialize)]
struct File {
    preference: Option<Vec<String>>,
    #[serde(default)]
    kinds: Kinds,
    #[serde(default)]
    thresholds: Thresholds,
}

#[derive(Debug, Default, Deserialize)]
struct Kinds {
    visual_ui: Option<String>,
    review: Option<String>,
    investigation: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct Thresholds {
    depth: Option<f32>,
    kind: Option<f32>,
    size: Option<f32>,
}

/// Lê o arquivo sobre o padrão. O segundo valor é um aviso para o usuário quando algo
/// foi ignorado.
pub fn load(path: &Path) -> (RouterConfig, Option<String>) {
    let mut cfg = RouterConfig::default();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return (cfg, None);
    };
    let file: File = match toml::from_str(&raw) {
        Ok(file) => file,
        Err(err) => {
            let reason = err.message();
            return (cfg, Some(format!("router.toml ignored: {reason}")));
        }
    };
    let mut ignored = Vec::new();

    if let Some(names) = file.preference {
        let known: Vec<AgentId> = names
            .iter()
            .filter_map(|name| agent(name, &mut ignored))
            .collect();
        if !known.is_empty() {
            cfg.preference = known;
        }
    }
    for (slot, name) in [
        (&mut cfg.visual_ui, file.kinds.visual_ui),
        (&mut cfg.review, file.kinds.review),
        (&mut cfg.investigation, file.kinds.investigation),
    ] {
        if let Some(id) = name.and_then(|n| agent(&n, &mut ignored)) {
            *slot = id;
        }
    }
    for (slot, key, value) in [
        (&mut cfg.depth, "depth", file.thresholds.depth),
        (&mut cfg.kind, "kind", file.thresholds.kind),
        (&mut cfg.size, "size", file.thresholds.size),
    ] {
        match value {
            Some(v) if (0.0..=1.0).contains(&v) => *slot = v,
            Some(_) => ignored.push(format!("threshold {key}")),
            None => {}
        }
    }

    let warning =
        (!ignored.is_empty()).then(|| format!("router.toml: ignored {}", ignored.join(", ")));
    (cfg, warning)
}

fn agent(name: &str, ignored: &mut Vec<String>) -> Option<AgentId> {
    let id = AgentId::from_name(name);
    if id.is_none() {
        ignored.push(format!("unknown agent {name}"));
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_str(body: &str) -> (RouterConfig, Option<String>) {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let file = dir.path().join("router.toml");
        std::fs::write(&file, body).unwrap_or_else(|e| panic!("{e}"));
        load(&file)
    }

    #[test]
    fn missing_file_is_the_default_without_a_warning() {
        let (cfg, warning) = load(Path::new("/nonexistent/router.toml"));
        assert_eq!((cfg, warning), (RouterConfig::default(), None));
    }

    #[test]
    fn full_file_overrides_everything() {
        let (cfg, warning) = load_str(
            "preference = [\"gemini\", \"claude\"]\n\n[kinds]\nvisual_ui = \"claude\"\nreview = \"gemini\"\ninvestigation = \"codex\"\n\n[thresholds]\ndepth = 0.9\nkind = 0.4\nsize = 0.6\n",
        );
        assert_eq!(warning, None);
        assert_eq!(cfg.preference, [AgentId::Gemini, AgentId::Claude]);
        assert_eq!(
            (cfg.visual_ui, cfg.review, cfg.investigation),
            (AgentId::Claude, AgentId::Gemini, AgentId::Codex)
        );
        assert_eq!((cfg.depth, cfg.kind, cfg.size), (0.9, 0.4, 0.6));
    }

    #[test]
    fn partial_file_overrides_only_what_it_names() {
        let (cfg, warning) = load_str("preference = [\"codex\"]\n");
        assert_eq!(warning, None);
        assert_eq!(cfg.preference, [AgentId::Codex]);
        let rest = RouterConfig {
            preference: RouterConfig::default().preference,
            ..cfg
        };
        assert_eq!(rest, RouterConfig::default());
    }

    #[test]
    fn unknown_agent_names_are_dropped_with_a_warning() {
        let (cfg, warning) =
            load_str("preference = [\"codex\", \"nope\"]\n[kinds]\nreview = \"zed\"\n");
        assert_eq!(cfg.preference, [AgentId::Codex]);
        assert_eq!(cfg.review, AgentId::Codex);
        let warning = warning.unwrap_or_default();
        assert!(
            warning.contains("nope") && warning.contains("zed"),
            "{warning}"
        );
    }

    #[test]
    fn invalid_toml_keeps_the_default_and_warns() {
        let (cfg, warning) = load_str("preference = [");
        assert_eq!(cfg, RouterConfig::default());
        assert!(warning.is_some_and(|w| w.contains("router.toml")));
    }

    #[test]
    fn thresholds_outside_zero_to_one_are_ignored_with_a_warning() {
        let (cfg, warning) = load_str("[thresholds]\ndepth = 7\nkind = 0.3\n");
        assert_eq!((cfg.depth, cfg.kind), (0.7, 0.3));
        assert!(warning.is_some_and(|w| w.contains("depth")));
    }

    #[test]
    fn empty_preference_falls_back_to_the_default_order() {
        let (cfg, _) = load_str("preference = []\n");
        assert_eq!(cfg.preference, RouterConfig::default().preference);
    }
}
