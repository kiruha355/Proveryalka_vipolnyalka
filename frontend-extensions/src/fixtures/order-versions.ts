import type {
  BehavioralModel,
  ModelVersion,
  VerificationResult,
} from "../contracts/model";
import { normalizeSpec } from "../dsl/normalize";
import type { LooseBehavioralModel } from "../dsl/normalize";
import { computeSpecHash } from "../dsl/spec-hash";
import orderBug from "./models/order_bug.json";
import orderFixed from "./models/order_fixed.json";
import acceptance from "./tlc-acceptance-results.json";

/**
 * Примеры данных. Модели — tests/fixtures/models из backend 62c12b8.
 * Результаты TLC — реальный acceptance-прогон (см. _provenance в JSON),
 * version_id в них null: прогон шёл без HTTP-версии, привязка по spec_hash.
 */

export const ORDER_BUG_SPEC: BehavioralModel = normalizeSpec(
  orderBug as LooseBehavioralModel,
);
export const ORDER_FIXED_SPEC: BehavioralModel = normalizeSpec(
  orderFixed as LooseBehavioralModel,
);

export const ORDER_MODEL_ID = "m_fixture_order";

export const ORDER_VERSIONS: ModelVersion[] = [
  {
    id: "v_fixture_order_1",
    model_id: ORDER_MODEL_ID,
    session_id: "fixtures",
    number: 1,
    parent_id: null,
    spec: ORDER_BUG_SPEC,
    spec_hash: computeSpecHash(ORDER_BUG_SPEC),
    approved: false,
  },
  {
    id: "v_fixture_order_2",
    model_id: ORDER_MODEL_ID,
    session_id: "fixtures",
    number: 2,
    parent_id: "v_fixture_order_1",
    spec: ORDER_FIXED_SPEC,
    spec_hash: computeSpecHash(ORDER_FIXED_SPEC),
    approved: true,
  },
];

export const TLC_ORDER_BUG_RESULT = acceptance.order_bug as VerificationResult;
export const TLC_ORDER_FIXED_RESULT =
  acceptance.order_fixed as VerificationResult;
export const TLC_ACCEPTANCE_PROVENANCE = acceptance._provenance;
