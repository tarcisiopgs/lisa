import type { Source, SourceName } from "../types.js";
import { LinearSource } from "./linear.js";
import { ShortcutSource } from "./shortcut.js";
import { TrelloSource } from "./trello.js";

const sources: Record<SourceName, () => Source> = {
	linear: () => new LinearSource(),
	trello: () => new TrelloSource(),
	shortcut: () => new ShortcutSource(),
};

export function createSource(name: SourceName): Source {
	const factory = sources[name];
	if (!factory) {
		throw new Error(`Unknown source: ${name}. Available: ${Object.keys(sources).join(", ")}`);
	}
	return factory();
}
