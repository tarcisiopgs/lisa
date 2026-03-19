import * as logger from "../output/logger.js";
import { normalizeLabels } from "../sources/base.js";
import type { PlanResult, Source, SourceConfig } from "../types/index.js";

/**
 * Create all plan issues in the source, in order.
 * Links dependencies where the source supports it.
 * Returns array of created issue IDs.
 */
export async function createPlanIssues(
	source: Source,
	config: SourceConfig,
	plan: PlanResult,
): Promise<string[]> {
	if (!source.createIssue) {
		throw new Error(`Source "${source.name}" does not support createIssue`);
	}

	const labels = normalizeLabels(config);
	const primaryLabel = labels[0] ?? "";
	const sorted = [...plan.issues].sort((a, b) => a.order - b.order);
	const createdIds: string[] = [];
	// Map order → created issue ID for dependency linking
	const orderToId = new Map<number, string>();

	for (const issue of sorted) {
		// Add dependency note to description for sources without native linking
		let description = issue.description;
		if (issue.dependsOn.length > 0 && !source.linkDependency) {
			const depRefs = issue.dependsOn
				.map((depOrder) => {
					const depId = orderToId.get(depOrder);
					return depId ? `#${depId}` : `step ${depOrder}`;
				})
				.join(", ");
			description += `\n\n---\n_Depends on: ${depRefs}_`;
		}

		const id = await source.createIssue(
			{
				title: issue.title,
				description,
				status: config.pick_from,
				label: primaryLabel,
				order: issue.order,
				parentId: plan.sourceIssueId,
			},
			config,
		);

		createdIds.push(id);
		orderToId.set(issue.order, id);
		logger.ok(`${id}: ${issue.title}`);

		// Link dependencies where supported
		if (source.linkDependency && issue.dependsOn.length > 0) {
			for (const depOrder of issue.dependsOn) {
				const depId = orderToId.get(depOrder);
				if (depId) {
					try {
						await source.linkDependency(id, depId);
					} catch (err) {
						logger.warn(
							`Could not link dependency ${id} → ${depId}: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}
		}
	}

	return createdIds;
}
