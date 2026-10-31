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
