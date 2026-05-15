import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('repository hygiene', () => {
  it('contains no tracked Nuxt or Vue scaffold files in apps/c2c-studio', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..');
    const trackedFiles = execFileSync('git', ['ls-files', 'apps/c2c-studio'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);

    expect(
      trackedFiles.filter(
        (file) =>
          file.endsWith('.vue') ||
          file.includes('/.nuxt/') ||
          file.includes('/.output/') ||
          /(^|\/)nuxt\.config\./.test(file),
      ),
    ).toEqual([]);
  });
});
