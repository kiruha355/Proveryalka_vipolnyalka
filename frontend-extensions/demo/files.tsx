import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/extensions.css";
import "./demo.css";
import { ProjectFilesView } from "../src/files/components/ProjectFilesView";
import {
  createRecordedCodegenProvider,
  CODEGEN_VERSION,
} from "../src/fixtures/codegen";
const provider = createRecordedCodegenProvider();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="demo">
      <section className="demo__frame demo__frame--files">
        <ProjectFilesView
          provider={provider}
          currentVersion={CODEGEN_VERSION}
          focus={{ path: "app/rules.py", lines: { start: 34, end: 45 } }}
          onRuleSelect={() => {}}
        />
      </section>
    </div>
  </StrictMode>,
);
