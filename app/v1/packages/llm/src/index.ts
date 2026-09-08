export { OpenAiCompatClient, type OpenAiCompatConfig } from './client.js'
export {
  DICTATION_CLEANUP_SYSTEM,
  isPlausibleCleanup,
  containsDevanagari,
  type PlausibilityVerdict,
} from './prompts.js'
export {
  LlmError,
  type LlmClient,
  type LlmErrorKind,
  type LlmHealth,
  type LlmRequest,
  type LlmResult,
  type Provider,
  type Scope,
  type ScopeConfig,
} from './types.js'
