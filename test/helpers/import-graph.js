import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const toPosix = (value) => value.split(path.sep).join('/');

export function staticSpecifiers(source) {
  const specifiers = new Set();
  const withFrom = /\b(?:import|export)\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const bareImport = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const pattern of [withFrom, bareImport]) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

const resolveRelative = (fromModule, specifier, root) => {
  if (!specifier.startsWith('.')) {
    return null;
  }
  let resolved = path.resolve(root, path.dirname(fromModule), specifier);
  if (!existsSync(resolved) && path.extname(resolved) === '') {
    resolved = `${resolved}.js`;
  }
  if (path.extname(resolved) !== '.js') {
    return null;
  }
  return toPosix(path.relative(root, resolved));
};

export function walkImportGraph({ root, entries, read = readFileSync }) {
  const reachable = new Set();
  const pending = entries.map(toPosix);
  while (pending.length > 0) {
    const modulePath = pending.shift();
    if (reachable.has(modulePath) || path.extname(modulePath) !== '.js') {
      continue;
    }
    reachable.add(modulePath);
    const source = read(path.resolve(root, modulePath), 'utf8');
    for (const specifier of staticSpecifiers(source)) {
      const resolved = resolveRelative(modulePath, specifier, root);
      if (resolved !== null && !reachable.has(resolved)) {
        pending.push(resolved);
      }
    }
  }
  return [...reachable].sort();
}

export function findUnlistedModules({ root, entries, listed, read = readFileSync }) {
  const allowed = new Set(listed.map(toPosix));
  return walkImportGraph({ root, entries, read }).filter((modulePath) => !allowed.has(modulePath));
}