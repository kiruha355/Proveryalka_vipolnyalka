import {act, renderHook, waitFor, render, screen, fireEvent} from "@testing-library/react";
import {expect,it,vi} from "vitest";
import {DemoApi} from "../api/demo";
import type {ProveryalkaApi} from "../api/api";
import {ApiError} from "../api/errors";
import {DEFAULT_LIMITS, type DialogueView, type Run, type RunEvent} from "../api/types";
import {useSessionWorkspace} from "./useSessionWorkspace";
import {loadLocal, updateLocal} from "./persist";
import {App} from "../App";
import {registerCoreViews} from "../app/coreViews";
import {resetExtensions, registerWorkspaceView} from "../app/extensions";

const sid="demo_s_order";
const caps={adapter:"http" as const,agent:true,questionId:true,customLimits:true,artifacts:false,checkDiscovery:false,documents:true,dialogue:true,explanations:true};
const empty=():DialogueView=>({session_id:sid,status:"not_started",round:null,max_rounds:null,reply:null,requirements:[],questions:[],open_question_ids:[],corrections:[],analysis:null,model:null,pending:null,entries:[]});
const event=(run:string,type:RunEvent["type"],id=1):RunEvent=>({run_id:run,session_id:sid,event_id:id,type,data:{state:"completed"}});
function fake(){
  const api:ProveryalkaApi=new DemoApi();
  api.getDialogue=vi.fn(async()=>empty());
  api.getRun=vi.fn<ProveryalkaApi["getRun"]>(async id=>({run_id:id,session_id:sid,state:"completed",version_id:null,error_code:null}));
  api.streamEvents=async function*(id){yield event(id,"run_finished");};
  return api;
}

it("double send is one request, network retry reuses the key and addressed question",async()=>{
  const api=fake();let resolve!:(r:Run)=>void;
  const send=vi.fn<ProveryalkaApi["sendMessage"]>().mockRejectedValueOnce(new ApiError("network","Lost response")).mockImplementation(()=>new Promise(r=>{resolve=r;}));
  api.sendMessage=send;
  const {result}=renderHook(()=>useSessionWorkspace({api,capabilities:caps,sessionId:sid}));
  await waitFor(()=>expect(result.current.detail.loading).toBe(false));
  await act(async()=>{expect(await result.current.sendMessage("Ответ","q")).toBe(false);});
  const key=send.mock.calls[0]![2];expect(loadLocal(api.id,sid).outbox?.key).toBe(key);
  let request!:Promise<boolean>;
  act(()=>{request=result.current.retryOutbox();});
  await act(async()=>{expect(await result.current.sendMessage("Ответ","q")).toBe(false);});
  expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[1]![2]).toBe(key);expect(send.mock.calls[1]![1]).toEqual({text:"Ответ",question_id:"q"});
  await act(async()=>{resolve({run_id:"agent",session_id:sid,state:"completed",version_id:null,error_code:null});await request;});
  expect(loadLocal(api.id,sid).outbox).toBeNull();
});

it("invalid upload preserves draft; successful upload waits for explicit source analysis",async()=>{
  const api=fake();updateLocal(api.id,sid,s=>({...s,draft:"Не потерять"}));
  const send=vi.fn<ProveryalkaApi["sendMessage"]>(async()=>({run_id:"a",session_id:sid,state:"completed",version_id:null,error_code:null}));api.sendMessage=send;
  const upload=vi.fn<NonNullable<ProveryalkaApi["uploadDocument"]>>().mockRejectedValueOnce(new ApiError("http","Encoding",{status:422,code:"DOCUMENT_ENCODING"})).mockResolvedValue({id:"src",session_id:sid,filename:"rules.txt",media_type:"text/plain",size:10,status:"extracted",text:"Правила",error:null});api.uploadDocument=upload;
  const {result}=renderHook(()=>useSessionWorkspace({api,capabilities:caps,sessionId:sid}));await waitFor(()=>expect(result.current.detail.loading).toBe(false));
  await act(async()=>{await result.current.uploadDocument(new File(["bad"],"bad.txt"));});
  expect(loadLocal(api.id,sid).draft).toBe("Не потерять");expect(result.current.upload.error).toBeInstanceOf(ApiError);
  let document:Awaited<ReturnType<typeof result.current.uploadDocument>>=null;
  await act(async()=>{document=await result.current.uploadDocument(new File(["Правила"],"rules.txt"));});
  expect(send).not.toHaveBeenCalled();
  await act(async()=>{await result.current.analyzeDocument(document!);});
  expect(send.mock.calls[0]![1]).toEqual({source_id:"src"});
});

it("keeps technical results while explanation runs after check run_finished; retry never checks again",async()=>{
  const api=fake();const version=(await api.listVersions("demo_m_order"))[0]!;
  const report=await api.getCheck((await (api as DemoApi).listCheckRuns(version.id))[0]!);
  const checkRun:Run={...report.run,run_id:"check"};
  const create=vi.fn<ProveryalkaApi["createCheck"]>(async()=>({...checkRun,state:"queued"}));api.createCheck=create;
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let ready=false;
  const narrative={summary:"Объяснение",question:null,properties:report.results.map(r=>({property_id:r.property_id,explanation:"Из отчёта",steps:[],hypotheses:[]}))};
  api.getCheck=vi.fn(async()=>({...report,run:checkRun,explanation:{state:ready?"ready" as const:"running" as const,run_id:"explain",error_code:null,narrative:ready?narrative:null}}));
  api.streamEvents=async function*(id){if(id==="explain"){await gate;ready=true;}yield event(id,"run_finished");};
  const retry=vi.fn<NonNullable<ProveryalkaApi["retryExplanation"]>>(async()=>({run_id:"explain-retry",session_id:sid,state:"queued",version_id:version.id,error_code:null}));api.retryExplanation=retry;
  const {result}=renderHook(()=>useSessionWorkspace({api,capabilities:caps,sessionId:sid}));await waitFor(()=>expect(result.current.versions.length).toBeGreaterThan(0));
  await act(async()=>{await result.current.startCheck(version,null,DEFAULT_LIMITS);});
  await waitFor(()=>expect(result.current.checks[0]?.results?.length).toBeGreaterThan(0));
  expect(result.current.checks[0]?.explanation?.state).toBe("running");
  expect(create.mock.calls[0]![2]).toEqual({property_ids:null,explain:true});
  await act(async()=>{release();});await waitFor(()=>expect(result.current.checks[0]?.explanation?.state).toBe("ready"));
  await act(async()=>{await result.current.retryExplanation("check");});expect(retry).toHaveBeenCalledTimes(1);expect(create).toHaveBeenCalledTimes(1);
});

it("pending retry and discard use explicit endpoints",async()=>{
  const api=fake();const view=empty();view.pending={source_id:"src",text:"Pending",question_id:"q",run_id:"old",run_state:"failed"};api.getDialogue=vi.fn(async()=>view);
  const retry=vi.fn<NonNullable<ProveryalkaApi["retryPending"]>>(async()=>({run_id:"retry",session_id:sid,state:"completed",version_id:null,error_code:null}));api.retryPending=retry;
  const discard=vi.fn<NonNullable<ProveryalkaApi["discardPending"]>>(async()=>empty());api.discardPending=discard;
  api.sendMessage=vi.fn();const {result}=renderHook(()=>useSessionWorkspace({api,capabilities:caps,sessionId:sid}));
  await waitFor(()=>expect(result.current.history?.pending?.text).toBe("Pending"));
  await act(async()=>{await result.current.retryPending();});expect(retry).toHaveBeenCalledOnce();expect(api.sendMessage).not.toHaveBeenCalled();
  await act(async()=>{await result.current.discardPending();});expect(discard).toHaveBeenCalledOnce();
});

it("demo shows recorded initial user text and keeps tabs and inspector selection coherent",async()=>{
  resetExtensions();registerCoreViews();window.location.hash="/s/demo_s_order?m=demo_m_order&v=1&view=model";
  const api=new DemoApi();const text=(await api.getSession(sid)).sources[0]!.text;
  render(<App initialApi={api}/>);
  await screen.findByText((_,el)=>el?.matches(".msg__text") === true && el.textContent === text);
  await screen.findByRole("tab",{name:"Модель"});
  fireEvent.click(screen.getByRole("tab",{name:"Требования"}));expect(screen.getByRole("tab",{name:"Требования"})).toHaveAttribute("aria-selected","true");
  fireEvent.click(screen.getByRole("tab",{name:"Модель"}));fireEvent.click(screen.getByRole("tab",{name:"Проверка"}));
  expect(screen.getByRole("tab",{name:"Проверка"})).toHaveAttribute("aria-selected","true");
  expect(screen.queryByRole("spinbutton")).toBeNull();expect(screen.queryByRole("checkbox")).toBeNull();
});

it("late response from previous adapter cannot replace current session list",async()=>{
  let resolve!:(r:Awaited<ReturnType<ProveryalkaApi["listSessions"]>>)=>void;
  const old=new DemoApi();old.listSessions=()=>new Promise(r=>{resolve=r;});const next=new DemoApi();
  const {rerender}=render(<App initialApi={old}/>);rerender(<App initialApi={next}/>);
  await screen.findByText("Заявка: отмена и исполнение");
  await act(async()=>resolve([{id:"foreign",title:"Устаревшая сессия",mode:"analyzer",created_at:"2026-10-31"}]));
  expect(screen.queryByText("Устаревшая сессия")).toBeNull();
});


it("host createVersion posts, refreshes and selects new immutable version",async()=>{
  resetExtensions();registerCoreViews();
  const api=fake();api.capabilities=async()=>caps;
  const original=(await api.listVersions("demo_m_order"))[1]!;
  const created={...structuredClone(original),id:"new-version",number:3,parent_id:original.id,approved:false};
  const list=api.listVersions.bind(api);let persisted=false;
  api.createVersion=vi.fn(async()=>{persisted=true;return created;});
  api.listVersions=async id=>{const versions=await list(id);return persisted && id===original.model_id?[...versions,created]:versions;};
  let context:import("../app/workspace").WorkspaceContextValue|null=null;
  registerWorkspaceView({id:"probe",label:"Probe",component:props=>{context=props.context;return <p>host bridge</p>;}});
  window.location.hash="/s/demo_s_order?m=demo_m_order&v=2&view=probe";
  render(<App initialApi={api}/>);await screen.findByText("host bridge");
  await act(async()=>{await context!.createVersion!(original.model_id,{spec:created.spec,parent_id:original.id},"version-key");});
  await waitFor(()=>expect(context!.version?.id).toBe("new-version"));
  expect(context!.version?.approved).toBe(false);expect(context!.versions.find(v=>v.id===original.id)).toEqual(original);
  expect(api.createVersion).toHaveBeenCalledWith(original.model_id,{spec:created.spec,parent_id:original.id},"version-key",expect.any(AbortSignal));
});


it("late check acceptance after session unmount cannot navigate back or persist into current session",async()=>{
 const api=fake();const version=(await api.listVersions("demo_m_order"))[0]!;let resolve!:(run:Run)=>void;
 api.createCheck=()=>new Promise(r=>{resolve=r;});
 const {result,unmount}=renderHook(()=>useSessionWorkspace({api,capabilities:caps,sessionId:sid}));
 await waitFor(()=>expect(result.current.versions.length).toBeGreaterThan(0));
 let request!:Promise<string|null>;act(()=>{request=result.current.startCheck(version,null,DEFAULT_LIMITS);});
 unmount();resolve({run_id:"late",session_id:sid,state:"queued",version_id:version.id,error_code:null});
 expect(await request).toBeNull();expect(loadLocal(api.id,sid).checkRuns).toHaveLength(0);
});

it("file context survives an indeterminate send and retries with the same key",async()=>{
 const api=fake();const ref={generation_id:"g",version_id:"v-old",path:"app/rules.py",sha256:"b".repeat(64),version_number:1};
 const send=vi.fn<ProveryalkaApi["sendMessage"]>().mockRejectedValueOnce(new ApiError("network","Lost response")).mockResolvedValue({run_id:"file-run",session_id:sid,state:"completed",version_id:"v-old",error_code:null});api.sendMessage=send;
 const {result}=renderHook(()=>useSessionWorkspace({api,capabilities:{...caps,fileDialogue:true},sessionId:sid}));
 await waitFor(()=>expect(result.current.detail.loading).toBe(false));
 await act(async()=>{await result.current.sendMessage("Объясни файл",null,ref);});
 expect(loadLocal(api.id,sid).outbox?.fileContext).toEqual(ref);
 await act(async()=>{await result.current.retryOutbox();});
 expect(send.mock.calls[1]![2]).toBe(send.mock.calls[0]![2]);
 expect(send.mock.calls[1]![1]).toEqual({text:"Объясни файл",file_context:{generation_id:"g",version_id:"v-old",path:"app/rules.py",sha256:"b".repeat(64)}});
});
