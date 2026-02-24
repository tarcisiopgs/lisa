import type { Source, SourceName } from "../types.js";
import { GitLabIssuesSource } from "./gitlab-issues.js";
import { JiraSource } from "./jira.js";
import { LinearSource } from "./linear.js";
import { PlaneSource } from "./plane.js";
import { ShortcutSource } from "./shortcut.js";
import { TrelloSource } from "./trello.js";

const sources: Record<SourceName, () => Source> = {
	linear: () => new LinearSource(),
	trello: () => new TrelloSource(),
	plane: () => new PlaneSource(),
	shortcut: () => new ShortcutSource(),
	"gitlab-issues": () => new GitLabIssuesSource(),
	jira: () => new JiraSource(),
};

export function createSource(name: SourceName): Source {
	const factory = sources[name];
	if (!factory) {
		throw new Error(`Unknown source: ${name}. Available: ${Object.keys(sources).join(", ")}`);
	}
	return factory();
}
