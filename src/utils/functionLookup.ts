import * as path from 'node:path';
import { FunctionBody } from '../changedFunctions';
import { getFunctionBodies, getRepoRoot } from '../state/runtime';

export function normaliseRelativeFilePath(filePath?: string): string {
  if (!filePath) {
    return '';
  }
  const repoRoot = getRepoRoot();
  let normalised = filePath.replace(/\\+/g, '/');
  if (path.isAbsolute(normalised) && repoRoot) {
    normalised = path.relative(repoRoot, normalised);
  }
  if (normalised.startsWith('./')) {
    normalised = normalised.slice(2);
  }
  while (normalised.startsWith('/')) {
    normalised = normalised.slice(1);
  }
  return normalised;
}

export function isTopLevelDisplayName(name?: string | null): boolean {
  if (!name) {
    return false;
  }
  const lower = name.toLowerCase();
  return lower.includes('top-level') || lower.includes('module');
}

export function isTopLevelIdentifier(identifier?: string | null): boolean {
  if (!identifier) {
    return false;
  }
  const lower = identifier.toLowerCase();
  return lower.endsWith('::<top-level>') || lower.endsWith('::<module>');
}

export function ensureTopLevelFunctionIdentifier(filePath?: string): string | undefined {
  const relative = normaliseRelativeFilePath(filePath);
  if (!relative) {
    return undefined;
  }
  const canonicalId = `/${relative}::<module>`;
  const aliases = new Set<string>([
    canonicalId,
    canonicalId.slice(1),
    `/${relative}::<top-level>`,
    `${relative}::<top-level>`,
  ]);
  const bodies = getFunctionBodies();
  let body = bodies[canonicalId] || bodies[canonicalId.slice(1)];
  if (!body) {
    body = {
      id: canonicalId,
      file: relative,
      line: 1,
      body: '',
    } satisfies FunctionBody;
  }
  for (const alias of aliases) {
    if (alias && !bodies[alias]) {
      bodies[alias] = body;
    }
  }
  return canonicalId;
}

export function extractDisplayNameFromId(identifier: string, fallback: string): string {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return fallback;
  }
  const withoutPrefix = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  const parts = withoutPrefix.split('::');
  if (parts.length > 1) {
    const candidate = parts[parts.length - 1].trim();
    if (candidate.length > 0) {
      return candidate;
    }
  }
  const lastSlash = withoutPrefix.lastIndexOf('/');
  if (lastSlash >= 0 && lastSlash < withoutPrefix.length - 1) {
    const candidate = withoutPrefix.slice(lastSlash + 1);
    if (candidate.length > 0) {
      return candidate;
    }
  }
  return withoutPrefix || fallback;
}

export function resolveFunctionBody(identifier: string): FunctionBody | undefined {
  if (!identifier || identifier.trim().length === 0) {
    return undefined;
  }

  const bodies = getFunctionBodies();
  const candidates = buildIdentifierCandidates(identifier);
  for (const candidate of candidates) {
    const match = bodies[candidate];
    if (match) {
      return match;
    }
  }

  const normalisedTarget = normaliseIdentifier(identifier);
  if (!normalisedTarget) {
    return undefined;
  }

  for (const [key, body] of Object.entries(bodies)) {
    if (normaliseIdentifier(key) === normalisedTarget) {
      return body;
    }
  }

  return undefined;
}

export function buildIdentifierCandidates(identifier: string): string[] {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return [];
  }

  const candidates = new Set<string>();
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  const withoutDotSlash = withoutSlash.startsWith('./') ? withoutSlash.slice(2) : withoutSlash;

  candidates.add(trimmed);
  candidates.add(withSlash);
  candidates.add(withoutSlash);
  candidates.add(withoutDotSlash);

  return Array.from(candidates);
}

export function normaliseIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return '';
  }
  const withoutPrefix = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  const [file, func = ''] = withoutPrefix.split('::');
  const normalisedFile = file.replace(/\\+/g, '/').replace(/^\.\//, '');
  return `${normalisedFile}::${func}`.toLowerCase();
}
