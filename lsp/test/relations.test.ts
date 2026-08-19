import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DreamLanguageService } from '../src/analyzer.js';
import { exploreWorkspace, findReferencesBySymbol } from '../src/relations.js';

const wasmPath = resolve(import.meta.dir, '../../tree-sitter-dream.wasm');
let service: DreamLanguageService;
let projectRoot: string | undefined;

beforeAll(async () => {
  service = await DreamLanguageService.create(wasmPath);
});

afterEach(() => {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  projectRoot = undefined;
});

describe('workspace relations', () => {
  it('uses indexes and aggregates references by symbol', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dream-relations-'));
    const source = [
      'from bootstrap_io import read_text_file',
      '',
      'def read_source(path: str) -> str:',
      '    let source = read_text_file(path)',
      '    return source',
      '',
      'def main(path: str) -> str:',
      '    return read_source(path)',
      '',
    ].join('\n');
    const filePath = join(projectRoot, 'main.dm');
    writeFileSync(filePath, source);

    const result = await exploreWorkspace(service, projectRoot);
    const readSource = result.symbols.find((symbol) => symbol[1] === 'read_source');

    expect(result.schemaVersion).toBe(3);
    expect(result.level).toBe('summary');
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual(['main.dm', 0]);
    expect(result.symbols).toEqual(expect.arrayContaining([
      expect.arrayContaining([0, 'read_source']),
    ]));
    expect(readSource?.[5]).toBe(1);
    expect(result.symbols.some((symbol) => symbol[1] === 'source')).toBe(false);
    expect(result.references).toBeUndefined();
    expect(result.imports).toEqual([
      [0, 0, 0, 'bootstrap_io', 'read_text_file'],
    ]);
    expect(JSON.stringify(result)).not.toContain('"relations"');

    const fullResult = await exploreWorkspace(service, projectRoot, {
      level: 'full',
      maxSymbols: 100,
    });
    expect(fullResult.level).toBe('full');
    expect(fullResult.symbols.some((symbol) => symbol[1] === 'source')).toBe(true);
  });

  it('limits optional reference positions', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dream-relations-'));
    writeFileSync(join(projectRoot, 'main.dm'), [
      'def value():',
      '    return 1',
      '',
      'def main():',
      '    return value()',
      '',
    ].join('\n'));

    const result = await exploreWorkspace(service, projectRoot, {
      includeReferences: true,
      maxReferences: 0,
    });

    expect(result.references).toEqual({});
    expect(result.truncatedReferences).toBeGreaterThan(0);
  });

  it('searches symbol references case-insensitively', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dream-relations-'));
    writeFileSync(join(projectRoot, 'main.dm'), [
      'def read_source(path: str) -> str:',
      '    return path',
      '',
      'def main(path: str) -> str:',
      '    return read_source(path)',
      '',
    ].join('\n'));

    const result = await findReferencesBySymbol(service, projectRoot, 'READ_SOURCE');

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.symbol.name).toBe('read_source');
    expect(result.matches[0]?.references).toHaveLength(1);
  });
});
