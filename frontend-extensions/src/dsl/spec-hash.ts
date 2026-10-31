import type { BehavioralModel } from "../contracts/model";
import { canonicalJson } from "../util/canonical-json";
import { sha256Hex } from "../util/sha256";

/**
 * spec_hash так же, как его считает сервер (verification/checker.py):
 * sha256(json.dumps(model_dump(mode="json"), sort_keys=True,
 * ensure_ascii=False, separators=(",", ":"))). Совпадение означает, что граф
 * нарисован ровно по той спецификации, к которой сервер привязал версию и отчёты.
 */
export function computeSpecHash(spec: BehavioralModel): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(spec)));
}
