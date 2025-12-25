import { NormalisedCallArgs, TraceCallArgs } from '../types';
import { getStoredCallArgsMap } from './runtime';

export const DEFAULT_PARENT_CALL_ARGS: NormalisedCallArgs = {
  args: [],
  kwargs: {},
};

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

export function hasCallArgs(args?: NormalisedCallArgs): boolean {
  if (!args) {
    return false;
  }
  const hasArgsArray = Array.isArray(args.args) && args.args.length > 0;
  const hasKwargs = args.kwargs && Object.keys(args.kwargs).length > 0;
  return Boolean(hasArgsArray || hasKwargs);
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
  return Array.from(new Set<string>([withSlash, withoutSlash]));
}

export function getStoredCallArgs(functionId: string): NormalisedCallArgs | undefined {
  const keys = buildStorageKeys(functionId);
  const store = getStoredCallArgsMap();
  for (const key of keys) {
    const value = store.get(key);
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
  const store = getStoredCallArgsMap();
  for (const key of keys) {
    store.set(key, cloneCallArgs(args));
  }
}

export function clearStoredCallArgs(functionId: string): void {
  const keys = buildStorageKeys(functionId);
  const store = getStoredCallArgsMap();
  for (const key of keys) {
    store.delete(key);
  }
}

export function getArgsContextKey(functionId: string, args: NormalisedCallArgs): string {
  return `${functionId}::${JSON.stringify(args)}`;
}
