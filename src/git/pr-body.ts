export const PROVIDER_ATTRIBUTION_RE =
	/claude\.ai|claude\s+code|gemini\s+cli|openai\s+codex|\bgoose\b|\baider\b|github\s+copilot|cursor\s+agent|\bopencode\b/i;

const AI_COAUTHOR_RE =
	/co-authored-by:[^\n]*(anthropic|claude|gemini|openai|codex|goose|aider|copilot|cursor|google)/i;

export function stripProviderAttribution(body: string): string {
	let result = body;

	// Strip trailing --- sections that are provider attributions
	while (true) {
		const sepIndex = result.lastIndexOf("\n---");
		if (sepIndex === -1) break;

		const section = result.slice(sepIndex);
		if (PROVIDER_ATTRIBUTION_RE.test(section) || AI_COAUTHOR_RE.test(section)) {
			result = result.slice(0, sepIndex).trimEnd();
		} else {
			break;
		}
	}

	// Strip trailing AI Co-Authored-By lines outside --- blocks
	result = result.replace(
		/\n+Co-Authored-By:[^\n]*(anthropic|claude|gemini|openai|codex|goose|aider|copilot|cursor|google)[^\n]*/gi,
		"",
	);

	return result.trimEnd();
}

export function sanitizePrBody(raw: string): string {
	let text = raw.trim();
	if (!text) return "";

	// Strip HTML tags
	text = text.replace(/<[^>]*>/g, "");

	// Normalize * bullets to - bullets (only at line start, with optional leading whitespace)
	text = text.replace(/^(\s*)\* /gm, "$1- ");

	// If no newlines at all (wall of text), split on sentence boundaries
	if (!text.includes("\n")) {
		const sentences = text.match(/[^.!?]+[.!?]+/g);
		if (sentences && sentences.length > 1) {
			text = sentences.map((s) => `- ${s.trim()}`).join("\n");
		}
	}

	return text.trim();
}
