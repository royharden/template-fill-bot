// Public exports of the pure fillkit core. Content types/records are exported by content/* (and re-exported by
// the browser facade src/core/index.ts); this file deliberately does NOT re-export FIELD_KEYS / FieldKey etc.
// so that `export *` of both never collides. The gate (fillkit/gate/, M4) is exported separately when written.
export * from './canonicalJson.ts';
export * from './hash.ts';
export * from './library.ts';
export * from './normalize.ts';
export * from './cited.ts';
export * from './schema.ts';
export * from './candidates/index.ts';
export {
  ADDRESS_MAX_CODE_POINTS,
  DEFAULT_FIELD_CONTEXT,
  FIELD_SPECS,
  FIELD_SPEC_LIST,
  MAX_MONEY_MINOR,
  MAX_TENANTS,
  NAME_MAX_CODE_POINTS,
  countCodePoints,
  getFieldSpec,
  hasMixedScriptToken,
  normaliseFreeText,
  partyKey,
  validateAddress,
  validateName,
  validateUtilities,
} from './fields.ts';
export type {
  FieldContext,
  FieldFailureReason,
  FieldResult,
  FieldSpec,
  FieldValue,
  JurisdictionLimits,
  QuestionTemplate,
} from './fields.ts';

export * from './grounding.ts';
export * from './validate.ts';
export * from './questions.ts';
export * from './requests.ts';
export * from './select.ts';
export * from './segments.ts';
export * from './renderMarkdown.ts';
export * from './provenance.ts';
export * from './matter.ts';
export {
  buildDraft,
  confirmRequest,
  contextOf,
  deriveView,
  runExtraction,
} from './pipeline.ts';
export type {
  ConfirmRequestOptions,
  ConfirmRequestResult,
  Draft,
  DraftOptions,
  DraftResult,
  MatterView,
  PipelineOptions,
  RunExtractionResult,
} from './pipeline.ts';
export * from './extractors/types.ts';
export * from './extractors/regex.ts';
export * from './extractors/mock.ts';
