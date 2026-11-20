// @vitest-environment node
import {expect,it} from "vitest";
import {HttpApi} from "./http";
import {newKey} from "./api";
import {createCodegenProvider} from "../../../frontend-extensions/src/files/provider";
import orderFixed from "../fixtures/order_fixed.json";
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
  // The fixed fixture is a second immutable version; no LLM/correction dialogue is simulated.
  const fixed=structuredClone(orderFixed) as unknown as BehavioralModel;
  const fixedSource=await api.uploadDocument(session.id,new File([fixed.sources[0]!.text],"corrected.md"),newKey());
  for(const s of fixed.sources){const old=s.id;s.id=fixedSource.id;s.session_id=session.id;for(const r of fixed.requirements)for(const ref of r.source_refs)if(ref.source_id===old)ref.source_id=fixedSource.id;}
  const fixedVersion=await api.createVersion(model.id,{spec:fixed,parent_id:version.id},newKey());
  const fixedRun=await api.createCheck(model.id,fixedVersion.number,{property_ids:null},newKey());
  for await(const _event of api.streamEvents(fixedRun.run_id,0,AbortSignal.timeout(60000))){/* wait for the actual checker */}
  const fixedReport=await api.getCheck(fixedRun.run_id);
  expect(fixedReport.results.every(r=>r.status==="PROPERTY_HOLDS")).toBe(true);
  await api.approveVersion(model.id,fixedVersion.number);
  const provider=createCodegenProvider({baseUrl:base});
  expect((await provider.status()).available).toBe(true);
  const generation=await provider.createGeneration({model_id:model.id,number:fixedVersion.number},{allowUnverified:false},newKey());
  expect(generation).toMatchObject({version_id:fixedVersion.id,spec_hash:fixedVersion.spec_hash,verification:{state:"holds"}});
  expect((await provider.readFile(generation.generation_id,"README.md")).bytes.length).toBeGreaterThan(0);
  expect((await provider.downloadArchive(generation.generation_id)).bytes.length).toBeGreaterThan(0);
  let test=await provider.startTestRun(generation.generation_id,newKey());
  const deadline=Date.now()+60000;
  while(["queued","running"].includes(test.status) && Date.now()<deadline){await new Promise(r=>setTimeout(r,100));test=await provider.getTestRun(test.test_run_id);}
  expect(test.status).toBe("passed");
  expect((await provider.getTestLog(test.test_run_id)).length).toBeGreaterThan(0);
  console.info(JSON.stringify({proof:"HTTP adapters + real TLC + codegen + Docker, no LLM or browser",version_id:fixedVersion.id,generation_id:generation.generation_id,test_run_id:test.test_run_id,status:test.status,counts:test.counts}));

},90000);
