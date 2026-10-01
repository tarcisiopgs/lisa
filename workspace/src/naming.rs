//! Nomes automáticos de worktree. Sem acaso: o mesmo estado dá sempre o mesmo nome.

/// Vocabulário de jazz, em alusão ao saxofone da Lisa. Tudo minúsculo e seguro para branch.
pub const WORDS: &[&str] = &[
    "bebop",
    "riff",
    "swing",
    "blues",
    "tempo",
    "chord",
    "reed",
    "solo",
    "groove",
    "vamp",
    "stride",
    "scat",
    "coda",
    "verse",
    "chorus",
    "cadence",
    "octave",
    "tenor",
    "alto",
    "baritone",
    "brass",
    "horn",
    "sax",
    "trumpet",
    "cornet",
    "piano",
    "organ",
    "cymbal",
    "snare",
    "mallet",
    "vibes",
    "fiddle",
    "banjo",
    "clarinet",
    "flute",
    "trombone",
    "tuba",
    "quartet",
    "quintet",
    "combo",
    "ragtime",
    "dixie",
    "bossa",
    "samba",
    "mambo",
    "modal",
    "fusion",
    "ballad",
    "shuffle",
    "lick",
    "tune",
    "jam",
    "encore",
    "improv",
    "rhythm",
    "melody",
    "harmony",
    "tritone",
    "voicing",
    "upbeat",
    "downbeat",
    "backbeat",
    "legato",
    "staccato",
    "vibrato",
    "glissando",
    "ostinato",
    "motif",
    "refrain",
    "interlude",
    "overture",
    "serenade",
];

/// Palavras que não dizem nada sobre a tarefa (inglês e português).
const STOPWORDS: &[&str] = &[
    "a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "when", "with", "is", "are",
    "that", "this", "it", "be", "as", "at", "by", "from", "o", "os", "as", "um", "uma", "de", "do",
    "da", "dos", "das", "em", "no", "na", "nos", "nas", "para", "pra", "com", "que", "e", "ou",
    "quando", "se", "por",
];

const TASK_WORDS: usize = 4;
const TASK_NAME_MAX: usize = 32;

fn fold(c: char) -> char {
    match c {
        'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        other => other,
    }
}

/// Nome a partir das primeiras palavras da tarefa; `None` quando nada sobra.
pub fn task_name(task: &str) -> Option<String> {
    let folded: String = task.to_lowercase().chars().map(fold).collect();
    let mut name = String::new();
    for word in folded
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty() && !STOPWORDS.contains(w))
        .take(TASK_WORDS)
    {
        let longer = name.len() + word.len() + usize::from(!name.is_empty());
        if longer > TASK_NAME_MAX {
            break;
        }
        if !name.is_empty() {
            name.push('-');
        }
        name.push_str(word);
    }
    (!name.is_empty()).then_some(name)
}

/// `name`, ou `name-2`, `name-3`… até não estar em `taken`.
pub fn unique(name: &str, taken: &[&str]) -> String {
    if !taken.contains(&name) {
        return name.to_owned();
    }
    (2..)
        .map(|n| format!("{name}-{n}"))
        .find(|candidate| !taken.contains(&candidate.as_str()))
        .unwrap_or_else(|| name.to_owned())
}

/// Palavra da lista para um worktree sem tarefa: a primeira livre, começando num ponto que
/// depende do projeto, para projetos diferentes não repetirem a mesma sequência.
pub fn word_name(project: &str, taken: &[&str]) -> String {
    // FNV-1a: estável entre versões e plataformas, ao contrário do hasher padrão
    let hash = project.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    let len = WORDS.len();
    let start = usize::try_from(hash % u64::try_from(len).unwrap_or(1)).unwrap_or(0);
    (0..len)
        .map(|i| WORDS[(start + i) % len])
        .find(|word| !taken.contains(word))
        .map_or_else(|| unique(WORDS[start], taken), str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_task_becomes_its_first_meaningful_words() {
        assert_eq!(
            task_name("Fix the redirect loop on login when the session cookie has expired"),
            Some("fix-redirect-loop-login".into())
        );
        assert_eq!(
            task_name("Corrigir a paginação do relatório de ações"),
            Some("corrigir-paginacao-relatorio".into())
        );
    }

    #[test]
    fn a_task_name_never_passes_the_limit_or_cuts_a_word() {
        let name = task_name("internationalization configuration troubleshooting documentation")
            .unwrap_or_default();
        assert_eq!(name, "internationalization");
        assert!(name.len() <= TASK_NAME_MAX);
    }

    #[test]
    fn a_task_with_nothing_to_say_gives_no_name() {
        assert_eq!(task_name("   "), None);
        assert_eq!(task_name("the of a"), None);
        assert_eq!(task_name("🚀 !!!"), None);
    }

    #[test]
    fn unique_appends_the_first_free_number() {
        assert_eq!(unique("fix", &[]), "fix");
        assert_eq!(unique("fix", &["fix", "fix-2"]), "fix-3");
    }

    #[test]
    fn the_same_project_and_state_always_give_the_same_word() {
        let first = word_name("lisa", &[]);
        assert_eq!(first, word_name("lisa", &[]));
        assert!(WORDS.contains(&first.as_str()));
        let second = word_name("lisa", &[first.as_str()]);
        assert_ne!(first, second);
        assert_eq!(second, word_name("lisa", &[first.as_str()]));
    }

    #[test]
    fn projects_start_at_different_words() {
        let starts: std::collections::BTreeSet<String> = ["lisa", "glowz", "findup", "bloom"]
            .iter()
            .map(|p| word_name(p, &[]))
            .collect();
        assert!(starts.len() > 1, "{starts:?}");
    }

    #[test]
    fn an_exhausted_list_still_gives_a_free_name() {
        let name = word_name("lisa", WORDS);
        assert!(!WORDS.contains(&name.as_str()), "{name}");
    }

    #[test]
    fn every_word_is_a_valid_distinct_branch_name() {
        let mut seen = std::collections::BTreeSet::new();
        for word in WORDS {
            assert_eq!(
                crate::git::sanitize_branch(word).ok().as_deref(),
                Some(*word)
            );
            assert!(seen.insert(word), "{word} repeats");
            assert!(!matches!(*word, "main" | "master" | "head"));
        }
    }
}
