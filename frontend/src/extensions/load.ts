import { registerExtension, type ExtensionModule } from "../app/extensions";

// Feature packages live outside frontend/ (repo-root frontend-extensions/).
// The glob resolves to nothing when the directory is absent, so the core app
// builds and runs without them.
interface ConfigurableModule extends ExtensionModule {
  configureProjectFiles?: (options: {provider: unknown}) => void;
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
