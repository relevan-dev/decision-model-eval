import { z } from "zod";

// The index mapping format the eval reads, and the phonetic config it writes.
//
// This is a small, self-contained copy of the mapping format from Relevan's
// search service, taken on 2026-09-24. It is here so the eval runs with no
// other package. It does not follow later changes to that service.

/** What a field is for. */
export type FieldUse =
  | "searchable"
  | "filterable"
  | "sortable"
  | "aggregatable"
  | "autocompletable"
  | "highlightable";

export type FieldKind = "text" | "id" | "number" | "date" | "boolean" | "object" | "array";

/**
 * Language whose stemmer the text analyzer applies. "none" suits content that
 * stemming hurts, such as codes and names.
 */
export type FieldLanguage = "english" | "none";

/** Applies when neither the field nor the mapping names a language. */
export const DEFAULT_LANGUAGE: FieldLanguage = "english";

export interface FieldMapping {
  /** Query capabilities the field needs. */
  use: readonly FieldUse[];
  /** Declared type. A field with no kind is text. */
  kind?: FieldKind;
  /** Overrides the mapping language for this field. */
  language?: FieldLanguage;
}

export interface IndexMapping {
  fields: Record<string, FieldMapping>;
  /** Language for every text field that does not name its own. */
  language?: FieldLanguage;
}

export const indexMappingSchema = z.object({
  fields: z.record(
    z.string(),
    z.object({
      use: z.array(
        z.enum([
          "searchable",
          "filterable",
          "sortable",
          "aggregatable",
          "autocompletable",
          "highlightable",
        ] satisfies readonly FieldUse[]),
      ),
      kind: z
        .enum([
          "text",
          "id",
          "number",
          "date",
          "boolean",
          "object",
          "array",
        ] satisfies readonly FieldKind[])
        .optional(),
      language: z.enum(["english", "none"] satisfies readonly FieldLanguage[]).optional(),
    }),
  ),
  language: z.enum(["english", "none"] satisfies readonly FieldLanguage[]).optional(),
}) satisfies z.ZodType<IndexMapping>;

/** Resolves the language for one field: field first, then mapping, then the default. */
export function fieldLanguage(mapping: IndexMapping, field: FieldMapping): FieldLanguage {
  return field.language ?? mapping.language ?? DEFAULT_LANGUAGE;
}

/**
 * Encoders from OpenSearch's `analysis-phonetic` plugin that suit name
 * matching. `double_metaphone` is the default.
 */
export const PHONETIC_ENCODERS = ["double_metaphone", "metaphone", "soundex"] as const;

export type PhoneticEncoder = (typeof PHONETIC_ENCODERS)[number];

/**
 * The phonetic config for one index: which fields get a `.phonetic` subfield,
 * and which encoder each one uses. A field that is absent gets no subfield.
 */
export interface PhoneticConfig {
  fields: Record<string, { encoder: PhoneticEncoder }>;
}

export const phoneticConfigSchema = z.object({
  fields: z.record(z.string(), z.object({ encoder: z.enum(PHONETIC_ENCODERS) })),
}) satisfies z.ZodType<PhoneticConfig>;
