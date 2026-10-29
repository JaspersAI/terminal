// What a plugin and a view import, as `@jaspers-ai/sdk`. The app provides this module to every
// plugin at run time, and its own built-in views import it by the same name.

export {
  BridgeProvider,
  PanelProvider,
  useBridge,
  usePanel,
  type Bridge,
  type PanelRef,
  type RunOptions,
} from './bridge.ts'
export {
  defineConnection,
  definePlugin,
  defineSource,
  defineView,
  isMcpSource,
  type BackendContext,
  type Capability,
  type ConnectionDef,
  type ConnectionSpec,
  type FileEntry,
  type Files,
  type FunctionSourceSpec,
  type Jobs,
  type Live,
  type Llm,
  type LlmRequest,
  type ToolEntry,
  type Tools,
  type McpSourceSpec,
  type PluginDefinition,
  type SecretSpec,
  type SourceContext,
  type SourceDef,
  type State,
  type ViewDefinition,
  type ViewSpec,
  type Web,
  type WebPage,
  type WebResult,
} from './define.ts'
export {
  ACTIVATE_SKILL,
  READ_SKILL_FILE,
  alreadyLoaded,
  expandArguments,
  isSkillScript,
  runSkillTool,
  skillLoaded,
  skillsPrompt,
  skillTools,
  wrapSkill,
  type SkillEntry,
  type SkillFilePart,
  type Skills,
} from './skills.ts'
export {
  useData,
  useDictation,
  usePanelState,
  usePublish,
  usePublishText,
  type Dictation,
  type DictationState,
  type SourceData,
} from './hooks.ts'
export type { Dataset, RunResult } from './datasets.ts'
export type { QueryResult } from './query.ts'
export type { Citation, Completion, ToolCall, ToolDefinition, ToolResult, Turn } from './llm.ts'
