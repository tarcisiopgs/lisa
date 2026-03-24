import { execSync } from "node:child_process";
import type { Issue } from "./types/index.js";

const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"shall",
	"can",
	"need",
	"must",
	"and",
	"or",
	"but",
	"not",
	"no",
	"nor",
	"so",
	"yet",
	"in",
	"on",
	"at",
	"to",
	"for",
	"of",
	"with",
	"by",
	"from",
	"as",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"out",
	"off",
	"over",
	"under",
	"again",
	"further",
	"then",
	"once",
	"here",
	"there",
	"when",
	"where",
	"why",
	"how",
	"all",
	"each",
	"every",
	"both",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"only",
	"own",
	"same",
	"than",
	"too",
	"very",
	"just",
	"because",
	"if",
	"while",
	"until",
	"about",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
	"i",
	"we",
	"you",
	"they",
	"he",
	"she",
	"me",
	"us",
	"him",
	"her",
	"them",
	"my",
	"our",
	"your",
	"their",
	"what",
	"which",
	"who",
	"whom",
	"whose",
	// Portuguese stop words
	"de",
	"da",
	"do",
	"das",
	"dos",
	"em",
	"na",
	"no",
	"nas",
	"nos",
	"um",
	"uma",
	"uns",
	"umas",
	"por",
	"para",
	"com",
	"sem",
	"sob",
	"como",
	"mais",
	"menos",
	"muito",
	"quando",
	"onde",
	"que",
	"qual",
	"se",
	"ou",
	"ao",
	"aos",
	"pela",
	"pelo",
	"pelas",
	"pelos",
	"ser",
	"ter",
	"estar",
	"fazer",
	"ir",
	"vir",
	"poder",
	"dever",
	"isso",
	"isto",
	"esse",
	"esta",
	"este",
	"essa",
	"aquele",
	"aquela",
	// Common tech words that are too generic
	"add",
	"fix",
	"update",
	"change",
	"create",
	"remove",
	"delete",
	"implement",
	"feature",
	"bug",
	"issue",
	"error",
	"new",
	"file",
	"code",
	"function",
	"method",
	"class",
	"type",
	"interface",
]);

const EXCLUDE_DIRS = [
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	".nuxt",
	"coverage",
	".cache",
	".worktrees",
	".lisa",
];

const EXCLUDE_EXTENSIONS = [
	"*.lock",
	"*.map",
	"*.min.js",
	"*.min.css",
	"*.d.ts",
	"*.png",
	"*.jpg",
	"*.jpeg",
	"*.gif",
	"*.svg",
	"*.ico",
	"*.woff",
	"*.woff2",
	"*.ttf",
	"*.eot",
];

export function extractKeywords(text: string): string[] {
	// Strip markdown formatting, URLs, code blocks
	const cleaned = text
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`]+`/g, "")
		.replace(/https?:\/\/\S+/g, "")
		.replace(/[#*_[\](){}|>~]/g, " ");

	const words = cleaned
		.split(/[\s/\\.,;:!?'"()[\]{}<>=+\-*&^%$@#~`|]+/)
		.map((w) => w.toLowerCase().trim())
		.filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
		.filter((w) => !/^\d+$/.test(w)); // exclude pure numbers

	return [...new Set(words)];
}

export function enrichContext(cwd: string, issue: Issue): string | null {
	const keywords = extractKeywords(`${issue.title} ${issue.description}`);
	if (keywords.length === 0) return null;

	// Build grep exclude args
	const excludeDirs = EXCLUDE_DIRS.map((d) => `--exclude-dir=${d}`).join(" ");
	const excludeExts = EXCLUDE_EXTENSIONS.map((e) => `--exclude=${e}`).join(" ");

	// Search for each keyword and count file occurrences
	const fileCounts = new Map<string, number>();

	for (const keyword of keywords.slice(0, 15)) {
		// limit to 15 keywords for speed
		try {
			const result = execSync(
				`grep -rl ${excludeDirs} ${excludeExts} -i --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.py' --include='*.rb' --include='*.go' --include='*.rs' --include='*.java' --include='*.yaml' --include='*.yml' --include='*.json' -- ${JSON.stringify(keyword)} . 2>/dev/null || true`,
				{ cwd, encoding: "utf-8", timeout: 5000, maxBuffer: 1024 * 1024 },
			);
			const files = result.trim().split("\n").filter(Boolean);
			for (const file of files) {
				const rel = file.startsWith("./") ? file.slice(2) : file;
				fileCounts.set(rel, (fileCounts.get(rel) ?? 0) + 1);
			}
		} catch {
			// grep timeout or error — skip this keyword
		}
	}

	if (fileCounts.size === 0) return null;

	// Rank by frequency and take top 10
	const ranked = [...fileCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([file]) => file);

	const fileList = ranked.map((f) => `- \`${f}\``).join("\n");

	return `## Relevant Files

Based on the issue description, these files are likely relevant:

${fileList}

Read these files first to understand the existing implementation before making changes.`;
}
