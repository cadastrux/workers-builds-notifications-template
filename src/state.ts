/**
 * Guarda o id da mensagem de falha enviada ao Discord (Workers KV, binding STATE)
 * para apagá-la quando o mesmo site voltar a ter build com sucesso.
 *
 * Chave: msg:<pages|worker>:<accountId>:<nome>  →  valor = id da mensagem
 * Metadata: { messageId, environment? }  (permite listar sem ler cada valor)
 */

import type { Env } from "./types";
import { deleteWebhookMessage } from "./slack";

export type Kind = "pages" | "worker";

export interface PendingMeta {
	messageId: string;
	environment?: string;
}

export function pendingKey(kind: Kind, accountId: string, name: string): string {
	return `msg:${kind}:${accountId}:${name}`;
}

/** Lista as falhas pendentes (ainda com mensagem no Discord) de uma conta. */
export async function listPending(env: Env, kind: Kind, accountId: string): Promise<Map<string, PendingMeta>> {
	const out = new Map<string, PendingMeta>();
	if (!env.STATE) return out;
	let cursor: string | undefined;
	do {
		const page = await env.STATE.list<PendingMeta>({ prefix: `msg:${kind}:${accountId}:`, cursor });
		for (const k of page.keys) {
			if (k.metadata?.messageId) out.set(k.name, k.metadata);
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return out;
}

/**
 * Apaga do Discord a mensagem pendente (se houver) e remove do KV.
 * Retorna true se havia mensagem pendente.
 */
export async function resolvePending(env: Env, key: string, knownMessageId?: string): Promise<boolean> {
	if (!env.STATE) return false;
	const messageId = knownMessageId ?? (await env.STATE.get(key));
	if (!messageId) return false;
	const deleted = await deleteWebhookMessage(env.SLACK_WEBHOOK_URL, messageId);
	if (deleted) await env.STATE.delete(key);
	return deleted;
}

/**
 * Guarda a mensagem de uma nova falha. Se já havia uma falha anterior
 * do mesmo site, a mensagem antiga é apagada (fica só a mais recente).
 */
export async function rememberFailure(
	env: Env,
	key: string,
	messageId: string | null,
	environment?: string,
): Promise<void> {
	if (!env.STATE || !messageId) return;
	await resolvePending(env, key);
	const meta: PendingMeta = { messageId, ...(environment ? { environment } : {}) };
	await env.STATE.put(key, messageId, { metadata: meta });
}
