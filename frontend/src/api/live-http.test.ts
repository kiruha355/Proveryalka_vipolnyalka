// @vitest-environment node
import {expect,it} from "vitest";
import {HttpApi} from "./http";
import {newKey} from "./api";
import orderBug from "../fixtures/order_bug.json";
import type {BehavioralModel} from "./types";

const base=process.env.PROVERYALKA_HTTP_TEST_URL;
it.skipIf(!base)("real HttpApi + multipart + immutable model + SSE + TLC counterexample",async()=>{
  const api=new HttpApi(base);const caps=await api.capabilities();
  expect(caps).toMatchObject({adapter:"http",dialogue:true,documents:true,explanations:true});
  const session=await api.createSession({title:"Frontend HTTP adapter acceptance"},newKey());
  const view=await api.getDialogue(session.id);expect(view.entries).toEqual([]);
  const spec=structuredClone(orderBug) as unknown as BehavioralModel;
  const text=spec.sources[0]!.text;
  const source=await api.uploadDocument(session.id,new File([text],"requirements.md",{type:"text/markdown"}),newKey());
  const detail=await api.getSession(session.id);expect(detail.documents?.[0]?.source_id).toBe(source.id);
  expect((await api.getDialogue(session.id)).status).toBe("not_started"); // Upload never starts an agent.
  for(const s of spec.sources){const original=s.id;s.id=source.id;s.session_id=session.id;for(const r of spec.requirements)for(const ref of r.source_refs)if(ref.source_id===original)ref.source_id=source.id;}
  const created=await fetch(`${base}/api/sessions/${session.id}/models`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":newKey()},body:JSON.stringify({name:spec.name})});
  expect(created.status).toBe(201);const model=await created.json();
  const version=await api.createVersion(model.id,{spec},newKey());
  const key=newKey();const run=await api.createCheck(model.id,version.number,{property_ids:null,explain:false},key);
  expect((await api.createCheck(model.id,version.number,{property_ids:null,explain:false},key)).run_id).toBe(run.run_id);
  const events=[];for await(const event of api.streamEvents(run.run_id,0,AbortSignal.timeout(60000)))events.push(event);
  expect(events.at(-1)?.type).toBe("run_finished");
  const check=await api.getCheck(run.run_id);expect(check.run.state).toBe("completed");
  const violation=check.results.find(r=>r.property_id==="NoCancelledExecution")!;
  expect(violation).toMatchObject({version_id:version.id,spec_hash:version.spec_hash,status:"PROPERTY_VIOLATED",executed:true,engine:{name:"TLC"}});
  expect(violation.trace.map(s=>s.transition_id).filter(Boolean)).toEqual(["Approve","Cancel","Execute"]);
  expect(check.results).toHaveLength(spec.properties.length);
  expect((await api.listArtifacts(run.run_id)).some(file=>file.name==="report.json")).toBe(true);
},90000);
