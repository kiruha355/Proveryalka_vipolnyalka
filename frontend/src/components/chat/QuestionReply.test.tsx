import {beforeEach, expect, it, vi} from "vitest";
import {fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {App} from "../../App";
import {DemoApi, LIVE_RECORDING} from "../../api/demo";
import {ApiError} from "../../api/errors";
import type {Question} from "../../api/types";
import {resetExtensions} from "../../app/extensions";
import {registerCoreViews} from "../../app/coreViews";
import {loadLocal, updateLocal} from "../../state/persist";
import {ORDER_DEMO_ANSWERS} from "./DemoAnswers";

const sessionId="demo_s_order";
const question: Question={id:"q_initial",text:"Что уже произошло с заявкой к началу рассматриваемого процесса: была ли она согласована, отменена или исполнена?",reason:"Нужно задать исходное состояние.",kind:"missing",assumption:null,status:"open",answer_source_id:null};

beforeEach(()=>{resetExtensions();registerCoreViews();});

function apiWithQuestion(q=question){
  const api=new DemoApi();
  api.capabilities=vi.fn(async()=>({adapter:"http" as const,agent:true,questionId:true,customLimits:false,artifacts:false,checkDiscovery:false,documents:false,dialogue:true}));
  api.ready=vi.fn(async()=>({status:"ready",agent_configured:true}));
  api.getDialogue=vi.fn(async()=>({...structuredClone(LIVE_RECORDING.dialogue),session_id:sessionId,status:"needs_clarification" as const,questions:[q],open_question_ids:[q.id],pending:null,
    entries:[{id:"reply",sequence:1,created_at:"2026-10-31T10:00:00Z",kind:"assistant" as const,text:"Уточните исходное состояние.",questions:[q]}]}));
  api.sendMessage=vi.fn(async()=>{throw new ApiError("unsupported","Test transport");});
  return api;
}

function route(scenario=false){
  window.history.replaceState(null,"",`/${scenario?"?scenario=order":""}#/s/${sessionId}?m=demo_m_order&v=1&view=requirements`);
}

it("inserts a complete explicit demo answer, preserves draft and exact question binding after remount, and sends only on request",async()=>{
  route(true);const api=apiWithQuestion();updateLocal(api.id,sessionId,s=>({...s,draft:"Моё уточнение"}));
  const first=render(<App initialApi={api}/>);
  fireEvent.click(await within(await screen.findByRole("list",{name:"История диалога"})).findByRole("button",{name:"Ответить"}));
  const input=screen.getByRole("textbox",{name:"Сообщение агенту"}) as HTMLTextAreaElement;
  expect(input.value).toBe("Моё уточнение");expect(screen.getByText(question.text,{selector:".composer__reply-text"})).toBeInTheDocument();
  fireEvent.click(screen.getByText("Ответы для демонстрации"));
  fireEvent.click(screen.getByRole("button",{name:"Начальное состояние"}));
  const expected=`Моё уточнение\n\n${ORDER_DEMO_ANSWERS[0].text}`;
  expect(input.value).toBe(expected);expect(input).toHaveFocus();expect(api.sendMessage).not.toHaveBeenCalled();
  expect(loadLocal(api.id,sessionId)).toMatchObject({draft:expected,draftQuestionId:question.id});
  first.unmount();route(true);render(<App initialApi={api}/>);
  await screen.findByText(question.text,{selector:".composer__reply-text"});
  expect((screen.getByRole("textbox",{name:"Сообщение агенту"}) as HTMLTextAreaElement).value).toBe(expected);
  fireEvent.click(screen.getByRole("button",{name:"Отправить"}));
  await waitFor(()=>expect(api.sendMessage).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.sendMessage).mock.calls[0]).toEqual([sessionId,{text:expected,question_id:question.id},expect.any(String),expect.any(AbortSignal)]);
});

it("assumption confirmation appends to the existing draft without auto-send",async()=>{
  route();const api=apiWithQuestion({...question,kind:"assumption",assumption:"Отменённая заявка не должна исполняться."});
  updateLocal(api.id,sessionId,s=>({...s,draft:"Сначала моё пояснение"}));render(<App initialApi={api}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Подтверждаю"}));
  expect((screen.getByRole("textbox",{name:"Сообщение агенту"}) as HTMLTextAreaElement).value).toBe("Сначала моё пояснение\n\nДа, верно: Отменённая заявка не должна исполняться.");
  expect(api.sendMessage).not.toHaveBeenCalled();expect(loadLocal(api.id,sessionId).draftQuestionId).toBe(question.id);
});

it("ordinary questions do not invent an answer; removing the binding preserves the written text",async()=>{
  route();const api=apiWithQuestion();render(<App initialApi={api}/>);
  fireEvent.click(await within(await screen.findByRole("list",{name:"История диалога"})).findByRole("button",{name:"Ответить"}));
  const input=screen.getByRole("textbox",{name:"Сообщение агенту"}) as HTMLTextAreaElement;
  expect(input.value).toBe("");expect(screen.queryByText("Ответы для демонстрации")).toBeNull();
  fireEvent.change(input,{target:{value:"Мой настоящий ответ"}});
  fireEvent.click(screen.getByRole("button",{name:"Отвязать ответ от вопроса"}));
  expect(input.value).toBe("Мой настоящий ответ");expect(loadLocal(api.id,sessionId).draftQuestionId).toBeNull();
  expect(screen.queryByText(question.text,{selector:".composer__reply-text"})).toBeNull();expect(api.sendMessage).not.toHaveBeenCalled();
});
