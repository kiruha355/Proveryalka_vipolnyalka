import type { BehavioralModel, Property, Source } from "../contracts/model";

type LooseProperty = Omit<Property, "origin" | "approved_by"> &
  Partial<Pick<Property, "origin" | "approved_by">>;
type LooseSource = Omit<Source, "kind"> & Partial<Pick<Source, "kind">>;
export type LooseBehavioralModel = Omit<
  BehavioralModel,
  "properties" | "sources"
> & {
  properties: LooseProperty[];
  sources: LooseSource[];
};

/**
 * Заполняет значения по умолчанию так же, как Pydantic при model_validate:
 * Property.origin = "requirement", Property.approved_by = null, Source.kind = "text".
 * Сервер возвращает модель уже в такой форме; нормализация нужна для
 * входных JSON (эталоны backend) и для расчёта spec_hash на клиенте.
 */
export function normalizeSpec(spec: LooseBehavioralModel): BehavioralModel {
  return {
    ...spec,
    sources: spec.sources.map((source) => ({
      ...source,
      kind: source.kind ?? "text",
    })),
    properties: spec.properties.map((property) => ({
      ...property,
      origin: property.origin ?? "requirement",
      approved_by: property.approved_by ?? null,
    })),
  };
}
