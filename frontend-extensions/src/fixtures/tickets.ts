import type { BehavioralModel } from "../contracts/model";
import { normalizeSpec } from "../dsl/normalize";
import type { LooseBehavioralModel } from "../dsl/normalize";
import tickets from "./models/tickets.json";

/** Эталон backend tests/fixtures/models/tickets.json: enum, integer и boolean, все виды свойств. */
export const TICKETS_SPEC: BehavioralModel = normalizeSpec(
  tickets as LooseBehavioralModel,
);
