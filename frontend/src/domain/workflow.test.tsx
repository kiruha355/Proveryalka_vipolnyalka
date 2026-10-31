import {expect, it, vi} from "vitest";
import {render, screen, fireEvent, waitFor} from "@testing-library/react";
import {DemoApi} from "../api/demo";
import {VERIFICATION_STATUSES, type DialogueView, type RunEvent} from "../api/types";
import {statusInfo, traceRole} from "./status";
import {buildSteps, focusIndex} from "./trace";
import {boundResults} from "../components/views/CheckView";
import {ResultDetail, findNarrative} from "../components/check/ResultDetail";
import {CheckLauncher} from "../components/workspace/CheckLauncher";
import {PaneSeparator, usePaneWidth} from "../components/PaneSeparator";
import {publicHistory} from "./dialogue";
import {highlightSpans, refMatches} from "./requirements";
import {RunTracker} from "../state/runTracker";
import {HttpApi} from "../api/http";

it.each(VERIFICATION_STATUSES)("keeps %s conclusive semantics",status=>{
  expect(statusInfo(status).conclusive).toBe(["PROPERTY_HOLDS","PROPERTY_VIOLATED"].includes(status));
});

it("initial violation and reachable witness keep exact values; nullable statistics remain null",async()=>{
  const api=new DemoApi();const versions=await api.listVersions("demo_m_order");const version=versions[0]!;
  const check=await api.getCheck((await api.listCheckRuns(version.id))[0]!);const result=check.results[0]!;
  const property=version.spec.properties.find(p=>p.id===result.property_id)!;
  const initial={...result,trace:result.trace.slice(0,1)};
  const initialProperty={...property,predicate:{kind:"literal" as const,value:true}};
  const steps=buildSteps(initial,version.spec,initialProperty);
  expect(steps).toHaveLength(1);expect(steps[0]?.state).toEqual(initial.trace[0]?.state);
  expect(steps[0]?.predicate).toBe(true);
  expect(focusIndex(steps,initialProperty,"counterexample")).toBe(0);
  expect(traceRole({...result,status:"PROPERTY_HOLDS"},"reachable")).toBe("witness");
  const unknown={...result,statistics:{states_generated:null,distinct_states:null,depth:null,elapsed_seconds:null}};
  render(<ResultDetail version={version} result={unknown} focus={null} requirements={null} narrative={null} onStep={()=>{}} onSelect={()=>{}}/>);
  expect(screen.getAllByText("нет данных")).toHaveLength(4);
});

it("does not attach another version/hash report or narrative to selected version",async()=>{
  const api=new DemoApi();const version=(await api.listVersions("demo_m_order"))[0]!;
  const check=await api.getCheck((await api.listCheckRuns(version.id))[0]!);
  const view={...check,runId:check.run.run_id} as Parameters<typeof boundResults>[0];
  expect(boundResults(view,"other",version.spec_hash).own).toHaveLength(0);
  const result=check.results[0]!;
  const narrative={summary:"x",question:null,properties:[{property_id:result.property_id,explanation:"x",steps:[],hypotheses:[]}]};
  expect(findNarrative([{report:{results:[{...result,spec_hash:"foreign"}]},explanation:narrative}],result)).toBeNull();
});

it("launches all rules through a single button, no selectors or limit inputs",async()=>{
  const version=(await new DemoApi().listVersions("demo_m_order"))[0]!;const onRun=vi.fn();
  render(<CheckLauncher version={version} busy={false} onRun={onRun}/>);
  expect(screen.queryByRole("checkbox")).toBeNull();expect(screen.queryByRole("spinbutton")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Проверить версию 1"}));expect(onRun).toHaveBeenCalledTimes(1);
});

function Split(){const pane=usePaneWidth("test:pane",.4,200,300);return <div ref={pane.container} style={pane.style}><PaneSeparator pane={pane} label="Ширина"/></div>}
it("resizes with keyboard, enforces endpoints and persists percentages",()=>{
  const {unmount}=render(<Split/>);let separator=screen.getByRole("separator");
  expect(separator).toHaveAttribute("aria-orientation","vertical");
  fireEvent.keyDown(separator,{key:"ArrowRight"});expect(separator).toHaveAttribute("aria-valuenow","41");
  fireEvent.keyDown(separator,{key:"Home"});expect(separator.getAttribute("aria-valuenow")).toBe(separator.getAttribute("aria-valuemin"));
  fireEvent.keyDown(separator,{key:"End"});expect(separator.getAttribute("aria-valuenow")).toBe(separator.getAttribute("aria-valuemax"));
  const value=separator.getAttribute("aria-valuenow");unmount();render(<Split/>);expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow",value);
});

it("highlights only exact source_refs using Unicode codepoint offsets",()=>{
  const source={id:"s",session_id:"s",kind:"text" as const,text:"🙂 Одно. Два."};
  const refs=[{id:"one",text:"one",source_refs:[{source_id:"s",quote:"Одно.",start:2,end:7}]},{id:"two",text:"two",source_refs:[{source_id:"s",quote:"Два.",start:8,end:12}]}];
  expect(refMatches(source,refs[0]!.source_refs[0]!)).toBe(true);
  expect(highlightSpans(source,refs).filter(s=>s.requirementIds.length).map(s=>s.requirementIds)).toEqual([["one"],["two"]]);
  expect(highlightSpans(source,[{...refs[0]!,source_refs:[{...refs[0]!.source_refs[0]!,quote:"invented"}]}]).every(s=>s.requirementIds.length===0)).toBe(true);
});

it("keeps actual public entry order, archived questions and pending status after refresh",async()=>{
  const detail=await new DemoApi().getSession("demo_s_order");
  const view={session_id:detail.id,status:"not_started",analysis:null,requirements:[],questions:[],corrections:[],open_question_ids:[],pending:null,model:null,reply:null,round:null,max_rounds:null,
    entries:[{id:"b",sequence:5,created_at:"t2",kind:"assistant",text:"Уточнение?",questions:[]},{id:"a",sequence:1,created_at:"t1",kind:"user",text:"Начальный текст",status:"processed"}]} satisfies DialogueView;
  const history=publicHistory(view,detail);expect(history.entries.map(e=>e.key)).toEqual(["a","b"]);
  expect(JSON.stringify(history)).not.toContain("message_data");expect(publicHistory(structuredClone(view),detail)).toEqual(history);
});

it("drops duplicate/out-of-order/foreign SSE, reconnects from the cursor and stops at run_finished",async()=>{
  const delivered:RunEvent[]=[];const cursors:number[]=[];let attempt=0;
  const event=(id:number,type:RunEvent["type"]="message_delta"):RunEvent=>({event_id:id,run_id:"r",session_id:"s",type,data:{text:String(id)}});
  const api=new HttpApi();api.streamEvents=async function*(_id,after){cursors.push(after);if(attempt++===0){yield event(1);yield event(1);yield {...event(2),run_id:"other"};throw Error("offline");}yield event(2);yield event(1);yield event(3,"run_finished");};
  const tracker=new RunTracker({api,runId:"r",onEvent:e=>delivered.push(e),onStatus:()=>{},backoffMs:[0],sleep:async()=>{}});
  tracker.start();await waitFor(()=>expect(tracker.done).toBe(true));
  expect(cursors).toEqual([0,1]);expect(delivered.map(e=>e.event_id)).toEqual([1,2,3]);
});
