import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectGitignoreExclusions, isIgnored, parseGitignore } from '../scans/gitignore';

test('unanchored gitignore patterns match at any depth', () => {
  const root = parseGitignore('node_modules/\n*.log\n', '');
  assert.equal(isIgnored([root], 'node_modules', true), true);
  assert.equal(isIgnored([root], 'packages/a/node_modules', true), true);
  assert.equal(isIgnored([root], 'packages/a/debug.log', false), true);
});

test('anchored gitignore patterns only match the root of their directory', () => {
  const root = parseGitignore('/dist\npackages/lib/generated\n', '');
  assert.equal(isIgnored([root], 'dist', true), true);
  assert.equal(isIgnored([root], 'apps/dist', true), false);
  assert.equal(isIgnored([root], 'packages/lib/generated', true), true);
  assert.equal(isIgnored([root], 'packages/other/generated', true), false);
});

test('nested gitignore files only apply below their own directory', () => {
  const root = parseGitignore('*.tmp\n', '');
  const nested = parseGitignore('coverage/\n', 'packages/a');
  assert.equal(isIgnored([root, nested], 'packages/a/coverage', true), true);
  assert.equal(isIgnored([root, nested], 'packages/b/coverage', true), false);
});

test('deeper gitignore negations override shallower rules', () => {
  const root = parseGitignore('*.log\n', '');
  const nested = parseGitignore('!keep.log\n', 'packages/a');
  assert.equal(isIgnored([root, nested], 'packages/a/keep.log', false), false);
  assert.equal(isIgnored([root, nested], 'packages/a/other.log', false), true);
  assert.equal(isIgnored([root, nested], 'packages/b/keep.log', false), true);
});

test('the last matching rule in a file wins', () => {
  const root = parseGitignore('*.log\n!important.log\n', '');
  assert.equal(isIgnored([root], 'important.log', false), false);
  assert.equal(isIgnored([root], 'other.log', false), true);
});

test('directory-only rules do not match files with the same name', () => {
  const root = parseGitignore('build/\n', '');
  assert.equal(isIgnored([root], 'build', true), true);
  assert.equal(isIgnored([root], 'build', false), false);
});

test('double-star patterns follow git semantics', () => {
  const root = parseGitignore('docs/**/*.md\ntemp/**\n**/cache/**\n', '');
  assert.equal(isIgnored([root], 'docs/readme.md', false), true);
  assert.equal(isIgnored([root], 'docs/a/b/readme.md', false), true);
  assert.equal(isIgnored([root], 'docs/readme.txt', false), false);
  assert.equal(isIgnored([root], 'temp', true), false);
  assert.equal(isIgnored([root], 'temp/scratch.txt', false), true);
  assert.equal(isIgnored([root], 'a/b/cache/item', false), true);
});

test('escaped markers, character classes and trailing spaces are handled', () => {
  const root = parseGitignore('\\#notes.md\nfile[0-9].txt\nspaced.txt   \n', '');
  assert.equal(isIgnored([root], '#notes.md', false), true);
  assert.equal(isIgnored([root], 'file7.txt', false), true);
  assert.equal(isIgnored([root], 'filex.txt', false), false);
  assert.equal(isIgnored([root], 'spaced.txt', false), true);
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cx-gitignore-'));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  return root;
}

test('walker collects nested gitignore rules and prunes ignored directories', async () => {
  const root = await fixture({
    '.gitignore': 'node_modules/\n',
    'node_modules/a/index.js': '',
    'packages/a/.gitignore': 'coverage/\n',
    'packages/a/coverage/report.html': '',
    'packages/a/src/index.ts': ''
  });
  try {
    const result = await collectGitignoreExclusions(root);
    assert.deepEqual(result.patterns.sort(), ['!node_modules', '!packages/a/coverage']);
    assert.equal(result.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('walker keeps files re-included by a nested gitignore', async () => {
  const root = await fixture({
    '.gitignore': '*.log\n',
    'packages/a/.gitignore': '!keep.log\n',
    'packages/a/keep.log': '',
    'packages/a/other.log': ''
  });
  try {
    const result = await collectGitignoreExclusions(root);
    assert.deepEqual(result.patterns, ['!packages/a/other.log']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('walker cannot re-include files below an ignored directory', async () => {
  const root = await fixture({
    '.gitignore': 'build/\n',
    'build/.gitignore': '!important.txt\n',
    'build/important.txt': ''
  });
  try {
    const result = await collectGitignoreExclusions(root);
    assert.deepEqual(result.patterns, ['!build']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('walker returns no patterns when there is no gitignore', async () => {
  const root = await fixture({ 'src/index.ts': '' });
  try {
    const result = await collectGitignoreExclusions(root);
    assert.deepEqual(result.patterns, []);
    assert.equal(result.ignoredEntries, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('walker reports truncation when the pattern budget is exhausted', async () => {
  const root = await fixture({
    '.gitignore': 'first/\nsecond/\n',
    'first/a.txt': '',
    'second/b.txt': ''
  });
  try {
    const result = await collectGitignoreExclusions(root, { maxPatterns: 1 });
    assert.equal(result.truncated, true);
    assert.deepEqual(result.patterns, ['!first']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});