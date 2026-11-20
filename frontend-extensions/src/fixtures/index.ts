// Примеры данных для разработки, тестов и демо-режима. Не входят в основной вход пакета,
// чтобы не попадать в сборку приложения без явного импорта.
export {
  ORDER_VERSIONS,
  ORDER_MODEL_ID,
  TLC_ORDER_BUG_RESULT,
  TLC_ORDER_FIXED_RESULT,
  TLC_ACCEPTANCE_PROVENANCE,
} from "./order-versions";
export { TICKETS_SPEC } from "./tickets";

export {
  createRecordedCodegenProvider,
  RECORDED_GENERATION,
  RECORDED_TEST_RUN,
  CODEGEN_VERSION,
  CODEGEN_RECORDING_PROVENANCE,
} from "./codegen";
