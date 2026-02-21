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
