import {useEffect, useState} from "react";

// Check only on entry/focus. Never reload an active conversation automatically.
export function InterfaceUpdate({compact=false}: {compact?: boolean}) {
  const [available,setAvailable]=useState(false);
  useEffect(()=>{
    const current=document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
    if (!current || !/\/assets\/[^/]+\.js(?:\?|$)/.test(current)) return;
    const lifetime=new AbortController();
    let pending=false;
    const check=async()=>{
      if (pending || document.visibilityState === "hidden") return;
      pending=true;
      try {
        const response=await fetch(new URL("./",window.location.href),{cache:"no-store",signal:lifetime.signal,headers:{Accept:"text/html"}});
        if (!response.ok) return;
        const html=new DOMParser().parseFromString(await response.text(),"text/html");
        const next=html.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src");
        if (next && !lifetime.signal.aborted) setAvailable(new URL(next,response.url || window.location.href).href !== current);
      } catch { /* A failed update check does not interrupt the working app. */ }
      finally {pending=false;}
    };
    void check();
    window.addEventListener("focus",check);
    document.addEventListener("visibilitychange",check);
    return ()=>{lifetime.abort();window.removeEventListener("focus",check);document.removeEventListener("visibilitychange",check);};
  },[]);
  if (!available) return null;
  return <button type="button" className="button button--small button--ghost" aria-label="Обновить интерфейс"
    title="Доступна новая версия интерфейса" onClick={()=>window.location.reload()}>{compact?"↻":"Обновить интерфейс"}</button>;
}
