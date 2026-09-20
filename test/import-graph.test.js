import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findUnlistedModules, staticSpecifiers, walkImportGraph } from './helpers/import-graph.js';

const roots = [];

const fixture = (files) => {
  const root = mkdtempSync(path.join(tmpdir(), 'fsl-import-graph-'));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return root;
};

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

describe('staticSpecifiers', () => {
  it('reads static imports and re-exports, including multi-line ones', () => {
    const source = [
      "import { one } from './one.js';",
      'import {',
      '  two,',
      "} from './two.js';",
      "export { three } from './three.js';",
      "export * from './four.js';",
      "import './side-effect.js';",
      "const lazy = await import('./dynamic.js');",
      "import 'bare-package';",
    ].join('\n');

    expect(staticSpecifiers(source)).toEqual([
      './one.js',
      './two.js',
      './three.js',
      './four.js',
      './side-effect.js',
      'bare-package',
    ]);
  });
});

describe('walkImportGraph', () => {
  it('follows a chain at least two deep to reach a leaf module', () => {
    const root = fixture({
      'entry.js': ['import {', '  mid,', "} from './mid.js';", 'export const entry = mid;'].join('\n'),
      'mid.js': "import { leaf } from './leaf.js';\nexport const mid = leaf;",
      'leaf.js': 'export const leaf = 1;',
    });

    expect(walkImportGraph({ root, entries: ['entry.js'] })).toEqual(['entry.js', 'leaf.js', 'mid.js']);
  });

  it('terminates on an import cycle and reports the unlisted member', () => {
    const root = fixture({
      'a.js': "import { b } from './b.js';\nexport const a = b;",
      'b.js': "import { a } from './a.js';\nexport const b = a;",
    });

    expect(walkImportGraph({ root, entries: ['a.js'] })).toEqual(['a.js', 'b.js']);
    expect(findUnlistedModules({ root, entries: ['a.js'], listed: ['a.js'] })).toEqual(['b.js']);
  });
});

describe('findUnlistedModules', () => {
  it('reports a module that is neither an entry nor listed, not skipped', () => {
    const root = fixture({
      'entry.js': "import { stray } from './stray.js';\nexport const entry = stray;",
      'stray.js': 'export const stray = 1;',
    });

    expect(findUnlistedModules({ root, entries: ['entry.js'], listed: ['entry.js'] })).toEqual([
      'stray.js',
    ]);
  });

  it('reports a module reached through an intermediate chain that is only listed two deep', () => {
    const root = fixture({
      'entry.js': "import { mid } from './mid.js';\nexport const entry = mid;",
      'mid.js': "import { leaf } from './leaf.js';\nexport const mid = leaf;",
      'leaf.js': 'export const leaf = 1;',
    });

    expect(
      findUnlistedModules({ root, entries: ['entry.js'], listed: ['entry.js', 'mid.js'] }),
    ).toEqual(['leaf.js']);
  });

  it('does not follow dynamic import() or bare package specifiers', () => {
    const root = fixture({
      'entry.js': [
        "export const lazy = () => import('./dynamic.js');",
        "import 'some-package';",
      ].join('\n'),
    });

    expect(findUnlistedModules({ root, entries: ['entry.js'], listed: ['entry.js'] })).toEqual([]);
  });

  it('reports modules reached through a directory relative to the importer', () => {
    const root = fixture({
      'entry.js': "import { util } from './nested/util.js';\nexport const entry = util;",
      'nested/util.js': "import { core } from '../core.js';\nexport const util = core;",
      'core.js': 'export const core = 1;',
    });

    expect(findUnlistedModules({ root, entries: ['entry.js'], listed: ['entry.js'] })).toEqual([
      'core.js',
      'nested/util.js',
    ]);
  });
});