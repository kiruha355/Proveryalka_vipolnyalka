import { expect, it, vi } from "vitest";
import { HttpApi } from "./http";

const remote = "https://gitlab.com/group/private";
const connection = { id: "c/1", remote_url: remote, expires_at: 2_000_000_000, state: "active", last_checked_at: null, last_error: null };

it("sends cookie and CSRF for repository and connection writes and token only in creation body", async () => {
  const snapshot = { id: "snap", session_id: "s/1", remote_url: remote, commit_sha: "x", manifest_sha256: "y",
    parent_snapshot_id: null, files: [], excluded: {}, created_at: "2026-11-01" };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === "/openapi.json") return Response.json({ paths: {
      "/api/sessions": {}, "/api/auth/me": {}, "/api/connections": {}, "/api/sessions/{session_id}/repositories": {},
    } });
    if (url === "/api/connections" && init?.method === "POST") return Response.json(connection);
    if (url.endsWith("/check")) return Response.json({ accessible: true, connection });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url.includes("/files/content")) return Response.json({ path: "src/код + x.py", start_line: 2, total_lines: 4, lines: ["return\n"], commit_sha: "x", sha256: "hash" });
    return Response.json(snapshot);
  });
  const api = new HttpApi("", fetcher, { ownerId: "fixture-owner", csrfToken: "csrf", onAuthError: vi.fn() });
  expect(await api.capabilities()).toMatchObject({ repositories: true, gitConnections: true });
  const token = "fixture-only-token";
  await api.gitConnections.create({ remote_url: remote, token, expires_at: connection.expires_at });
  await api.gitConnections.check(connection.id);
  await api.gitConnections.revoke(connection.id);
  await api.repositories.import("s/1", { remote_url: remote, ref: "main", credential_ref: connection.id }, "snapshot-key");
  const file = await api.repositories.content("s/1", "snap", "src/код + x.py", 2, 2);
  expect(file.lines).toEqual(["return\n"]);
  expect(fetcher.mock.calls.every(([, init]) => init?.credentials === "include")).toBe(true);
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method !== "GET");
  expect(writes.map(([url, init]) => [url, init?.method])).toEqual([
    ["/api/connections", "POST"], ["/api/connections/c%2F1/check", "POST"], ["/api/connections/c%2F1", "DELETE"],
    ["/api/sessions/s%2F1/repositories", "POST"],
  ]);
  expect(writes.every(([, init]) => new Headers(init?.headers).get("X-CSRF-Token") === "csrf")).toBe(true);
  expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({ remote_url: remote, token, expires_at: connection.expires_at });
  expect(JSON.parse(String(writes[3]?.[1]?.body))).toEqual({ remote_url: remote, ref: "main", credential_ref: connection.id });
  expect(new Headers(writes[3]?.[1]?.headers).get("Idempotency-Key")).toBe("snapshot-key");
  const path = new URL(String(fetcher.mock.lastCall?.[0]), "https://local.test");
  expect(path.searchParams.get("path")).toBe("src/код + x.py");
  expect(JSON.stringify(writes.slice(1))).not.toContain(token);
});
