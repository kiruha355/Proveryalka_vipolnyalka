import {describe, expect, it, vi} from "vitest";
import {HttpApi, detectCapabilities} from "./http";
import {ApiError} from "./errors";

const run = {run_id:"r",session_id:"s",state:"queued",version_id:null,error_code:null};
const json = (body:unknown, status=200) => new Response(JSON.stringify(body), {status, headers:{"Content-Type":"application/json"}});

describe("public HTTP contract", () => {
  it("detects dialogue/documents/explanation from OpenAPI", () => {
    const caps = detectCapabilities({paths:{"/api/sessions":{},"/api/sessions/{session_id}/dialogue":{},"/api/sessions/{session_id}/documents":{},"/api/checks/{run_id}/explanation":{}}});
    expect(caps).toMatchObject({dialogue:true,documents:true,explanations:true});
  });
  it("detects and reads paginated safe agent trace history with stable entry links", async () => {
    const caps = detectCapabilities({paths:{"/api/sessions":{}, "/api/sessions/{session_id}/agent-runs":{}}});
    expect(caps.agentTrace).toBe(true);
    const item = {run, input_entry_id:"input", reply_entry_id:null, source_id:"source", created_at:null, started_at:null, finished_at:null,
      events:[{run_id:"r",session_id:"s",event_id:1,type:"activity",created_at:null,data:{phase:"queued"}}],events_truncated:false};
    const fetcher = vi.fn<typeof fetch>(async () => json({runs:[item],next_cursor:12}));
    const api = new HttpApi("",fetcher);
    expect((await api.listAgentRuns("s/1",25)).runs[0]?.input_entry_id).toBe("input");
    expect(fetcher.mock.calls[0]![0]).toBe("/api/sessions/s%2F1/agent-runs?limit=50&before=25");
    item.events[0]!.run_id = "foreign";
    await expect(api.listAgentRuns("s")).rejects.toBeInstanceOf(ApiError);
  });
  it("preserves addressed replies and source_id, uses distinct pending/explanation routes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(run)); const api=new HttpApi("/",fetcher);
    await api.sendMessage("s",{text:"Ответ",question_id:"q"},"k1");
    await api.sendMessage("s",{source_id:"document"},"k2");
    await api.retryPending("s","k3"); await api.retryExplanation("check","k4");
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({text:"Ответ",question_id:"q"});
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({source_id:"document"});
    expect(fetcher.mock.calls[2]![0]).toBe("/api/sessions/s/pending/retry");
    expect(fetcher.mock.calls[3]![0]).toBe("/api/checks/check/explanation");
    expect(fetcher.mock.calls.map(c=>new Headers(c[1]!.headers).get("Idempotency-Key"))).toEqual(["k1","k2","k3","k4"]);
  });
  it("checks all rules with explain:true and server defaults",async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>json(run));const api=new HttpApi("",fetcher);
    await api.createCheck("m",1,{property_ids:null,explain:true},"check-key");
    expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].body as string)).toEqual({property_ids:null,explain:true});
  });
  it("uploads multipart without auto analysis, retains source identity and metadata",async()=>{
    const file=new File(["Правило"],"rules.md");
    const fetcher=vi.fn<typeof fetch>(async()=>json({source:{id:"src",session_id:"s",kind:"text",text:"Правило"},document:{source_id:"src",filename:"rules.md",media_type:"text/markdown",size_bytes:14,characters:7}}));
    const api=new HttpApi("",fetcher);const result=await api.uploadDocument("s",file,"upload");
    expect(result).toMatchObject({id:"src",text:"Правило",filename:"rules.md",status:"extracted"});
    const options=(fetcher.mock.calls[0] as unknown as [string,RequestInit])[1];
    expect(options.body).toBeInstanceOf(FormData);expect(options.headers).not.toHaveProperty("Content-Type");expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([[415,"UNSUPPORTED_DOCUMENT"],[422,"DOCUMENT_ENCODING"],[413,"DOCUMENT_TOO_LARGE"]])("preserves document error %s",async(status,code)=>{
    const api=new HttpApi("",vi.fn<typeof fetch>(async()=>json({error:{code,message:"Invalid document"}},status)));
    await expect(api.uploadDocument("s",new File(["x"],"bad.txt"),"u")).rejects.toMatchObject({code,status});
  });
  it("rejects malformed public dialogue instead of treating it as empty",async()=>{
    const api=new HttpApi("",vi.fn<typeof fetch>(async()=>json({session_id:"s",status:"ready"})));
    await expect(api.getDialogue("s")).rejects.toBeInstanceOf(ApiError);
  });
  it("passes replay cursor and parses fragmented named SSE events",async()=>{
    const wire='event: message_delta\r\ndata: {"event_id":1,"run_id":"r","session_id":"s","type":"message_delta","data":{"text":"Да"}}\r\n\r\n';
    const bytes=new TextEncoder().encode(wire);const fetcher=vi.fn<typeof fetch>(async()=>new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,21));c.enqueue(bytes.slice(21));c.close();}}),{headers:{"content-type":"text/event-stream"}}));
    const api=new HttpApi("",fetcher);const events=[];for await(const e of api.streamEvents("r",7,new AbortController().signal)) events.push(e);
    expect(events[0]?.data.text).toBe("Да");expect((fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].headers).toMatchObject({"Last-Event-ID":"7"});
  });
});

it("sends file identity as typed context, never as a business source",async()=>{
 const fetcher=vi.fn<typeof fetch>(async()=>json(run));const api=new HttpApi("",fetcher);
 const ref={generation_id:"gen",version_id:"old-version",path:"app/rules.py",sha256:"a".repeat(64)};
 await api.sendMessage("s",{text:"Объясни файл",file_context:ref},"file-key");
 const body=JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
 expect(body).toEqual({text:"Объясни файл",file_context:ref});expect(body).not.toHaveProperty("source_id");
});

it("shared OpenAPI discovery survives the first StrictMode consumer abort",async()=>{
 let resolve!:(r:Response)=>void;const fetcher=vi.fn<typeof fetch>(()=>new Promise(r=>{resolve=r;}));const api=new HttpApi("",fetcher);
 const first=new AbortController();const one=api.capabilities(first.signal);first.abort();
 const two=api.capabilities(new AbortController().signal);
 resolve(json({paths:{"/api/sessions":{},"/api/sessions/{session_id}/messages":{}},components:{schemas:{}}}));
 expect((await two).agent).toBe(true);expect(await one).toEqual(await two);
 expect(fetcher.mock.calls[0]![1]?.signal).toBeUndefined();
});

it.each([
  ["REST", 401, "AUTH_REQUIRED"],
  ["SSE", 401, "AUTH_REQUIRED"],
  ["download", 403, "CSRF_INVALID"],
] as const)("reports %s authentication failures through the same transport", async (route, status, code) => {
  const missing = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async () => json({ error: { code, message: code } }, status));
  const api = new HttpApi("", fetcher, { ownerId: "u", csrfToken: "secret", onAuthError: missing });
  const signal = new AbortController().signal;
  const operation = route === "REST" ? api.cancelRun("r") : route === "SSE" ? api.streamEvents("r", 1, signal)[Symbol.asyncIterator]().next()
    : api.downloadArtifact("r", "folder/file.log");
  await expect(operation).rejects.toMatchObject({ status, code });
  expect(missing).toHaveBeenCalledOnce();
  const init = fetcher.mock.calls[0]![1]!;
  expect(init.credentials).toBe("include");
  expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("secret");
  await expect(api.listSessions()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  expect(fetcher).toHaveBeenCalledOnce();
});

it("keeps a resource-level 403 distinct from an invalid CSRF token", async () => {
  const missing = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async () => json({ error: { code: "FORBIDDEN", message: "Forbidden" } }, 403));
  const api = new HttpApi("", fetcher, { ownerId: "u", csrfToken: "secret", onAuthError: missing });
  await expect(api.listSessions()).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  expect(missing).not.toHaveBeenCalled();
});

it.each(["sessions", "SSE"] as const)("uses the tab's token for %s after another tab changes the browser cookie", async (route) => {
  const bobSession = { id: "bob-session", title: "Bob", mode: "analyzer", created_at: "2026-11-21" };
  const bobEvent = {
    event_id: 2, run_id: "bob-run", session_id: bobSession.id, type: "message_delta", data: { text: "Bob" },
  };
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    // The cookie now belongs to Bob. Headerless reads would be authorized as Bob.
    const csrf = new Headers(init?.headers).get("X-CSRF-Token");
    if (csrf !== null && csrf !== "bob-token") return json({ error: { code: "AUTH_REQUIRED", message: "Browser session changed" } }, 401);
    return route === "sessions"
      ? json([bobSession])
      : new Response(`data: ${JSON.stringify(bobEvent)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  const reauthenticate = vi.fn();
  const read = (api: HttpApi) => route === "sessions" ? api.listSessions()
    : api.streamEvents("bob-run", 1, new AbortController().signal)[Symbol.asyncIterator]().next();
  const aliceApi = new HttpApi("", fetcher, { ownerId: "alice", csrfToken: "alice-token", onAuthError: reauthenticate });
  const bobApi = new HttpApi("", fetcher, { ownerId: "bob", csrfToken: "bob-token", onAuthError: vi.fn() });
  await expect(read(aliceApi)).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
  await expect(read(bobApi)).resolves.toEqual(route === "sessions" ? [bobSession] : { value: bobEvent, done: false });
  expect(reauthenticate).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET"]);
  if (route === "SSE") expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Last-Event-ID")).toBe("1");
});
