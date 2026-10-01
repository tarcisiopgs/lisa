//! Roteador: da resposta do Jev à sugestão de agente, modelo e effort. A decisão aqui é
//! pura; `config` lê as preferências do usuário.

pub mod config;

use serde_json::{Value, json};

use crate::agents::{self, AgentId, Effort};

/// Tamanho da tarefa; o índice é o nível do Score e a posição em `ModelCatalog::tiers`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Size {
    Trivial,
    Scoped,
    Complex,
    Open,
}

impl Size {
    const ALL: [Size; 4] = [Size::Trivial, Size::Scoped, Size::Complex, Size::Open];
}

/// Tipo da tarefa: só os que a documentação dos harnesses distingue entre si.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    VisualUi,
    Review,
    Investigation,
    Other,
}

impl Kind {
    fn from_name(name: &str) -> Option<Kind> {
        match name {
            "visual_ui" => Some(Kind::VisualUi),
            "review" => Some(Kind::Review),
            "investigation" => Some(Kind::Investigation),
            "other" => Some(Kind::Other),
            _ => None,
        }
    }
}

/// O que o Jev respondeu, já validado.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Answers {
    pub size_probs: [f32; 4],
    pub size_confidence: f32,
    /// Probabilidade de a tarefa pedir verificação ou raciocínio além do normal.
    pub depth: f32,
    pub kind: Kind,
    pub kind_confidence: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RouterConfig {
    /// Ordem de preferência entre harnesses, usada quando o tipo não decide.
    pub preference: Vec<AgentId>,
    pub visual_ui: AgentId,
    pub review: AgentId,
    pub investigation: AgentId,
    /// Acima disto, `depth` sobe o effort um nível.
    pub depth: f32,
    /// Abaixo disto, a confiança no tipo não vale e a sugestão é marcada como incerta.
    pub kind: f32,
    /// Abaixo disto, vale o maior entre os dois tamanhos mais prováveis.
    pub size: f32,
}

impl Default for RouterConfig {
    fn default() -> Self {
        RouterConfig {
            preference: vec![AgentId::Claude, AgentId::Codex, AgentId::Gemini],
            visual_ui: AgentId::Gemini,
            review: AgentId::Codex,
            investigation: AgentId::Claude,
            depth: 0.7,
            kind: 0.5,
            size: 0.5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    /// `None` quando nenhum agente roteável está instalado.
    pub agent: Option<AgentId>,
    pub size: Size,
    pub bump: bool,
    /// Confiança exibida, de 0 a 100.
    pub percent: u8,
    pub unsure: bool,
}

/// Por que a consulta ao Jev não produziu sugestão.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteError {
    NoKey,
    Unauthorized,
    RateLimited,
    Overloaded,
    Timeout,
    Network,
    BadResponse,
}

impl RouteError {
    /// Texto mostrado no diálogo.
    pub fn reason(self) -> &'static str {
        match self {
            RouteError::NoKey => "no TYPESAFE_API_KEY · choosing manually",
            RouteError::Unauthorized => "Jev rejected the key · choosing manually",
            RouteError::RateLimited => "Jev rate limit reached · choosing manually",
            RouteError::Overloaded => "Jev is overloaded · choosing manually",
            RouteError::Timeout => "Jev timed out · choosing manually",
            RouteError::Network => "Jev is unreachable · choosing manually",
            RouteError::BadResponse => "unexpected answer from Jev · choosing manually",
        }
    }
}

/// Corpo da requisição: a tarefa como `state` e as três perguntas. Os critérios repetem
/// o vocabulário da documentação dos fornecedores, que é o que separa um nível do outro.
pub fn request_body(task: &str) -> Value {
    json!({
        "state": task,
        "model": "jev-latest",
        "questions": {
            "size": {
                "type": "score",
                "instructions": "How large and open-ended is this coding task?",
                "criteria": [
                    "A question about code or a trivial mechanical change, with nothing to design or verify.",
                    "States exactly what to change and where: a precisely described edit or a clearly scoped feature.",
                    "Spans several files, involves a subtle bug or an unfamiliar area, or leaves the approach open.",
                    "Describes an outcome rather than steps and is larger than a single sitting, such as a root-cause investigation or a multi-part build."
                ]
            },
            "depth": {
                "type": "noul",
                "instructions": "Does this task need extra verification or deeper reasoning than usual?",
                "criteria": {
                    "true": "A bug in existing code, likely edge cases, security or concurrency concerns, or a request to be exhaustive.",
                    "false": "Routine work where the default level of care is enough."
                }
            },
            "kind": {
                "type": "choice",
                "instructions": "Which kind of coding task is this?",
                "criteria": {
                    "visual_ui": "Build or change a user interface from an image, mockup, sketch or PDF.",
                    "review": "Review or audit existing code and report findings, without changing it.",
                    "investigation": "Find the cause of a problem whose cause is unknown, or decide an architecture.",
                    "other": "Any other coding task, including features, fixes and refactors with a known approach."
                }
            }
        }
    })
}

/// Probabilidade ou confiança: número entre 0 e 1.
fn unit(value: &Value) -> Option<f32> {
    let n = value.as_f64()?;
    (0.0..=1.0).contains(&n).then_some(n as f32)
}

/// Lê a resposta do Jev; qualquer forma inesperada vira `None`.
pub fn parse_answers(body: &Value) -> Option<Answers> {
    let answers = body.get("answers")?;
    let size = answers.get("size")?;
    let probs = size.get("probabilities")?.as_object()?;
    if probs.len() != 4 {
        return None;
    }
    let mut size_probs = [0.0; 4];
    for (level, slot) in size_probs.iter_mut().enumerate() {
        *slot = unit(probs.get(&level.to_string())?)?;
    }
    let kind = answers.get("kind")?;
    Some(Answers {
        size_probs,
        size_confidence: unit(size.get("confidence")?)?,
        depth: unit(answers.get("depth")?.get("noul")?)?,
        kind: Kind::from_name(kind.get("choice")?.as_str()?)?,
        kind_confidence: unit(kind.get("confidence")?)?,
    })
}

/// Tamanho escolhido: o mais provável ou, sem confiança, o maior dos dois mais prováveis
/// (errar para cima custa um pouco mais; errar para baixo custa a tarefa).
fn pick_size(a: &Answers, threshold: f32) -> Size {
    let mut order = [0usize, 1, 2, 3];
    order.sort_by(|x, y| a.size_probs[*y].total_cmp(&a.size_probs[*x]));
    let level = if a.size_confidence < threshold {
        order[0].max(order[1])
    } else {
        order[0]
    };
    Size::ALL[level]
}

/// Da resposta à sugestão. `usable` são os agentes instalados com catálogo conferido.
pub fn decide(a: &Answers, usable: &[AgentId], cfg: &RouterConfig) -> Decision {
    let unsure = a.kind_confidence < cfg.kind;
    let mapped = match a.kind {
        _ if unsure => None,
        Kind::VisualUi => Some(cfg.visual_ui),
        Kind::Review => Some(cfg.review),
        Kind::Investigation => Some(cfg.investigation),
        Kind::Other => None,
    };
    let agent = mapped
        .filter(|id| usable.contains(id))
        .or_else(|| {
            cfg.preference
                .iter()
                .copied()
                .find(|id| usable.contains(id))
        })
        .or_else(|| usable.first().copied());
    let confidence = a.size_confidence.min(a.kind_confidence);
    Decision {
        agent,
        size: pick_size(a, cfg.size),
        bump: a.depth > cfg.depth,
        percent: (confidence * 100.0).round() as u8,
        unsure,
    }
}

/// Próximo nível que o modelo aceita, sem passar de `Xhigh`: `max` e `ultra` só entram
/// por troca manual.
fn bumped(effort: Effort, supported: &[Effort]) -> Effort {
    supported
        .iter()
        .copied()
        .filter(|e| *e > effort && *e <= Effort::Xhigh)
        .min()
        .unwrap_or(effort)
}

/// Modelo e effort de um agente para um tamanho de tarefa.
pub fn selection(agent: AgentId, size: Size, bump: bool) -> Option<(&'static str, Option<Effort>)> {
    let (model, effort) = agents::catalog(agent)?.tiers[size as usize];
    let spec = agents::model(agent, model)?;
    let effort = match effort {
        Some(e) if bump => Some(bumped(e, spec.efforts)),
        other => other,
    };
    Some((model, effort))
}

#[cfg(test)]
mod tests;
