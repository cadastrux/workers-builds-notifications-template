import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkPagesFailures, failedInWindow } from "../src/pages";
import { Budget } from "../src/subscriptions";
import { toDiscordPayload } from "../src/slack";
import type { Env } from "../src/types";

const ACC = "acc123";
const T = Date.parse("2026-11-16T18:55:00Z");
const WIN = 5 * 60 * 1000;
const DISCORD = "https://discord.com/api/webhooks/1/abc/slack";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function dep(id: string, status: string, endedIso: string | null) {
	return {
		id,
		latest_stage: { name: "build", status, ended_on: endedIso },
		deployment_trigger: { metadata: { branch: "main", commit_hash: "03cd820abc", commit_message: "feat: adiciona notícia" } },
	};
}

describe("failedInWindow", () => {
	it("só considera falhas dentro de (inicio, fim]", () => {
		expect(failedInWindow(dep("a", "failure", "2026-11-16T18:52:00Z"), T - WIN, T)).toBe(true);
		expect(failedInWindow(dep("a", "failure", "2026-11-16T18:50:00Z"), T - WIN, T)).toBe(false);
		expect(failedInWindow(dep("a", "failure", "2026-11-16T18:55:00Z"), T - WIN, T)).toBe(true);
		expect(failedInWindow(dep("a", "success", "2026-11-16T18:52:00Z"), T - WIN, T)).toBe(false);
		expect(failedInWindow(dep("a", "failure", null), T - WIN, T)).toBe(false);
		expect(failedInWindow(null, T - WIN, T)).toBe(false);
	});
});

describe("checkPagesFailures", () => {
	const originalFetch = globalThis.fetch;
	let calls: { url: string; method: string; body?: any }[];

	beforeEach(() => {
		calls = [];
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";
			calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
			if (url.startsWith("https://discord.com/"))
				return method === "DELETE" ? new Response(null, { status: 204 }) : json({ id: "msg-" + calls.length });
			if (url.includes("/history/logs"))
				return json({
					success: true,
					result: { data: [{ line: "Building...", ts: "" }, { line: "[ERROR] Unexpected token {% blank", ts: "" }] },
				});
			if (url.includes("/pages/projects?"))
				return json({
					success: true,
					result: [
						{ name: "maraba-agenda", latest_deployment: dep("d1", "failure", "2026-11-16T18:52:00Z") },
						{ name: "falha-antiga", latest_deployment: dep("d2", "failure", "2026-11-16T18:40:00Z") },
						{ name: "ok", latest_deployment: dep("d3", "success", "2026-11-16T18:53:00Z") },
						{ name: "sem-deploy", latest_deployment: null },
					],
					result_info: { page: 1, total_pages: 1 },
				});
			return json({ success: false }, 500);
		};
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("avisa só a falha nova, no formato do Discord, com o erro do log", async () => {
		const env = { SLACK_WEBHOOK_URL: DISCORD, CLOUDFLARE_API_TOKEN: "tok" } as Env;
		await checkPagesFailures(env, new Budget(), [ACC], T - WIN, T);

		const sent = calls.filter((c) => c.url.startsWith("https://discord.com/") && c.method === "POST");
		expect(sent).toHaveLength(1);
		expect(sent[0].url).toBe("https://discord.com/api/webhooks/1/abc?wait=true"); // sem /slack
		const content: string = sent[0].body.content;
		expect(content).toContain("**maraba-agenda**");
		expect(content).toContain("Unexpected token {% blank");
		expect(content).toContain(`/${ACC}/pages/view/maraba-agenda/d1`);
		expect(content).toContain("`main`");
		expect(calls.some((c) => c.url.includes("/d2/"))).toBe(false);
	});
});

function memoryKV() {
	const store = new Map<string, { value: string; metadata?: unknown }>();
	return {
		store,
		async get(k: string) {
			return store.get(k)?.value ?? null;
		},
		async put(k: string, value: string, opts?: { metadata?: unknown }) {
			store.set(k, { value, metadata: opts?.metadata });
		},
		async delete(k: string) {
			store.delete(k);
		},
		async list({ prefix }: { prefix: string }) {
			return {
				keys: [...store].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })),
				list_complete: true,
			};
		},
	};
}

describe("checkPagesFailures + apagar mensagem", () => {
	const originalFetch = globalThis.fetch;
	let calls: { url: string; method: string }[];
	let latest: any;

	beforeEach(() => {
		calls = [];
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";
			calls.push({ url, method });
			if (url.startsWith("https://discord.com/"))
				return method === "DELETE" ? new Response(null, { status: 204 }) : json({ id: "msg-1" });
			if (url.includes("/history/logs")) return json({ success: true, result: { data: [] } });
			if (url.includes("/pages/projects?"))
				return json({ success: true, result: [{ name: "maraba-agenda", latest_deployment: latest }] });
			return json({ success: false }, 500);
		};
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("guarda o id na falha e apaga a mensagem quando a build passa", async () => {
		const kv = memoryKV();
		const env = { SLACK_WEBHOOK_URL: DISCORD, CLOUDFLARE_API_TOKEN: "tok", STATE: kv } as unknown as Env;

		latest = { ...dep("d1", "failure", "2026-11-16T18:52:00Z"), environment: "production" };
		await checkPagesFailures(env, new Budget(), [ACC], T - WIN, T);
		expect(kv.store.get(`msg:pages:${ACC}:maraba-agenda`)?.value).toBe("msg-1");

		// próxima execução: build corrigida
		latest = {
			id: "d2",
			environment: "production",
			latest_stage: { name: "deploy", status: "success", ended_on: "2026-11-16T18:58:00Z" },
		};
		await checkPagesFailures(env, new Budget(), [ACC], T, T + WIN);
		const del = calls.filter((c) => c.method === "DELETE");
		expect(del).toHaveLength(1);
		expect(del[0].url).toBe("https://discord.com/api/webhooks/1/abc/messages/msg-1");
		expect(kv.store.size).toBe(0);
	});

	it("não apaga com sucesso de preview se a falha foi em produção", async () => {
		const kv = memoryKV();
		await kv.put(`msg:pages:${ACC}:maraba-agenda`, "msg-9", { metadata: { messageId: "msg-9", environment: "production" } });
		const env = { SLACK_WEBHOOK_URL: DISCORD, CLOUDFLARE_API_TOKEN: "tok", STATE: kv } as unknown as Env;
		latest = { id: "d3", environment: "preview", latest_stage: { name: "deploy", status: "success", ended_on: "2026-11-16T18:58:00Z" } };
		await checkPagesFailures(env, new Budget(), [ACC], T, T + WIN);
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
		expect(kv.store.size).toBe(1);
	});
});

describe("toDiscordPayload", () => {
	it("converte negrito e links do Slack", () => {
		const out = toDiscordPayload({
			blocks: [
				{ type: "section", text: { type: "mrkdwn", text: "❌  *Build Failed*\n*site*" } },
				{ type: "context", elements: [{ type: "mrkdwn", text: "*Commit:* <https://x/c|abc1234>" }] },
				{ type: "section", text: { type: "mrkdwn", text: "```erro *aqui*```" } },
			],
		});
		expect(out.content).toContain("**Build Failed**");
		expect(out.content).toContain("**Commit:** [abc1234](https://x/c)");
	});
});
