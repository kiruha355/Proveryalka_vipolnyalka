import { expect, it, vi } from "vitest";
import { createHttpModelVersionsPort } from "./http";
import { ORDER_BUG_SPEC } from "../fixtures/order-versions";

it("uses credentials for model version reads and sends the current CSRF token for writes", async () => {
  const onAuthError = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => init?.method === "POST"
    ? new Response(JSON.stringify({error: {code: "CSRF_INVALID", message: "Denied"}}), {status: 403})
    : new Response("[]"));
  const versions = createHttpModelVersionsPort({fetch: fetcher, getCsrfToken: () => "csrf", onAuthError});
  await expect(versions.listVersions("model")).resolves.toEqual([]);
  await expect(versions.createVersion("model", {spec: ORDER_BUG_SPEC, parent_id: "parent"}, "request"))
    .rejects.toMatchObject({code: "CSRF_INVALID", status: 403});
  expect(fetcher.mock.calls.map(([, init]) => init?.credentials)).toEqual(["include", "include"]);
  expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get("X-CSRF-Token")).toBe("csrf");
  expect(onAuthError).toHaveBeenCalledOnce();
});
