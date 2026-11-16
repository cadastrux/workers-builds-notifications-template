/**
 * Auto-subscribe: garante que todo Worker com Workers Builds da conta
 * tenha uma Event Subscription apontando para a fila de notificações.
 *
 * Roda pelo Cron Trigger (ver "triggers" no wrangler.jsonc). Assim, sites
 * novos criados por qualquer pessoa na conta passam a ser vigiados sozinhos.
 *
 * Permissões extras do CLOUDFLARE_API_TOKEN:
 *   - Queues: Edit (criar assinaturas)
 *   - Account Settings: Read (só se ACCOUNT_ID não estiver configurado)
 */

import type { Env } from "./types";

const API = "https://api.cloudflare.com/client/v4";

/** Nome da fila consumida por este Worker (igual ao wrangler.jsonc). */
const QUEUE_NAME = "builds-event-subscriptions";

/** Eventos assinados para cada Worker. */
const EVENTS = ["build.failed"];

/**
 * O plano Free permite 50 subrequests por execução. Guardamos uma margem
 * e deixamos o restante para a próxima execução do cron.
 */
const MAX_REQUESTS = 45;

interface CfResponse<T> {
	success: boolean;
	errors?: { code: number; message: string }[];
	result: T;
	result_info?: { page: number; total_pages?: number };
}

interface Script {
	id: string;
	tag: string;
}

interface Subscription {
	source: { type: string; worker_name?: string };
	destination: { queue_id: string };
}

interface Queue {
	queue_id: string;
	queue_name: string;
}

class Budget {
	used = 0;
	take(): boolean {
		if (this.used >= MAX_REQUESTS) return false;
		this.used++;
		return true;
	}
}

async function cf<T>(
	env: Env,
	budget: Budget,
	path: string,
	init: RequestInit = {},
): Promise<{ status: number; body: CfResponse<T> | null }> {
	if (!budget.take()) throw new Error("subrequest budget exhausted");
	const res = await fetch(`${API}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
	});
	let body: CfResponse<T> | null = null;
	try {
		body = (await res.json()) as CfResponse<T>;
	} catch {
		// resposta sem JSON
	}
	return { status: res.status, body };
}

function describe(body: CfResponse<unknown> | null): string {
	return body?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || "sem detalhes";
}

async function getAccountIds(env: Env, budget: Budget): Promise<string[]> {
	if (env.ACCOUNT_ID) return [env.ACCOUNT_ID];
	const { body } = await cf<{ id: string }[]>(env, budget, "/accounts?per_page=50");
	if (!body?.success) {
		console.error(
			`[auto-subscribe] Não consegui listar contas (${describe(body)}). ` +
				"Configure o secret ACCOUNT_ID ou dê 'Account Settings: Read' ao token.",
		);
		return [];
	}
	return body.result.map((a) => a.id);
}

/** Embaralha para que, se o orçamento acabar, a próxima execução cubra outros Workers. */
function shuffle<T>(items: T[]): T[] {
	const a = [...items];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

async function syncAccount(env: Env, budget: Budget, accountId: string): Promise<void> {
	const base = `/accounts/${accountId}`;

	// 1. Fila de destino
	const queues = await cf<Queue[]>(env, budget, `${base}/queues?per_page=500`);
	const queue = queues.body?.result?.find((q) => q.queue_name === QUEUE_NAME);
	if (!queue) {
		console.log(`[auto-subscribe] ${accountId}: fila "${QUEUE_NAME}" não existe, pulando.`);
		return;
	}

	// 2. Workers que já têm assinatura para esta fila
	const subscribed = new Set<string>();
	for (let page = 1; ; page++) {
		const subs = await cf<Subscription[]>(
			env,
			budget,
			`${base}/event_subscriptions/subscriptions?per_page=100&page=${page}`,
		);
		if (!subs.body?.success) {
			console.error(`[auto-subscribe] Erro ao listar assinaturas: ${describe(subs.body)}`);
			return;
		}
		for (const s of subs.body.result) {
			if (
				s.source?.type === "workersBuilds.worker" &&
				s.source.worker_name &&
				s.destination?.queue_id === queue.queue_id
			) {
				subscribed.add(s.source.worker_name);
			}
		}
		const totalPages = subs.body.result_info?.total_pages ?? 1;
		if (page >= totalPages) break;
	}

	// 3. Workers da conta
	const scripts = await cf<Script[]>(env, budget, `${base}/workers/scripts`);
	if (!scripts.body?.success) {
		console.error(`[auto-subscribe] Erro ao listar Workers: ${describe(scripts.body)}`);
		return;
	}
	const pending = shuffle(scripts.body.result.filter((s) => !subscribed.has(s.id)));

	// 4. Para cada Worker sem assinatura: tem Workers Builds? Então assina.
	let created = 0;
	for (const script of pending) {
		if (budget.used + 2 > MAX_REQUESTS) {
			console.log("[auto-subscribe] Limite de requisições atingido, continua na próxima execução.");
			break;
		}

		const cfg = await cf<unknown>(env, budget, `${base}/builds/workers/${script.tag}`);
		if (cfg.status === 404) continue; // Worker sem Git/Workers Builds
		if (!cfg.body?.success) {
			console.error(
				`[auto-subscribe] Erro ao ler build de ${script.id} (HTTP ${cfg.status}): ${describe(cfg.body)}`,
			);
			continue;
		}

		const res = await cf<unknown>(env, budget, `${base}/event_subscriptions/subscriptions`, {
			method: "POST",
			body: JSON.stringify({
				name: `auto-${script.id}`.slice(0, 60),
				enabled: true,
				events: EVENTS,
				source: { type: "workersBuilds.worker", worker_name: script.id },
				destination: { type: "queues.queue", queue_id: queue.queue_id },
			}),
		});
		if (res.body?.success) {
			created++;
			console.log(`[auto-subscribe] Assinatura criada para ${script.id}`);
		} else {
			console.error(
				`[auto-subscribe] Falha ao assinar ${script.id} (HTTP ${res.status}): ${describe(res.body)}`,
			);
		}
	}

	console.log(
		`[auto-subscribe] ${accountId}: ${subscribed.size} já assinados, ${created} novos, ${budget.used} requisições.`,
	);
}

export async function syncSubscriptions(env: Env): Promise<void> {
	if (!env.CLOUDFLARE_API_TOKEN) {
		console.error("[auto-subscribe] CLOUDFLARE_API_TOKEN não configurado");
		return;
	}
	const budget = new Budget();
	try {
		for (const accountId of await getAccountIds(env, budget)) {
			await syncAccount(env, budget, accountId);
		}
	} catch (error) {
		console.error("[auto-subscribe] Erro:", error);
	}
}
