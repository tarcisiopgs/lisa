import type { Source, SourceName } from "../types.js";
import { LinearSource } from "./linear.js";
import { NotionSource } from "./notion.js";

const sources: Record<SourceName, () => Source> = {
	linear: () => new LinearSource(),
	notion: () => new NotionSource(),
};

export function createSource(name: SourceName): Source {
	const factory = sources[name];
	if (!factory) {
		throw new Error(`Unknown source: ${name}. Available: ${Object.keys(sources).join(", ")}`);
	}
	return factory();
}
