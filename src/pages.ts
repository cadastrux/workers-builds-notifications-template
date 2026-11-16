/**
 * Cloudflare Pages: avisa falhas de build.
 *
 * Pages não publica Event Subscriptions como o Workers Builds, então o cron
 * consulta a lista de projetos (1 requisição por conta traz a última
 * implantação de todos os projetos) e avisa as que falharam dentro da
 * janela desde a execução anterior. Projetos novos entram automaticamente.
 *
 * Permissão extra do CLOUDFLARE_API_TOKEN: Cloudflare Pages: Read
 */

import type { Env } from "./types";
import type { SlackPayload } from "./slack";
import { sendSlackNotification } from "./slack";
import { extractBuildError } from "./helpers";
import { Budget, cf, describe } from "./subscriptions";

interface PagesDeployment {
	id: string;
	environment?: "production" | "preview";
	url?: string;
	latest_stage?: { name?: string; status?: string; ended_on?: string | null };
	deployment_trigger?: {
		metadata?: { branch?: string; commit_hash?: string; commit_message?: string };
	};
}

interface PagesProject {
	name: string;
	latest_deployment?: PagesDeployment | null;
}

interface PagesLogs {
	data?: { line: string; ts: string }[];
}

/** A deployment "conta" para esta execução se terminou em (inicio, fim]. */
export function failedInWindow(d: PagesDeployment | null | undefined, from: number, to: number): boolean {
	const stage = d?.latest_stage;
	if (!stage || stage.status !== "failure" || !stage.ended_on) return false;
	const ended = Date.parse(stage.ended_on);
	return ended > from && ended <= to;
}

function buildPagesFailurePayload(
	accountId: string,
	project: string,
	d: PagesDeployment,
	logs: string[],
): SlackPayload {
	const meta = d.deployment_trigger?.metadata;
	const dashUrl = `https://dash.cloudflare.com/${accountId}/pages/view/${project}/${d.id}`;
	const context: string[] = [];
	if (meta?.branch) context.push(`*Branch:* \`${meta.branch}\``);
	if (meta?.commit_hash) context.push(`*Commit:* \`${meta.commit_hash.substring(0, 7)}\``);
	if (meta?.commit_message) context.push(`*Msg:* ${meta.commit_message.split("\n")[0].slice(0, 120)}`);
	if (d.latest_stage?.name) context.push(`*Etapa:* ${d.latest_stage.name}`);

	return {
		blocks: [
			{
				type: "section",
				text: { type: "mrkdwn", text: `❌  *Build Failed (Pages)*\n*${project}*` },
				accessory: {
					type: "button",
					text: { type: "plain_text", text: "View Logs" },
					url: dashUrl,
					style: "danger",
				},
			},
			...(context.length
				? [{ type: "context" as const, elements: context.map((text) => ({ type: "mrkdwn" as const, text })) }]
				: []),
			{ type: "section", text: { type: "mrkdwn", text: `\`\`\`${extractBuildError(logs)}\`\`\`` } },
		],
	};
}

export async function checkPagesFailures(
	env: Env,
	budget: Budget,
	accountIds: string[],
	windowStart: number,
	windowEnd: number,
): Promise<void> {
	if (!env.SLACK_WEBHOOK_URL) return;

	for (const accountId of accountIds) {
		const base = `/accounts/${accountId}/pages/projects`;
		const projects: PagesProject[] = [];
		for (let page = 1; ; page++) {
			const res = await cf<PagesProject[]>(env, budget, `${base}?per_page=10&page=${page}`);
			if (!res.body?.success) {
				console.error(`[pages] Erro ao listar projetos (HTTP ${res.status}): ${describe(res.body)}`);
				break;
			}
			projects.push(...res.body.result);
			const total = res.body.result_info?.total_pages ?? 1;
			if (page >= total || res.body.result.length === 0) break;
		}

		let notified = 0;
		for (const p of projects) {
			const d = p.latest_deployment;
			if (!d || !failedInWindow(d, windowStart, windowEnd)) continue;

			let logs: string[] = [];
			const logRes = await cf<PagesLogs>(env, budget, `${base}/${p.name}/deployments/${d.id}/history/logs`);
			if (logRes.body?.success) {
				logs = (logRes.body.result?.data ?? []).map((l) => l.line);
			} else {
				console.error(`[pages] Erro ao ler logs de ${p.name}: ${describe(logRes.body)}`);
			}

			budget.take(); // envio ao webhook também conta como subrequest
			await sendSlackNotification(env.SLACK_WEBHOOK_URL, buildPagesFailurePayload(accountId, p.name, d, logs));
			notified++;
		}

		console.log(`[pages] ${accountId}: ${projects.length} projetos verificados, ${notified} falhas avisadas.`);
	}
}
