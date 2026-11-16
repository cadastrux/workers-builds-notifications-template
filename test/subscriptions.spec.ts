import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { syncSubscriptions } from "../src/subscriptions";
import type { Env } from "../src/types";

const ACC = "acc123";
const QID = "queue-1";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("syncSubscriptions (auto-subscribe)", () => {
	const originalFetch = globalThis.fetch;
	let calls: { url: string; method: string; body?: any }[];

	beforeEach(() => {
		calls = [];
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";
			calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
			const path = url.replace("https://api.cloudflare.com/client/v4", "");

			if (path.startsWith("/accounts?")) return json({ success: true, result: [{ id: ACC }] });
			if (path.startsWith(`/accounts/${ACC}/queues`))
				return json({ success: true, result: [{ queue_id: QID, queue_name: "builds-event-subscriptions" }] });
			if (path.startsWith(`/accounts/${ACC}/event_subscriptions/subscriptions`) && method === "GET")
				return json({
					success: true,
					result: [
						{ id: "s1", events: ["build.failed"], source: { type: "workersBuilds.worker", worker_name: "site-ja-assinado" }, destination: { queue_id: QID } },
						{ source: { type: "workersBuilds.worker", worker_name: "site-outra-fila" }, destination: { queue_id: "outra" } },
					],
					result_info: { page: 1, total_pages: 1 },
				});
			if (path === `/accounts/${ACC}/workers/scripts`)
				return json({
					success: true,
					result: [
						{ id: "site-ja-assinado", tag: "t1" },
						{ id: "site-novo", tag: "t2" },
						{ id: "worker-sem-git", tag: "t3" },
						{ id: "site-outra-fila", tag: "t4" },
					],
				});
			if (path.startsWith(`/accounts/${ACC}/builds/workers/`)) {
				const tag = path.split("/").pop();
				return tag === "t3"
					? json({ success: false, errors: [{ code: 404, message: "not found" }] }, 404)
					: json({ success: true, result: {} });
			}
			if (path.startsWith(`/accounts/${ACC}/event_subscriptions/subscriptions/`) && method === "PATCH")
				return json({ success: true, result: {} });
			if (path === `/accounts/${ACC}/event_subscriptions/subscriptions` && method === "POST")
				return json({ success: true, result: { id: "new" } });
			return json({ success: false }, 500);
		};
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("cria assinatura só para Workers com builds que ainda não têm", async () => {
		await syncSubscriptions({ SLACK_WEBHOOK_URL: "x", CLOUDFLARE_API_TOKEN: "tok" } as Env);

		const posts = calls.filter((c) => c.method === "POST");
		const names = posts.map((p) => p.body.source.worker_name).sort();
		expect(names).toEqual(["site-novo", "site-outra-fila"]);
		expect(posts[0].body).toMatchObject({
			enabled: true,
			events: ["build.failed", "build.succeeded"],
			source: { type: "workersBuilds.worker" },
			destination: { type: "queues.queue", queue_id: QID },
		});
		// assinatura antiga (só build.failed) ganha build.succeeded
		const patch = calls.filter((c) => c.method === "PATCH");
		expect(patch).toHaveLength(1);
		expect(patch[0].url).toContain("/event_subscriptions/subscriptions/s1");
		expect(patch[0].body.events).toEqual(["build.failed", "build.succeeded"]);
		// não consulta build de quem já está assinado
		expect(calls.some((c) => c.url.endsWith("/builds/workers/t1"))).toBe(false);
	});

	it("usa ACCOUNT_ID quando configurado, sem listar contas", async () => {
		await syncSubscriptions({ SLACK_WEBHOOK_URL: "x", CLOUDFLARE_API_TOKEN: "tok", ACCOUNT_ID: ACC } as Env);
		expect(calls.some((c) => c.url.includes("/accounts?"))).toBe(false);
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
	});

	it("não faz nada se a fila não existir", async () => {
		const base = globalThis.fetch;
		globalThis.fetch = async (input, init) =>
			input.toString().includes("/queues") ? json({ success: true, result: [] }) : base(input, init);
		await syncSubscriptions({ SLACK_WEBHOOK_URL: "x", CLOUDFLARE_API_TOKEN: "tok", ACCOUNT_ID: ACC } as Env);
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
	});
});
