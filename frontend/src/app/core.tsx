import { createContext, useContext } from "react";
import type { CheckLimits } from "../api/types";
import type { ParsedHistory } from "../domain/dialogue";
import type { SessionWorkspace } from "../state/useSessionWorkspace";

/** Actions of the core views; not part of the extension API. */
export interface CoreActions {
  workspace: SessionWorkspace;
  history: ParsedHistory | null;
  /** Properties chosen for the next check of the selected version. */
  selectedProperties: string[];
  setSelectedProperties(ids: string[]): void;
  limits: CheckLimits;
  setLimits(limits: CheckLimits): void;
  runCheck(): void;
  composeMessage(text: string): void;
  replyTo(questionId: string): void;
}

export const CoreContext = createContext<CoreActions | null>(null);

export function useCore(): CoreActions {
  const value = useContext(CoreContext);
  if (!value) throw new Error("useCore() outside the session view");
  return value;
}
