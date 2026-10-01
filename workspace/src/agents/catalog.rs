//! Catálogo de modelos por agente: ids, níveis de effort e como cada CLI recebe
//! modelo, effort e prompt inicial. Escrito a partir da documentação de cada ferramenta.

use super::AgentId;

/// Tamanho máximo do prompt inicial, que vai como um argumento só.
pub const MAX_PROMPT_BYTES: usize = 100_000;

/// Níveis de effort, do menor para o maior.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Effort {
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

impl Effort {
    pub const ALL: [Effort; 7] = [
        Effort::Minimal,
        Effort::Low,
        Effort::Medium,
        Effort::High,
        Effort::Xhigh,
        Effort::Max,
        Effort::Ultra,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Effort::Minimal => "minimal",
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::Xhigh => "xhigh",
            Effort::Max => "max",
            Effort::Ultra => "ultra",
        }
    }

    pub fn from_name(name: &str) -> Option<Effort> {
        Effort::ALL.into_iter().find(|e| e.name() == name)
    }
}

/// Como a CLI recebe o effort.
#[derive(Debug, Clone, Copy)]
pub enum EffortArg {
    /// `<flag> <nível>`
    Flag(&'static str),
    /// `-c <chave>=<nível>`
    ConfigKey(&'static str),
}

/// Como a CLI recebe o prompt inicial mantendo a sessão interativa.
#[derive(Debug, Clone, Copy)]
pub enum PromptArg {
    /// `-- <prompt>`: o separador impede que o começo do texto vire flag ou subcomando.
    Positional,
    /// `<flag>=<prompt>`, num argumento só.
    Flag(&'static str),
}

#[derive(Debug)]
pub struct ModelSpec {
    pub id: &'static str,
    /// Níveis aceitos; vazio quando o modelo não tem effort no lançamento.
    pub efforts: &'static [Effort],
    pub default_effort: Option<Effort>,
    /// Aviso de custo documentado pelo fornecedor.
    pub cost_note: Option<&'static str>,
}

#[derive(Debug)]
pub struct ModelCatalog {
    /// Linha de comando conferida numa instalação real; só os conferidos são roteados.
    pub verified: bool,
    pub model_flag: &'static str,
    pub effort_arg: Option<EffortArg>,
    pub prompt: Option<PromptArg>,
    pub models: &'static [ModelSpec],
    /// Modelo e effort por tamanho de tarefa: trivial, delimitada, complexa, aberta.
    pub tiers: [(&'static str, Option<Effort>); 4],
}

const LOW_TO_MAX: &[Effort] = &[
    Effort::Low,
    Effort::Medium,
    Effort::High,
    Effort::Xhigh,
    Effort::Max,
];
const LOW_TO_ULTRA: &[Effort] = &[
    Effort::Low,
    Effort::Medium,
    Effort::High,
    Effort::Xhigh,
    Effort::Max,
    Effort::Ultra,
];

const LOW_TO_HIGH: &[Effort] = &[Effort::Low, Effort::Medium, Effort::High];
const LOW_TO_XHIGH: &[Effort] = &[Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh];
const MINIMAL_TO_MAX: &[Effort] = &[
    Effort::Minimal,
    Effort::Low,
    Effort::Medium,
    Effort::High,
    Effort::Xhigh,
    Effort::Max,
];

const fn plain(id: &'static str) -> ModelSpec {
    ModelSpec {
        id,
        efforts: &[],
        default_effort: None,
        cost_note: None,
    }
}

const fn leveled(id: &'static str, efforts: &'static [Effort], default: Effort) -> ModelSpec {
    ModelSpec {
        id,
        efforts,
        default_effort: Some(default),
        cost_note: None,
    }
}

static CLAUDE: ModelCatalog = ModelCatalog {
    verified: true,
    model_flag: "--model",
    effort_arg: Some(EffortArg::Flag("--effort")),
    prompt: Some(PromptArg::Positional),
    models: &[
        ModelSpec {
            id: "fable",
            efforts: LOW_TO_MAX,
            default_effort: Some(Effort::High),
            cost_note: Some("may bill usage credits"),
        },
        leveled("opus", LOW_TO_MAX, Effort::Medium),
        leveled("sonnet", LOW_TO_MAX, Effort::Medium),
        plain("haiku"),
    ],
    tiers: [
        ("haiku", None),
        ("sonnet", Some(Effort::Medium)),
        ("opus", Some(Effort::Medium)),
        ("fable", Some(Effort::High)),
    ],
};

static CODEX: ModelCatalog = ModelCatalog {
    verified: true,
    model_flag: "-m",
    effort_arg: Some(EffortArg::ConfigKey("model_reasoning_effort")),
    prompt: Some(PromptArg::Positional),
    models: &[
        leveled("gpt-6.1-sol", LOW_TO_ULTRA, Effort::Low),
        ModelSpec {
            id: "gpt-6-astra",
            efforts: LOW_TO_ULTRA,
            default_effort: Some(Effort::Medium),
            cost_note: Some("costs 5× sol"),
        },
        leveled("gpt-6-sol", LOW_TO_ULTRA, Effort::Medium),
        leveled("gpt-6-luna", LOW_TO_MAX, Effort::Medium),
    ],
    tiers: [
        ("gpt-6-luna", Some(Effort::Low)),
        ("gpt-6-luna", Some(Effort::High)),
        ("gpt-6.1-sol", Some(Effort::Medium)),
        ("gpt-6-astra", Some(Effort::Low)),
    ],
};

/// Escrito a partir da documentação, mas ainda não executado: na máquina de referência o
/// Gemini CLI não autentica mais ("no longer supported for Gemini Code Assist for
/// individuals"). Vira `verified` quando a linha de comando rodar numa instalação real.
static GEMINI: ModelCatalog = ModelCatalog {
    verified: false,
    model_flag: "-m",
    effort_arg: None,
    prompt: Some(PromptArg::Flag("--prompt-interactive")),
    models: &[plain("pro"), plain("flash"), plain("flash-lite")],
    tiers: [
        ("flash-lite", None),
        ("flash", None),
        ("pro", None),
        ("pro", None),
    ],
};

// ---- Não conferidos: escritos a partir da documentação, fora do roteamento ----

static GROK: ModelCatalog = ModelCatalog {
    verified: false,
    model_flag: "-m",
    effort_arg: Some(EffortArg::Flag("--effort")),
    prompt: Some(PromptArg::Positional),
    models: &[
        leveled("grok-4.7", LOW_TO_XHIGH, Effort::High),
        leveled("grok-4.6", LOW_TO_XHIGH, Effort::High),
        leveled("grok-4.5", LOW_TO_HIGH, Effort::High),
    ],
    tiers: [
        ("grok-4.7", Some(Effort::Low)),
        ("grok-4.7", Some(Effort::Medium)),
        ("grok-4.7", Some(Effort::High)),
        ("grok-4.7", Some(Effort::High)),
    ],
};

static CODEBUDDY: ModelCatalog = ModelCatalog {
    verified: false,
    model_flag: "--model",
    effort_arg: Some(EffortArg::Flag("--effort")),
    prompt: Some(PromptArg::Positional),
    models: &[
        plain("fast-model"),
        plain("balanced-model"),
        plain("primary-model"),
        plain("deep-model"),
    ],
    tiers: [
        ("fast-model", None),
        ("balanced-model", None),
        ("primary-model", None),
        ("deep-model", None),
    ],
};

static ANTIGRAVITY: ModelCatalog = ModelCatalog {
    verified: false,
    model_flag: "--model",
    effort_arg: Some(EffortArg::Flag("--effort")),
    prompt: Some(PromptArg::Flag("--prompt-interactive")),
    models: &[
        leveled("gemini-3.8-flash", LOW_TO_HIGH, Effort::Medium),
        leveled("gemini-3.1-pro", &[Effort::Low, Effort::High], Effort::High),
    ],
    tiers: [
        ("gemini-3.8-flash", Some(Effort::Low)),
        ("gemini-3.8-flash", Some(Effort::Medium)),
        ("gemini-3.8-flash", Some(Effort::High)),
        ("gemini-3.1-pro", Some(Effort::High)),
    ],
};

static MUSE: ModelCatalog = ModelCatalog {
    verified: false,
    model_flag: "--model",
    effort_arg: Some(EffortArg::Flag("--reasoning-effort")),
    // Sem forma documentada de passar prompt à sessão interativa
    prompt: None,
    models: &[
        leveled("muse-spark-1.3", &Effort::ALL, Effort::High),
        leveled("muse-spark-1.2", &Effort::ALL, Effort::High),
    ],
    tiers: [
        ("muse-spark-1.3", Some(Effort::Medium)),
        ("muse-spark-1.3", Some(Effort::Medium)),
        ("muse-spark-1.3", Some(Effort::High)),
        ("muse-spark-1.3", Some(Effort::Xhigh)),
    ],
};

/// OMP não tem lista fixa de modelos: o que dá para embarcar são os papéis.
static OMP: ModelCatalog = ModelCatalog {
    verified: false,
    model_flag: "--model",
    effort_arg: Some(EffortArg::Flag("--thinking")),
    prompt: Some(PromptArg::Positional),
    models: &[
        leveled("@smol", MINIMAL_TO_MAX, Effort::High),
        leveled("@default", MINIMAL_TO_MAX, Effort::High),
        leveled("@slow", MINIMAL_TO_MAX, Effort::High),
    ],
    tiers: [
        ("@smol", None),
        ("@default", None),
        ("@default", None),
        ("@slow", None),
    ],
};

/// O catálogo do Cursor varia por conta; só estes dois ids são estáveis na documentação.
static CURSOR: ModelCatalog = ModelCatalog {
    verified: false,
    model_flag: "--model",
    effort_arg: None,
    prompt: Some(PromptArg::Positional),
    models: &[plain("auto"), plain("composer-2.5")],
    tiers: [
        ("composer-2.5", None),
        ("composer-2.5", None),
        ("auto", None),
        ("auto", None),
    ],
};

pub fn catalog(id: AgentId) -> Option<&'static ModelCatalog> {
    match id {
        AgentId::Claude => Some(&CLAUDE),
        AgentId::Codex => Some(&CODEX),
        AgentId::Gemini => Some(&GEMINI),
        AgentId::Grok => Some(&GROK),
        AgentId::Codebuddy => Some(&CODEBUDDY),
        AgentId::Antigravity => Some(&ANTIGRAVITY),
        AgentId::Muse => Some(&MUSE),
        AgentId::Omp => Some(&OMP),
        AgentId::Cursor => Some(&CURSOR),
        _ => None,
    }
}

pub fn model(id: AgentId, model: &str) -> Option<&'static ModelSpec> {
    catalog(id)?.models.iter().find(|m| m.id == model)
}
