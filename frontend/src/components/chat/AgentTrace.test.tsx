import {render, screen, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {expect, it} from "vitest";
import type {Run, RunEvent} from "../../api/types";
import {AgentTrace} from "./AgentTrace";

const run = (state: Run["state"]): Run => ({run_id: "r", session_id: "s", state, error_code: null, version_id: null});
const event = (id: number, type: RunEvent["type"], data: Record<string, unknown>, at?: string): RunEvent => ({
  run_id: "r", session_id: "s", event_id: id, type, data, created_at: at,
});

it("shows one actual current phase and deduplicated public operations without exposing event payloads", async () => {
  const request = event(2, "activity", {phase: "model_request", prompt: "PRIVATE PROMPT", reasoning: "PRIVATE REASONING"}, "2026-10-31T10:00:01Z");
  render(<AgentTrace trace={{runId: "r", run: run("running"), events: [
    event(1, "activity", {phase: "context_ready"}, "2026-10-31T10:00:00Z"), request, request,
  ]}}/>);
  const summary = screen.getByText("Ход работы").closest("summary")!;
  expect(summary).toHaveTextContent("Модель готовит ответ");
  expect(summary.parentElement).not.toHaveAttribute("open");
  await userEvent.click(summary);
  expect(summary.parentElement).toHaveAttribute("open");
  const list = screen.getByRole("list", {name: "События запуска агента"});
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getByText("Отправлен запрос к модели")).toBeVisible();
  expect(screen.queryByText(/PRIVATE/)).toBeNull();
  expect(screen.queryByText(/Вызван инструмент/)).toBeNull();
  expect(screen.queryByText(/Предложена версия модели/)).toBeNull();
});

it("keeps partial failure honest and calculates elapsed time only from saved timestamps", () => {
  const {rerender} = render(<AgentTrace trace={{runId: "r", run: {...run("failed"), error_code: "PROVIDER_TIMEOUT"},
    createdAt: "2026-10-31T10:00:00Z", finishedAt: "2026-10-31T10:00:05.500Z", events: [
      event(1, "activity", {phase: "model_request"}), event(2, "error", {code: "PROVIDER_TIMEOUT", message: "PRIVATE DETAIL"}),
      event(3, "run_finished", {state: "failed"}),
    ]}}/>);
  expect(screen.getByText("Ход работы").closest("summary")).toHaveTextContent("Сбой5,5 с");
  expect(screen.queryByText("Завершено")).toBeNull();
  expect(screen.queryByText("PRIVATE DETAIL")).toBeNull();
  rerender(<AgentTrace trace={{runId: "r", run: run("cancelled"), events: [event(1, "run_finished", {state: "cancelled"})]}}/>);
  expect(screen.getByText("Ход работы").closest("summary")).toHaveTextContent("Остановлено");
  expect(screen.queryByText(/\d+ с$/)).toBeNull();
  expect(screen.getByText("Данные этапов не сохранены.")).toBeInTheDocument();
});

it("does not reconstruct phases or missing timing for old history", () => {
  render(<AgentTrace trace={{runId: "r", run: run("completed"), events: [
    event(1, "message_delta", {characters: 90}), event(2, "model_proposed", {number: 4}), event(3, "run_finished", {state: "completed"}),
  ], eventsTruncated: true}}/>);
  expect(screen.getByText("Получен текст ответа")).toBeInTheDocument();
  expect(screen.getByText("Предложена версия модели 4")).toBeInTheDocument();
  expect(screen.getByText("Данные этапов не сохранены.")).toBeInTheDocument();
  expect(screen.getByText("Показана часть сохранённых событий.")).toBeInTheDocument();
  expect(screen.queryByText("Контекст подготовлен")).toBeNull();
  expect(screen.queryByText("Отправлен запрос к модели")).toBeNull();
  expect(document.querySelector("time")).toBeNull();
});

it("exposes a partial error while waiting for the terminal run state", () => {
  render(<AgentTrace trace={{runId: "r", run: run("running"), events: [
    event(1, "activity", {phase: "model_request"}), event(2, "error", {code: "PROVIDER_TIMEOUT"}),
  ]}}/>);
  expect(screen.getByText("Ход работы").closest("summary")).toHaveTextContent("Ошибка выполнения");
  expect(screen.queryByText("Завершено")).toBeNull();
  expect(screen.queryByText("Сбой")).toBeNull();
});

it("distinguishes actual validation outcomes and version reuse", () => {
  render(<AgentTrace trace={{runId: "r", run: run("completed"), events: [
    event(1, "activity", {phase: "validation", outcome: "failed", attempt: 1}),
    event(2, "activity", {phase: "retry", attempt: 2}),
    event(3, "activity", {phase: "validation", outcome: "passed", attempt: 2}),
    event(4, "model_proposed", {number: 4, changed: false}),
    event(5, "run_finished", {state: "completed"}),
  ]}}/>);
  expect(screen.getByText("Ответ требует исправления")).toBeInTheDocument();
  expect(screen.getByText("Структура ответа проверена")).toBeInTheDocument();
  expect(screen.getByText("Использована версия модели 4")).toBeInTheDocument();
  expect(screen.queryByText("Предложена версия модели 4")).toBeNull();
});
