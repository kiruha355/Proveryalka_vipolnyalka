import { registerExtension, type ExtensionModule } from "../app/extensions";

// Feature packages live outside frontend/ (repo-root frontend-extensions/).
// The glob resolves to nothing when the directory is absent, so the core app
// builds and runs without them.
interface ConfigurableModule extends ExtensionModule {
  setProjectFocus?: (focus: {path: string; generationId: string}) => void;
  configureProjectFiles?: (options: {provider: unknown} | null) => void;
  createCodegenProvider?: (options?: {baseUrl?: string}) => unknown;
}
const modules = import.meta.glob<ConfigurableModule>("../../../frontend-extensions/src/index.{ts,tsx}", { eager: true });

export function loadExtensions(): string[] {
  const loaded: string[] = [];
  for (const [path, module] of Object.entries(modules)) {
    if (module.configureProjectFiles && module.createCodegenProvider) {
      module.configureProjectFiles({provider: module.createCodegenProvider()});
    }
    registerExtension(module);
    loaded.push(path);
  }
  return loaded;
}

/** Keep code generation on the same backend as the selected API adapter. */
export function configureFilesForAdapter(adapter: "http" | "demo", baseUrl = ""): void {
  for (const module of Object.values(modules)) {
    if (!module.configureProjectFiles || !module.createCodegenProvider) continue;
    module.configureProjectFiles(adapter === "demo" ? null : {provider: module.createCodegenProvider({baseUrl})});
  }
}

export function focusGeneratedFile(ref: {path:string; generation_id:string}): void {
  for (const module of Object.values(modules)) module.setProjectFocus?.({path:ref.path,generationId:ref.generation_id});
}
