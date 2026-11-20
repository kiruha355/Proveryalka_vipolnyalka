import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/extensions.css";
import "./demo.css";
import type { ModelVersion } from "../src/contracts/model";
import type { ModelVersionsPort } from "../src/api/http";
import { computeSpecHash } from "../src/dsl/spec-hash";
import { TransitionEditor } from "../src/graph/components/TransitionEditor";
import { StateGraphWorkspace } from "../src/graph/components/StateGraphWorkspace";
import type { GraphSelection } from "../src/graph/flow-elements";
import {
  ORDER_VERSIONS,
  TLC_ORDER_BUG_RESULT,
} from "../src/fixtures/order-versions";

/** Порт версий в памяти страницы: демонстрирует POST новой версии без сервера. */
function memoryPort(): ModelVersionsPort {
  return {
    async listVersions() {
      return ORDER_VERSIONS;
    },
    async createVersion(modelId, body) {
      return {
        id: `v_demo_${Date.now()}`,
        model_id: modelId,
        session_id: "fixtures",
        number: 3,
        parent_id: body.parent_id,
        spec: body.spec,
        spec_hash: computeSpecHash(body.spec),
        approved: false,
      };
    },
  };
}

function GraphScene({ focus }: { focus?: GraphSelection | null }) {
  const [versions, setVersions] = useState<ModelVersion[]>(ORDER_VERSIONS);
  const [selected, setSelected] = useState(ORDER_VERSIONS[0]!.id);
  return (
    <StateGraphWorkspace
      versions={versions}
      selectedVersionId={selected}
      onSelectVersion={setSelected}
      results={[TLC_ORDER_BUG_RESULT]}
      versionsPort={memoryPort()}
      onVersionCreated={(version) =>
        setVersions((current) => [...current, version])
      }
      focus={focus ?? null}
    />
  );
}

function App() {
  const executeEdge = `Execute|${JSON.stringify(["Cancelled"])}|${JSON.stringify(["Executed"])}`;
  return (
    <div className="demo">
      {
        <section className="demo__frame demo__frame--tall">
          <h2 className="demo__title">Модель заявки · контрпример TLC</h2>
          <p className="pv-muted" style={{margin:0,fontSize:12}}>Fixture модели и сохранённая трасса TLC. Создание версии в этом примере работает только в памяти страницы.</p>
          <GraphScene
            focus={{
              kind: "transition",
              transitionId: "Execute",
              edgeId: executeEdge,
            }}
          />
        </section>
      }
      {
        <section className="demo__frame demo__frame--auto">
          <h2 className="demo__title">Правка перехода Cancel</h2>
          <div className="pv-root">
            <TransitionEditor
              spec={ORDER_VERSIONS[0]!.spec}
              transition={ORDER_VERSIONS[0]!.spec.transitions[1]!}
              onApply={() => {}}
              onRemove={() => {}}
              onClose={() => {}}
            />
          </div>
        </section>
      }
    </div>
  );
}

// Для статического снимка DOM: выбранный option хранится в свойстве, а не в атрибуте.
setTimeout(() => {
  document
    .querySelectorAll("select")
    .forEach((select) =>
      select.selectedOptions[0]?.setAttribute("selected", ""),
    );
}, 1500);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
