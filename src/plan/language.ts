/**
 * Lightweight language detection based on stop word frequency.
 * Supports pt (Portuguese), en (English), and es (Spanish).
 * Returns ISO 639-1 language code. Defaults to "en".
 */

const STOP_WORDS: Record<string, Set<string>> = {
	pt: new Set([
		"não",
		"também",
		"já",
		"está",
		"são",
		"nos",
		"das",
		"dos",
		"pelo",
		"pela",
		"uma",
		"nas",
		"aos",
		"essa",
		"esse",
		"isso",
		"aqui",
		"muito",
		"quando",
		"como",
		"mais",
		"ainda",
		"fazer",
		"deve",
		"pode",
		"cada",
		"todos",
		"todas",
		"entre",
		"após",
		"sobre",
		"seus",
		"suas",
		"desta",
		"deste",
		"onde",
		"apenas",
		// Common contractions (preposition + article)
		"na",
		"no",
		"da",
		"do",
		"ao",
		"num",
		"numa",
		"para",
		"com",
		"sem",
		"ou",
	]),
	es: new Set([
		"también",
		"más",
		"pero",
		"muy",
		"está",
		"están",
		"puede",
		"todo",
		"esta",
		"este",
		"como",
		"cuando",
		"donde",
		"cada",
		"entre",
		"sobre",
		"después",
		"antes",
		"desde",
		"hasta",
		"según",
		"durante",
		"todos",
		"todas",
		"otro",
		"otra",
		"otros",
		"otras",
		"hacer",
		"debe",
		"aquí",
		"ahora",
		"siempre",
		"nunca",
	]),
	en: new Set([
		"the",
		"is",
		"are",
		"was",
		"were",
		"been",
		"being",
		"have",
		"has",
		"had",
		"having",
		"does",
		"did",
		"will",
		"would",
		"could",
		"should",
		"might",
		"shall",
		"this",
		"that",
		"these",
		"those",
		"with",
		"from",
		"into",
		"through",
		"during",
		"before",
		"after",
		"above",
		"below",
		"between",
		"each",
		"every",
		"which",
		"when",
		"where",
		"while",
	]),
};

const LANGUAGE_NAMES: Record<string, string> = {
	pt: "Portuguese",
	es: "Spanish",
	en: "English",
};

export function detectLanguage(text: string): string {
	const words = text
		.toLowerCase()
		.replace(/[^\p{L}\s]/gu, "")
		.split(/\s+/)
		.filter((w) => w.length > 1);

	if (words.length === 0) return "en";

	const scores: Record<string, number> = { pt: 0, es: 0, en: 0 };

	for (const word of words) {
		for (const [lang, stopWords] of Object.entries(STOP_WORDS)) {
			if (stopWords.has(word)) {
				scores[lang]!++;
			}
		}
	}

	const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]!;
	return best[1] > 0 ? best[0] : "en";
}

export function languageName(code: string): string {
	return LANGUAGE_NAMES[code] ?? "English";
}
