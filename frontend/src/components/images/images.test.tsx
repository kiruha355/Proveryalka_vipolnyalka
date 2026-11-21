import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../../App";
import type { ApiCapabilities, ProveryalkaApi } from "../../api/api";
import { DemoApi, LIVE_RECORDING } from "../../api/demo";
import { ApiError } from "../../api/errors";
import type { ImageAnalysis, ImageAnalysisRecord, ImageRegion, ImageSource } from "../../api/images";
import { registerCoreViews } from "../../app/coreViews";
import { resetExtensions } from "../../app/extensions";
import { loadLocal } from "../../state/persist";
import { NewChat } from "../NewChat";
import { MAX_IMAGE_BYTES } from "./imageFile";

const caps: ApiCapabilities = {
  adapter: "http", agent: true, questionId: true, customLimits: false, artifacts: false,
  checkDiscovery: true, documents: true, dialogue: true, images: true,
};
const image: ImageSource = { id: "img1", session_id: "demo_s_order", filename: "Заявка.png", width: 400, height: 200 };
const file = new File(["image"], image.filename, { type: "image/png" });
const imageLabel = "Приложить изображение PNG, JPEG или WebP";
const content = "/api/image.png";
const crop = { x: 40, y: 20, width: 200, height: 100 };

beforeEach(() => {
  resetExtensions();
  registerCoreViews();
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function chooseImage(container: HTMLElement, chosen: File) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"][accept*="webp"]')!;
  fireEvent.change(input, { target: { files: [chosen] } });
}

it("validates an image before creating a new chat, retries the same upload and keeps the draft", async () => {
  const api = new DemoApi();
  const create = vi.spyOn(api, "createSession");
  const uploadImage = vi.fn<NonNullable<ProveryalkaApi["uploadImage"]>>()
    .mockRejectedValueOnce(new ApiError("network", "offline"))
    .mockResolvedValueOnce(image);
  const imageApi = Object.assign(api, { uploadImage });
  const created = vi.fn();
  const { container } = render(<NewChat api={imageApi} capabilities={caps} onCreated={created} />);
  expect(screen.getByRole("button", { name: imageLabel })).toBeEnabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Описание поведения" }), { target: { value: "Мой черновик" } });

  chooseImage(container, new File(["x"], "image.svg", { type: "image/svg+xml" }));
  expect(screen.getByRole("alert")).toHaveTextContent("PNG, JPEG или WebP");
  chooseImage(container, new File([], "empty.webp", { type: "image/webp" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Файл пуст");
  chooseImage(container, new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "big.jpg", { type: "image/jpeg" }));
  expect(screen.getByRole("alert")).toHaveTextContent("8 МиБ");
  expect(create).not.toHaveBeenCalled();

  chooseImage(container, file);
  expect(await screen.findByRole("alert")).toHaveTextContent("Нет связи");
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await waitFor(() => expect(created).toHaveBeenCalledOnce());
  expect(create).toHaveBeenCalledOnce();
  expect(uploadImage.mock.calls[0]).toEqual(uploadImage.mock.calls[1]);
  const session = created.mock.calls[0]![0];
  expect(loadLocal(api.id, session.id)).toMatchObject({ draft: "Мой черновик", openImageId: image.id, outbox: null });
});

it("uploads in an existing chat, analyzes the full image and multiple rectangles, then uses a saved result after remount", async () => {
  const api = new DemoApi();
  const openQuestion = {
    id: "q1", text: "Куда ведёт стрелка?", reason: "Неясна схема", kind: "missing" as const,
    assumption: null, status: "open" as const, answer_source_id: null,
  };
  const original = await api.getDialogue(image.session_id);
  api.getDialogue = vi.fn(async () => ({ ...original, status: "needs_clarification" as const, questions: [openQuestion],
    open_question_ids: [openQuestion.id], entries: [{ id: "answer", sequence: 1, kind: "assistant" as const,
      created_at: "2026-11-21T00:00:00Z", text: "Уточните переход." }],
  }));
  api.capabilities = async () => caps;
  api.ready = async () => ({ status: "ready", agent_configured: true });
  const images: ImageSource[] = [];
  const records: ImageAnalysisRecord[] = [];
  const uploadImage = vi.fn(async () => { images.push(image); return image; });
  const analyzeImage = vi.fn(async (_sid: string, _image: string, region: ImageRegion | null, _key: string) => {
    const id = `a${records.length + 1}`;
    const result: ImageAnalysis = { id, source_id: image.id, description: "Схема заявки",
      requirements: [{ id: "visible", text: "Есть переход к исполнению.", origin: "visible" },
        { id: "guess", text: "Переход может требовать согласования.", origin: "proposal" }],
      uncertainties: ["Подпись стрелки размыта."], source_refs: [{ region }],
    };
    records.push({ id, source_id: image.id, state: "completed", error_code: null, result });
    return result;
  });
  const run = { run_id: "analyst-1", session_id: image.session_id, state: "completed" as const, version_id: null, error_code: null };
  const useImageAnalysisInDialogue = vi.fn(async () => run);
  api.getRun = async () => run;
  api.streamEvents = async function* () {
    yield { event_id: 1, run_id: run.run_id, session_id: run.session_id, type: "run_finished", data: { state: "completed" } };
  };
  const imageApi = Object.assign(api, { uploadImage, analyzeImage, useImageAnalysisInDialogue,
    listImages: async () => [...images], listImageAnalyses: async () => [...records], getImageContentUrl: () => content,
  });
  window.location.hash = `/s/${image.session_id}`;
  const first = render(<App initialApi={imageApi} />);
  await screen.findByRole("button", { name: imageLabel });
  chooseImage(first.container, file);
  expect(uploadImage).toHaveBeenCalledWith(image.session_id, file, expect.any(String));
  const dialog = await screen.findByRole("dialog", { name: image.filename });
  expect(within(dialog).getByRole("img", { name: image.filename })).toHaveAttribute("src", content);
  fireEvent.click(within(dialog).getByRole("button", { name: "Анализировать всё изображение" }));
  await within(dialog).findByText("Подпись стрелки размыта.");
  expect(within(dialog).getByText("Неуверенно распознано")).toBeInTheDocument();
  expect(analyzeImage).toHaveBeenNthCalledWith(1, image.session_id, image.id, null, expect.any(String));
  expect(useImageAnalysisInDialogue).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole("button", { name: "Выделить область" }));
  const surface = within(dialog).getByRole("group", { name: "Выбор прямоугольной области" });
  vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, width: 200, height: 100 } as DOMRect);
  Object.assign(surface, { setPointerCapture: vi.fn() });
  fireEvent.pointerDown(surface, { pointerId: 1, pointerType: "touch", button: 0, clientX: 130, clientY: 80 });
  fireEvent.pointerMove(surface, { pointerId: 1, pointerType: "touch", clientX: 30, clientY: 30 });
  fireEvent.pointerUp(surface, { pointerId: 1, pointerType: "touch", clientX: 30, clientY: 30 });
  expect(within(dialog).getByRole("img", { name: "Выделенная область" })).toHaveStyle({ left: "10%", width: "50%" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Анализировать область" }));
  await within(dialog).findByRole("button", { name: "Область 40, 20 · 200 × 100 пкс" });
  expect(analyzeImage).toHaveBeenNthCalledWith(2, image.session_id, image.id, crop, expect.any(String));

  fireEvent.pointerDown(surface, { pointerId: 2, pointerType: "mouse", button: 0, clientX: 60, clientY: 50 });
  fireEvent.pointerUp(surface, { pointerId: 2, pointerType: "mouse", clientX: 250, clientY: 140 });
  fireEvent.click(within(dialog).getByRole("button", { name: "Анализировать область" }));
  await within(dialog).findByRole("button", { name: "Область 100, 60 · 300 × 140 пкс" });
  expect(analyzeImage).toHaveBeenNthCalledWith(3, image.session_id, image.id,
    { x: 100, y: 60, width: 300, height: 140 }, expect.any(String));

  first.unmount();
  render(<App initialApi={imageApi} />);
  const restored = await screen.findByRole("dialog", { name: image.filename });
  const savedRegion = await within(restored).findByRole("button", { name: "Область 40, 20 · 200 × 100 пкс" });
  fireEvent.click(savedRegion);
  expect(within(restored).getByRole("img", { name: "Выделенная область" })).toHaveStyle({ left: "10%", top: "10%", width: "50%", height: "50%" });
  const saved = savedRegion.closest("li")!;
  fireEvent.click(within(saved).getByRole("button", { name: "Использовать в диалоге" }));
  await waitFor(() => expect(useImageAnalysisInDialogue).toHaveBeenCalledWith(image.session_id, image.id, "a2", expect.any(String), expect.any(AbortSignal)));
  expect(uploadImage).toHaveBeenCalledOnce();
  expect(analyzeImage).toHaveBeenCalledTimes(3);
});

it("opens the same image region from a requirement, a model element and a check explanation", async () => {
  const { session, versions, checks } = LIVE_RECORDING;
  const version = versions[0]!;
  const check = checks[0]!;
  const result = check.results[0]!;
  const property = version.spec.properties.find(p => p.id === result.property_id)!;
  const requirement = version.spec.requirements.find(item =>
    result.related_requirements.includes(item.id) && property.requirement_ids.includes(item.id))!;
  const ref = requirement.source_refs[0]!;
  const api = new DemoApi();
  api.capabilities = async () => caps;
  api.ready = async () => ({ status: "ready", agent_configured: true });
  api.getSession = async () => ({ ...session, linked_source_ids: [ref.source_id] });
  const getImageProvenance = vi.fn(async () => ({ ...image, kind: "image" as const, image_source_id: image.id, analysis_id: "a2", region: crop }));
  const imageApi = Object.assign(api, { getImageProvenance, getImageContentUrl: () => content });
  const route = `/s/${session.id}?m=${version.model_id}&v=${version.number}`;
  window.location.hash = `${route}&view=requirements`;
  const first = render(<App initialApi={imageApi} />);
  const open = async (scope: HTMLElement) => {
    const buttons = await within(scope).findAllByRole("button", { name: ref.quote });
    buttons[0]!.focus();
    fireEvent.click(buttons[0]!);
    const viewer = screen.getByRole("dialog", { name: image.filename });
    expect(within(viewer).getByRole("img", { name: image.filename })).toHaveAttribute("src", content);
    expect(within(viewer).getByRole("img", { name: "Выделенная область" })).toHaveStyle({ left: "10%", height: "50%" });
    fireEvent.click(within(viewer).getByRole("button", { name: "Закрыть изображение" }));
    expect(buttons[0]).toHaveFocus();
  };
  const row = (await screen.findAllByText(requirement.text, { selector: ".requirement__body > p" }))[0]!.closest("li")!;
  await open(row);
  first.unmount();
  window.location.hash = `${route}&view=check&check=${check.run.run_id}&p=${result.property_id}`;
  render(<App initialApi={imageApi} />);
  const explanation = await screen.findByRole("article", { name: property.name });
  await open(explanation);
  fireEvent.click(within(explanation).getByRole("button", { name: property.name }));
  await open(await screen.findByRole("complementary", { name: property.name }));
});
