/**
 * Cloudflare Workers Builds → Slack Notifications
 *
 * This worker consumes build events from a Cloudflare Queue and sends
 * notifications to Slack with:
 * - Preview/Live URLs for successful builds
 * - Error messages for failed builds
 * - Cancellation notices for cancelled builds
 *
 * @see https://developers.cloudflare.com/workers/ci-cd/builds
 * @see https://developers.cloudflare.com/queues/
 * @see https://developers.cloudflare.com/queues/event-subscriptions/
 */

import type { Env, CloudflareEvent } from "./types";
import { getBuildStatus } from "./helpers";
import { fetchBuildUrls, fetchBuildLogs } from "./api";
import { buildSlackPayload, sendSlackNotification } from "./slack";
import { Budget, getAccountIds, syncSubscriptions } from "./subscriptions";
import { checkPagesFailures } from "./pages";
import { pendingKey, rememberFailure, resolvePending } from "./state";

/** Intervalo do cron (wrangler.jsonc: "*\/5 * * * *"). */
const CRON_INTERVAL_MS = 5 * 60 * 1000;

async function runScheduled(env: Env, scheduledTime: number): Promise<void> {
	if (!env.CLOUDFLARE_API_TOKEN) {
		console.error("[cron] CLOUDFLARE_API_TOKEN não configurado");
		return;
	}
	const budget = new Budget();
	try {
		const accountIds = await getAccountIds(env, budget);

		// Pages: falhas desde a execução anterior
		await checkPagesFailures(env, budget, accountIds, scheduledTime - CRON_INTERVAL_MS, scheduledTime);

		// Workers Builds: novas assinaturas a cada 15 min
		if (new Date(scheduledTime).getUTCMinutes() % 15 === 0) {
			await syncSubscriptions(env, budget, accountIds);
		}
	} catch (error) {
		console.error("[cron] Erro:", error);
	}
}

export default {
	/** Cron: avisa falhas do Pages e cria assinaturas para Workers novos. */
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(runScheduled(env, controller.scheduledTime));
	},

	async queue(batch: MessageBatch<CloudflareEvent>, env: Env): Promise<void> {
		if (!env.SLACK_WEBHOOK_URL) {
			console.error("SLACK_WEBHOOK_URL is not configured");
			for (const message of batch.messages) {
				message.ack();
			}
			return;
		}

		for (const message of batch.messages) {
			try {
				const event = message.body;

				// Validate event structure
				if (!event?.type || !event?.payload || !event?.metadata) {
					console.error("Invalid event structure:", JSON.stringify(event));
					message.ack();
					continue;
				}

				// Skip started/queued events - no notification needed
				if (event.type.includes("started") || event.type.includes("queued")) {
					message.ack();
					continue;
				}

				const status = getBuildStatus(event);
				const workerName = event.source?.workerName;
				const key = workerName ? pendingKey("worker", event.metadata.accountId, workerName) : null;

				// Sucesso: apaga a mensagem de falha anterior (se houver)
				if (status.isSucceeded && key && (await resolvePending(env, key))) {
					console.log(`${workerName} voltou a funcionar, mensagem apagada.`);
				}
				if (status.isSucceeded && env.NOTIFY_SUCCESS !== "true") {
					message.ack();
					continue;
				}

				// Fetch additional data based on build status
				let previewUrl: string | null = null;
				let liveUrl: string | null = null;
				let logs: string[] = [];

				if (status.isSucceeded) {
					({ previewUrl, liveUrl } = await fetchBuildUrls(event, env));
				} else if (status.isFailed && !status.isCancelled) {
					logs = await fetchBuildLogs(event, env);
				}

				// Build and send Slack notification
				const payload = buildSlackPayload(event, previewUrl, liveUrl, logs);
				const messageId = await sendSlackNotification(env.SLACK_WEBHOOK_URL, payload);

				// Falha: guarda o id para apagar quando a build passar
				if (status.isFailed && !status.isCancelled && key) {
					await rememberFailure(env, key, messageId);
				}

				message.ack();
			} catch (error) {
				console.error("Error processing message:", error);
				message.ack();
			}
		}
	},
} satisfies ExportedHandler<Env, CloudflareEvent>;
