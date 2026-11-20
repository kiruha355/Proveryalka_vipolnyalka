import type { ModelVersion } from "../../api/types";
import { Play } from "../icons";

export function CheckLauncher({version, busy, onRun}: {version: ModelVersion; busy: boolean; onRun(): void}) {
  return <button type="button" className="button button--primary" disabled={busy || version.spec.properties.length === 0}
    aria-label={`Проверить версию ${version.number}`} onClick={onRun} title="Проверить все правила этой версии">
    {busy ? <span className="spinner spinner--light" aria-hidden="true"/> : <Play size={15}/>} Проверить
  </button>;
}
