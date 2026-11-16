import { env, createMessageBatch } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../src/index";
import type { CloudflareEvent, Env } from "../src/types";

const DISCORD = "https://discord.com/api/webhooks/1/abc/slack";

function event(type: "failed" | "succeeded"): CloudflareEvent {
	return {
		type: `cf.workersBuilds.worker.build.${type}`,
		source: { type: "workersBuilds.worker", workerName: "meu-site" },
		payload: {
			buildUuid: "b-1",
			status: "stopped",
			buildOutcome: type === "failed" ? "failure" : "success",
			createdAt: "2026-11-16T18:00:00Z",
		},
		metadata: { accountId: "acc", eventSubscriptionId: "s", eventSchemaVersion: 1, eventTimestamp: "" },
	};
}

function batch(e: CloudflareEvent) {
	return createMessageBatch("builds-event-subscriptions", [
		{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: e },
	]);
}

describe("Workers Builds: apagar aviso quando a build passa", () => {
	const originalFetch = globalThis.fetch;
	let calls: { url: string; method: string }[];

	beforeEach(() => {
		calls = [];
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";
			calls.push({ url, method });
			if (url.startsWith("https://discord.com/"))
				return method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ id: "m-42" });
			if (url.includes("/logs")) return Response.json({ result: { lines: [[0, "[ERROR] boom"]] } });
			return new Response("Not found", { status: 404 });
		};
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("falha envia e guarda; sucesso apaga e não envia mensagem", async () => {
		const testEnv = { ...(env as unknown as Env), SLACK_WEBHOOK_URL: DISCORD, NOTIFY_SUCCESS: undefined } as Env;
		const kv = testEnv.STATE!;

		await worker.queue(batch(event("failed")), testEnv);
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
		expect(await kv.get("msg:worker:acc:meu-site")).toBe("m-42");

		calls = [];
		await worker.queue(batch(event("succeeded")), testEnv);
		expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
		const del = calls.filter((c) => c.method === "DELETE");
		expect(del.map((c) => c.url)).toEqual(["https://discord.com/api/webhooks/1/abc/messages/m-42"]);
		expect(await kv.get("msg:worker:acc:meu-site")).toBeNull();
	});
});
