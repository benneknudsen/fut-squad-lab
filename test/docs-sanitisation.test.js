import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const markdownFiles = execFileSync('git', ['ls-files', '*.md'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);

const ACCOUNT_IDENTIFIER_KEYS = [
  'persona(?:[-_]?id)?',
  'utid',
  'user[-_]?id',
  'account[-_]?id',
  'web[-_]?session',
  'sid',
  'device[-_]?id',
  'megasite',
].join('|');

const accountIdentifier = new RegExp(
  `(?:^|[^A-Za-z0-9])(${ACCOUNT_IDENTIFIER_KEYS})[^A-Za-z0-9]+(\\d+)`,
  'gi',
);

const longDigitRun = /[0-9]{6,}/g;

const readLines = (file) => readFileSync(path.join(repoRoot, file), 'utf8').split(/\r?\n/);

const collect = (pattern) =>
  markdownFiles.flatMap((file) =>
    readLines(file).flatMap((line, index) =>
      [...line.matchAll(pattern)].map((match) => ({ file, line: index + 1, text: match[0] })),
    ),
  );

describe('docs-sanitisation.test.js', () => {
  it('Rule A — no tracked markdown file contains an EA account identifier', () => {
    const violations = collect(accountIdentifier).map(
      ({ file, line, text }) =>
        `${file}:${line} contains what looks like an EA account identifier: matched "${text}". Documentation must never carry a real id — write \`PERSONA_ID_REDACTED\` instead. See AGENTS.md hard rule 2.`,
    );

    expect(violations).toEqual([]);
  });

  it('Rule B — no tracked markdown file contains a run of six or more consecutive digits', () => {
    const violations = collect(longDigitRun).map(
      ({ file, line, text }) =>
        `${file}:${line} contains a run of ${text.length} consecutive digits: matched "${text}". Long digit runs are EA persona, squad or item instance identifiers — redact them. See AGENTS.md hard rule 2.`,
    );

    expect(violations).toEqual([]);
  });
});
