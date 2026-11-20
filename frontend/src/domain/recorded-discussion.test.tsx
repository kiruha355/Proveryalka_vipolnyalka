import {beforeEach, expect, it, vi} from "vitest";
import {fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {App} from "../App";
import {DemoApi, LIVE_RECORDING} from "../api/demo";
import {publicHistory} from "./dialogue";
import {refMatches} from "./requirements";
import {registerCoreViews} from "../app/coreViews";
import {resetExtensions} from "../app/extensions";
import {updateLocal} from "../state/persist";
import {computeSpecHash} from "../../../frontend-extensions/src/dsl/spec-hash";
import type {BehavioralModel as ExtensionModel} from "../../../frontend-extensions/src/contracts/model";

beforeEach(()=>{resetExtensions();registerCoreViews();});

it("serves the exact saved dialogue, reports and boolean models as a distinct recorded session", async()=>{
  const api=new DemoApi();const session=await api.getSession(LIVE_RECORDING.session.id);
  const view=await api.getDialogue(session.id);
  expect(session.recording_label).toContain("Запись GPT");expect(view).toEqual(LIVE_RECORDING.dialogue);
  const entries=publicHistory(view,session).entries;
  expect(entries).toHaveLength(10);expect(new Set(entries.map(e=>e.key)).size).toBe(10);
  expect(entries.map(e=>e.kind)).toEqual(["user","reply","user","reply","user","reply","user","reply","user","reply"]);
  expect(entries[6]).toMatchObject({kind:"user",text:"Объясни найденный контрпример."});
  expect(entries[7]).toMatchObject({kind:"reply",text:expect.stringContaining("Отмена сохраняет признак согласования")});
  expect(view.entries?.[2]?.question_id).toBe("q_65a3a359f5865c4ab1afa217b2274145");
  const versions=await api.listVersions(LIVE_RECORDING.models[0]!.id);
  expect(versions).toEqual(LIVE_RECORDING.versions);
  for(const version of versions){
    expect(version.spec.variables.map(v=>v.id).sort()).toEqual(["approved","cancelled","executed"]);
    expect(await computeSpecHash(version.spec as ExtensionModel)).toBe(version.spec_hash);
    for(const r of version.spec.requirements) for(const ref of r.source_refs){
      const source=version.spec.sources.find(s=>s.id===ref.source_id)!;expect(refMatches(source,ref)).toBe(true);
    }
  }
  const reports=await Promise.all(LIVE_RECORDING.checks.map(c=>api.getCheck(c.run.run_id)));
  expect(reports.map(r=>r.results[0]?.statistics.distinct_states)).toEqual([6,5]);
  expect(reports[0]?.explanation?.narrative).toEqual(LIVE_RECORDING.checks[0]?.explanation?.narrative);
  expect(reports.map(r=>r.results[0]?.spec_hash)).toEqual(versions.map(v=>v.spec_hash));
  expect((await api.listVersions("demo_m_order"))[0]?.spec.variables.some(v=>v.id==="status")).toBe(true);
});

it("keeps checks between the actual recorded turns, including after refresh",async()=>{
  const route=`/s/${LIVE_RECORDING.session.id}?m=${LIVE_RECORDING.models[0]!.id}&v=1&view=check&check=${LIVE_RECORDING.checks[0]!.run.run_id}&p=cancelled_not_executed`;
  const inspect=async()=>{
    const timeline=await screen.findByRole("list",{name:"История диалога"});
    await waitFor(()=>expect(within(timeline).getByText("Проверка версии 2")).toBeInTheDocument());
    const text=timeline.textContent!;
    const positions=["Для продолжения нужно уточнить начальное состояние", "Новая заявка не согласована", "Условие согласования добавлено", "Проверка версии 1", "Объясни найденный контрпример.", "Проверка нашла такую последовательность", "Исправляю правило исполнения:", "Условие исполнения обновлено:", "Проверка версии 2"].map(x=>text.indexOf(x));
    expect(positions.every(n=>n>=0)).toBe(true);expect(positions).toEqual([...positions].sort((a,b)=>a-b));
  };
  window.location.hash=route;const first=render(<App initialApi={new DemoApi()}/>);await screen.findByText(/Запись GPT subscription \+ TLC.*новые вызовы/);await inspect();
  first.unmount();window.location.hash=route;render(<App initialApi={new DemoApi()}/>);await inspect();
});

it("prefills discussion with selected old report and preserves draft without sending or changing the model",async()=>{
  const api=new DemoApi();api.sendMessage=vi.fn();api.createCheck=vi.fn();api.approveVersion=vi.fn();
  updateLocal(api.id,"demo_s_order",s=>({...s,draft:"Мой набранный вопрос"}));
  window.location.hash="/s/demo_s_order?m=demo_m_order&v=1&view=check&check=demo_chk_demo_order_v1_1&p=NoCancelledExecution";
  render(<App initialApi={api}/>);
  await screen.findByRole("button",{name:"Обсудить исправление"});
  const timeline=screen.getByRole("list",{name:"История диалога"});const before=timeline.children.length;
  fireEvent.click(screen.getByRole("button",{name:"Обсудить исправление"}));
  const composer=screen.getByRole("textbox",{name:"Сообщение агенту"}) as HTMLTextAreaElement;
  await waitFor(()=>expect(composer.value).toContain("Пока не меняй требования и модель"));
  expect(composer.value.startsWith("Мой набранный вопрос\n\n")).toBe(true);
  expect(composer.value).toContain("demo_chk_demo_order_v1_1, версия 1 (demo_order_v1)");
  expect(composer.value).toContain("может отличаться от последнего отчёта");
  expect(composer.value).toContain('"cancelled":true');expect(composer).toHaveFocus();
  const draft=composer.value;
  fireEvent.click(screen.getByRole("button",{name:"Объяснить причину"}));
  await waitFor(()=>expect(composer.value).toContain("Объясни причину найденного контрпримера."));
  expect(composer.value.startsWith(draft+"\n\n")).toBe(true);
  expect(api.sendMessage).not.toHaveBeenCalled();expect(api.createCheck).not.toHaveBeenCalled();expect(api.approveVersion).not.toHaveBeenCalled();
  expect(timeline.children.length).toBe(before);
});
