import { FunctionBody } from './changedFunctions';

export interface LinearFlowEvent {
  flow: string;
  entry_full_id: string;
  args_key: string;
  linear_index: number;
  function?: string;
  line?: number;
  file?: string;
  location?: string;
  locals?: Record<string, unknown>;
  globals?: Record<string, unknown>;
  event: string;
}

export interface TracerEvent {
  event: string;
  filename?: string;
  function?: string;
  line?: number;
  locals?: Record<string, unknown>;
  globals?: Record<string, unknown>;
  error?: string;
  traceback?: string;
  flow?: string;
  entry_full_id?: string;
  args_key?: string;
  target_location?: string;
  requested_line?: number;
  requested_function?: string;
  linear_index?: number;
  events?: LinearFlowEvent[];
  last_served_index?: number;
}

export interface TraceCallArgs {
  args?: unknown[];
  kwargs?: Record<string, unknown>;
}

export interface NormalisedCallArgs {
  args: unknown[];
  kwargs: Record<string, unknown>;
}

export interface ExtractCallArgsOptions {
  callingEntryFullId?: string;
  callingArgsJson?: string;
}

export interface FunctionSignatureInfo {
  params: string[];
  param_count: number;
  param_required?: boolean[];
  param_defaults?: Array<unknown | null>;
}

export type ExtractCallArgsResult = TraceCallArgs | { error: string };

export interface FlowTraceRequest {
  flowId: string;
  flowName: string;
  functionName: string;
  line: number;
  location: string;
  filePath?: string;
}

export interface FlowTraceRequestOptions {
  entryFullId: string;
  line: number;
  functionName?: string;
  filePath?: string;
  flowName?: string;
  locationLabel?: string;
}

export interface ExecutionContext {
  locals: Record<string, unknown>;
  globals: Record<string, unknown>;
  file: string;
}

export interface CallSite {
  file: string;
  line: number;
  column: number;
  call_line: string;
  context: string[];
  calling_function: string | null;
  calling_function_id: string | null;
}

export interface ParentContext {
  parentFunctionId: string;
  parentLine: number;
  callLine: number;
  parentCallArgs?: TraceCallArgs;
}

export interface ParentTraceDetails {
  tracer: import('./tracing/tracingService').TracerManager;
  args: NormalisedCallArgs;
  argsJson: string;
  entryFullId: string;
  body: FunctionBody;
  context: ExecutionContext;
}
