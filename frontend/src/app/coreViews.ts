import { registerWorkspaceView } from "./extensions";
import { CheckView } from "../components/views/CheckView";
import { ModelView } from "../components/views/ModelView";
import { RequirementsView } from "../components/views/RequirementsView";
import { Doc, Shield, Table } from "../components/icons";

export function registerCoreViews(): void {
  registerWorkspaceView({
    id: "requirements", label: "Требования", icon: Doc, order: 10, component: RequirementsView,
    available: () => true,
  });
  registerWorkspaceView({ id: "model", label: "Модель", icon: Table, order: 20, component: ModelView, available: (ctx) => ctx.version !== null });
  registerWorkspaceView({ id: "check", label: "Проверка", icon: Shield, order: 30, component: CheckView, available: (ctx) => ctx.version !== null });
}
