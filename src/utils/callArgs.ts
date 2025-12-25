import { NormalisedCallArgs, TraceCallArgs } from '../types';

const storedCallArgs = new Map<string, NormalisedCallArgs>();

export const DEFAULT_PARENT_CALL_ARGS: NormalisedCallArgs = {
  args: [],
  kwargs: {},
};

export function isTraceCallArgs(value: unknown): value is TraceCallArgs {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as TraceCallArgs;
  const argsValid = !('args' in candidate) || Array.isArray(candidate.args);
  const kwargsValid =
    !('kwargs' in candidate) ||
    (typeof candidate.kwargs === 'object' && candidate.kwargs !== null && !Array.isArray(candidate.kwargs));
  return argsValid && kwargsValid;
}

export function normaliseCallArgs(input?: TraceCallArgs): NormalisedCallArgs {
  const args = input && Array.isArray(input.args) ? input.args : [];
  const kwargs =
    input && input.kwargs && typeof input.kwargs === 'object' && !Array.isArray(input.kwargs)
      ? input.kwargs
      : {};
  return {
    args: [...args],
    kwargs: { ...kwargs } as Record<string, unknown>,
  };
}

export function cloneCallArgs(args: NormalisedCallArgs): NormalisedCallArgs {
  return {
    args: [...args.args],
    kwargs: { ...args.kwargs },
  };
}

export function buildStorageKeys(functionId: string): string[] {
  if (!functionId) {
    return [];
  }
  const trimmed = functionId.trim();
  if (!trimmed) {
    return [];
  }
  const normalisedPath = trimmed.replace(/\+/g, '/').replace(/^\.\//, '');
  const withSlash = normalisedPath.startsWith('/') ? normalisedPath : `/${normalisedPath}`;
  const withoutSlash = withSlash.slice(1);
  const unique = new Set<string>([withSlash, withoutSlash]);
  return Array.from(unique);
}

export function getStoredCallArgs(functionId: string): NormalisedCallArgs | undefined {
  const keys = buildStorageKeys(functionId);
  for (const key of keys) {
    const value = storedCallArgs.get(key);
    if (value) {
      return cloneCallArgs(value);
    }
  }
  return undefined;
}

export function setStoredCallArgs(functionId: string, args: NormalisedCallArgs): void {
  const keys = buildStorageKeys(functionId);
  if (!keys.length) {
    return;
  }
  for (const key of keys) {
    storedCallArgs.set(key, cloneCallArgs(args));
  }
}

export function clearStoredCallArgs(functionId: string): void {
  for (const key of buildStorageKeys(functionId)) {
    storedCallArgs.delete(key);
  }
}

export function hasCallArgs(args?: NormalisedCallArgs): boolean {
  if (!args) {
    return false;
  }
  const hasArgsArray = Array.isArray(args.args) && args.args.length > 0;
  const hasKwargs = args.kwargs && Object.keys(args.kwargs).length > 0;
  return Boolean(hasArgsArray || hasKwargs);
}

export function getArgsContextKey(functionId: string, args: NormalisedCallArgs): string {
  return `${functionId}::${JSON.stringify(args)}`;
}
