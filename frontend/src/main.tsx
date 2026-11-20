import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/golos-text/400.css";
import "@fontsource/golos-text/500.css";
import "@fontsource/golos-text/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/app.css";
import { App } from "./App";
import { registerCoreViews } from "./app/coreViews";
import { loadExtensions } from "./extensions/load";

registerCoreViews();
loadExtensions();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
