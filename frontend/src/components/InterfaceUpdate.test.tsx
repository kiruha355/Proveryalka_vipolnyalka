import {afterEach, expect, it, vi} from "vitest";
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {InterfaceUpdate} from "./InterfaceUpdate";

afterEach(()=>{document.querySelector('script[data-update-test]')?.remove();vi.unstubAllGlobals();});
function script(){const s=document.createElement("script");s.type="module";s.src="/assets/index-old.js";s.dataset.updateTest="1";document.head.append(s);}
function response(src: string){return {ok:true,url:window.location.origin+"/",text:async()=>`<html><script type="module" src="${src}"></script></html>`};}

it("offers a reload only when a newer bundle is actually found, without clearing the draft",async()=>{
  script();localStorage.setItem("draft-test","Набранный ответ");
  const fetcher=vi.fn().mockResolvedValueOnce(response("/assets/index-old.js")).mockResolvedValueOnce(response("/assets/index-new.js"));vi.stubGlobal("fetch",fetcher);
  render(<InterfaceUpdate/>);
  await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));expect(screen.queryByRole("button")).toBeNull();
  fireEvent.focus(window);
  expect(await screen.findByRole("button",{name:"Обновить интерфейс"})).toBeInTheDocument();
  expect(localStorage.getItem("draft-test")).toBe("Набранный ответ");
});

it("keeps a failed check quiet and can check again on focus",async()=>{
  script();const fetcher=vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(response("/assets/index-new.js"));vi.stubGlobal("fetch",fetcher);
  render(<InterfaceUpdate compact/>);await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button")).toBeNull();fireEvent.focus(window);
  expect(await screen.findByRole("button",{name:"Обновить интерфейс"})).toBeInTheDocument();
});
