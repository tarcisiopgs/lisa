import type { Source, SourceName } from "../types.js";
import { GitHubIssuesSource } from "./github-issues.js";
import { GitLabIssuesSource } from "./gitlab-issues.js";
import { LinearSource } from "./linear.js";
import { TrelloSource } from "./trello.js";

const sources: Record<SourceName, () => Source> = {
	linear: () => new LinearSource(),
	trello: () => new TrelloSource(),
	"gitlab-issues": () => new GitLabIssuesSource(),
	"github-issues": () => new GitHubIssuesSource(),
};

export function createSource(name: SourceName): Source {
	const factory = sources[name];
	if (!factory) {
		throw new Error(`Unknown source: ${name}. Available: ${Object.keys(sources).join(", ")}`);
	}
	return factory();
}
