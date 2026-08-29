import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DreamLanguageService } from '../src/analyzer.js';

const documentUri = 'file:///workspace/main.dm';
const wasmPath = resolve(import.meta.dir, '../../tree-sitter-dream.wasm');
const source = `from bootstrap_io import read_text_file

const BASE: int = 3

struct Point:
    x: int
    y: int

def read_source(path: str) -> str:
    let source = read_text_file(path)
    return source

def main():
    let point = Point{x: BASE, y: 2}
    print(read_source("compiler.dm"))
`;

let service: DreamLanguageService;

beforeAll(async () => {
  service = await DreamLanguageService.create(wasmPath);
  service.update(TextDocument.create(documentUri, 'dream', 1, source));
});

afterAll(() => service.dispose());

describe('Dream language service', () => {
  it('parses valid source and exposes document symbols', () => {
    const analysis = service.getAnalysis(documentUri);

    expect(analysis?.diagnostics).toEqual([]);
    expect(analysis?.symbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(['BASE', 'Point', 'read_source', 'path', 'main']),
    );
  });

  it('reports syntax diagnostics', () => {
    const invalidUri = 'file:///workspace/invalid.dm';
    const invalidSource = [
      'def broken()',
      '    let value = (1 + )',
      '',
      'def after():',
      '    return 2',
      '',
    ].join('\n');
    const document = TextDocument.create(invalidUri, 'dream', 1, invalidSource);

    const analysis = service.update(document);

    expect(analysis.diagnostics.length).toBeGreaterThan(0);
    expect(analysis.diagnostics.some((diagnostic) => diagnostic.range.start.line === 1)).toBe(true);
    expect(analysis.diagnostics.every((diagnostic) =>
      diagnostic.range.start.line === diagnostic.range.end.line)).toBe(true);
    service.remove(invalidUri);
  });

  it('supports definition, references, hover, rename, and completion', () => {
    const line = source.split('\n').findIndex((value) => value.includes('read_source("compiler.dm")'));
    const character = source.split('\n')[line].indexOf('read_source') + 2;
    const position = { line, character };

    const definition = service.definition(documentUri, position);
    const references = service.references(documentUri, position, true);
    const hover = service.hover(documentUri, position);
    const rename = service.rename(documentUri, position, 'load_source');
    const completion = service.completion(documentUri, position);

    expect(definition?.range.start.line).toBe(8);
    expect(references.length).toBeGreaterThanOrEqual(2);
    expect(hover?.contents).toEqual({ kind: 'markdown', value: '**read_source**  \nfunction' });
    expect(rename?.changes?.[documentUri]).toHaveLength(2);
    expect(completion.map((item) => item.label)).toContain('read_source');

    const definitionPosition = {
      line: 8,
      character: source.split('\n')[8].indexOf('read_source') + 2,
    };
    const definitionReferences = service.references(documentUri, definitionPosition, true);
    const definitionRename = service.rename(documentUri, definitionPosition, 'load_source');

    expect(definitionReferences).toHaveLength(2);
    expect(definitionRename?.changes?.[documentUri]).toHaveLength(2);
  });

  it('jumps to the field belonging to the receiver type', () => {
    const fieldUri = 'file:///workspace/fields.dm';
    const fieldSource = [
      'struct Left:',
      '    value: int',
      '',
      'struct Right:',
      '    value: int',
      '',
      'def read(left: Left, right: Right) -> int:',
      '    return left.value + right.value',
      '',
    ].join('\n');
    service.update(TextDocument.create(fieldUri, 'dream', 1, fieldSource));

    try {
      const usageLine = fieldSource.split('\n')[7];
      const leftPosition = {
        line: 7,
        character: usageLine.indexOf('left.value') + 'left.'.length + 1,
      };
      const rightPosition = {
        line: 7,
        character: usageLine.indexOf('right.value') + 'right.'.length + 1,
      };

      expect(service.definition(fieldUri, leftPosition)?.range.start.line).toBe(1);
      expect(service.definition(fieldUri, rightPosition)?.range.start.line).toBe(4);
    } finally {
      service.remove(fieldUri);
    }
  });

  it('keeps methods and same-named global functions separate', () => {
    const methodUri = 'file:///workspace/methods.dm';
    const methodSource = [
      'def as_str(value: Value) -> str:',
      '    return ""',
      '',
      'struct Value:',
      '    def get(self) -> Value:',
      '        return self',
      '',
      '    def as_str(self) -> str:',
      '        return as_str(self)',
      '',
      'def use(value: Value) -> str:',
      '    return value.get().as_str()',
      '',
    ].join('\n');
    service.update(TextDocument.create(methodUri, 'dream', 1, methodSource));

    try {
      const globalCallPosition = {
        line: 8,
        character: methodSource.split('\n')[8].indexOf('as_str') + 2,
      };
      const methodDefinitionPosition = {
        line: 7,
        character: methodSource.split('\n')[7].indexOf('as_str') + 2,
      };
      const methodCallPosition = {
        line: 11,
        character: methodSource.split('\n')[11].indexOf('as_str') + 2,
      };

      expect(service.definition(methodUri, globalCallPosition)?.range.start.line).toBe(0);
      expect(service.definition(methodUri, methodCallPosition)?.range.start.line).toBe(7);

      const globalReferences = service.references(methodUri, globalCallPosition, true);
      const methodReferences = service.references(methodUri, methodDefinitionPosition, true);
      expect(globalReferences.map((location) => location.range.start.line)).toEqual([0, 8]);
      expect(methodReferences.map((location) => location.range.start.line)).toEqual([7, 11]);

      expect(service.rename(methodUri, globalCallPosition, 'to_text')?.changes?.[methodUri])
        .toHaveLength(2);
      expect(service.rename(methodUri, methodCallPosition, 'to_text')?.changes?.[methodUri])
        .toHaveLength(2);
    } finally {
      service.remove(methodUri);
    }
  });

  it('keeps definitions isolated by function and block scopes', () => {
    const scopeUri = 'file:///workspace/scopes.dm';
    const scopeSource = [
      'let value = 0',
      '',
      'def first():',
      '    let value = 1',
      '    if True:',
      '        let value = 2',
      '        print(value)',
      '    return value',
      '',
      'def second():',
      '    let value = 3',
      '    return value',
      '',
    ].join('\n');
    service.update(TextDocument.create(scopeUri, 'dream', 1, scopeSource));

    try {
      const innerDefinition = service.definition(scopeUri, {
        line: 6,
        character: scopeSource.split('\n')[6].indexOf('value') + 1,
      });
      const firstReturnDefinition = service.definition(scopeUri, {
        line: 7,
        character: scopeSource.split('\n')[7].indexOf('value') + 1,
      });
      const secondReturnDefinition = service.definition(scopeUri, {
        line: 11,
        character: scopeSource.split('\n')[11].indexOf('value') + 1,
      });
      const rename = service.rename(scopeUri, {
        line: 7,
        character: scopeSource.split('\n')[7].indexOf('value') + 1,
      }, 'firstValue');

      expect(innerDefinition?.range.start.line).toBe(5);
      expect(firstReturnDefinition?.range.start.line).toBe(3);
      expect(secondReturnDefinition?.range.start.line).toBe(10);
      expect(rename?.changes?.[scopeUri]).toHaveLength(2);
    } finally {
      service.remove(scopeUri);
    }
  });

  it('completes syntax added by the current grammar', () => {
    const completion = service.completion(documentUri, { line: 1, character: 0 });
    const labels = completion.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining([
      'async',
      'await',
      'break',
      'continue',
      'eprint',
      'extends',
      'lambda',
      'of',
      'with',
    ]));
  });

  it('jumps to and finds references across imported files', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'dream-lsp-'));
    const libraryPath = join(workspaceRoot, 'library.dm');
    const mainPath = join(workspaceRoot, 'main.dm');
    const libraryUri = pathToFileURL(libraryPath).href;
    const mainUri = pathToFileURL(mainPath).href;

    writeFileSync(libraryPath, [
      'def read_source(path: str) -> str:',
      '    return path',
      '',
    ].join('\n'));
    const mainSource = [
      'from library import read_source as load_source',
      '',
      'def main(path: str) -> str:',
      '    return load_source(path)',
      '',
    ].join('\n');
    writeFileSync(mainPath, mainSource);

    const workspaceService = await DreamLanguageService.create(wasmPath);
    try {
      await workspaceService.loadWorkspace([workspaceRoot]);
      const usageLine = mainSource.split('\n').findIndex((line) => line.includes('return load_source'));
      const usageCharacter = mainSource.split('\n')[usageLine].indexOf('load_source') + 2;
      const importLine = mainSource.split('\n')[0];

      const definition = workspaceService.definition(mainUri, {
        line: usageLine,
        character: usageCharacter,
      });
      const importedDefinition = workspaceService.definition(mainUri, {
        line: 0,
        character: importLine.indexOf('load_source') + 2,
      });
      const moduleDefinition = workspaceService.definition(mainUri, {
        line: 0,
        character: importLine.indexOf('library') + 1,
      });
      const references = workspaceService.references(mainUri, {
        line: usageLine,
        character: usageCharacter,
      }, true);

      expect(definition?.uri).toBe(libraryUri);
      expect(definition?.range.start.line).toBe(0);
      expect(importedDefinition?.uri).toBe(libraryUri);
      expect(importedDefinition?.range.start.line).toBe(0);
      expect(moduleDefinition).toEqual({
        uri: libraryUri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      });
      expect(references).toEqual(expect.arrayContaining([
        expect.objectContaining({ uri: libraryUri }),
        expect.objectContaining({ uri: mainUri }),
      ]));
      expect(references).toHaveLength(4);
    } finally {
      workspaceService.dispose();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('resolves unique modules in nested workspace directories', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'dream-lsp-nested-'));
    const libraryPath = join(workspaceRoot, 'runtime', 'stdlib', 'library.dm');
    const mainPath = join(workspaceRoot, 'bootstrap', 'main.dm');
    const libraryUri = pathToFileURL(libraryPath).href;
    const mainUri = pathToFileURL(mainPath).href;
    const mainSource = [
      'from library import read_source',
      '',
      'def main() -> str:',
      '    return read_source()',
      '',
    ].join('\n');

    mkdirSync(join(workspaceRoot, 'runtime', 'stdlib'), { recursive: true });
    mkdirSync(join(workspaceRoot, 'bootstrap'), { recursive: true });
    writeFileSync(libraryPath, 'def read_source() -> str:\n    return "source"\n');
    writeFileSync(mainPath, mainSource);

    const workspaceService = await DreamLanguageService.create(wasmPath);
    try {
      await workspaceService.loadWorkspace([workspaceRoot]);
      const definitionPosition = { line: 0, character: 26 };
      const usagePosition = { line: 3, character: 18 };

      expect(workspaceService.definition(mainUri, usagePosition)?.uri).toBe(libraryUri);
      expect(workspaceService.definition(libraryUri, { line: 0, character: 7 })?.uri).toBe(libraryUri);
      expect(workspaceService.references(libraryUri, { line: 0, character: 7 }, true)).toHaveLength(3);
      const rename = workspaceService.rename(mainUri, definitionPosition, 'load_source');
      expect(rename?.changes?.[libraryUri]).toHaveLength(1);
      expect(rename?.changes?.[mainUri]).toHaveLength(2);
    } finally {
      workspaceService.dispose();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('jumps to imported structure fields', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'dream-lsp-fields-'));
    const libraryPath = join(workspaceRoot, 'library.dm');
    const mainPath = join(workspaceRoot, 'main.dm');
    const libraryUri = pathToFileURL(libraryPath).href;
    const mainUri = pathToFileURL(mainPath).href;

    writeFileSync(libraryPath, [
      'struct Left:',
      '    value: int',
      '',
      'struct Right:',
      '    value: int',
      '',
    ].join('\n'));
    const mainSource = [
      'from library import Left, Right',
      '',
      'def read(left: Left, right: Right) -> int:',
      '    return left.value + right.value',
      '',
    ].join('\n');
    writeFileSync(mainPath, mainSource);

    const workspaceService = await DreamLanguageService.create(wasmPath);
    try {
      await workspaceService.loadWorkspace([workspaceRoot]);
      const usageLine = mainSource.split('\n')[3];

      const leftDefinition = workspaceService.definition(mainUri, {
        line: 3,
        character: usageLine.indexOf('left.value') + 'left.'.length + 1,
      });
      const rightDefinition = workspaceService.definition(mainUri, {
        line: 3,
        character: usageLine.indexOf('right.value') + 'right.'.length + 1,
      });

      expect(leftDefinition?.uri).toBe(libraryUri);
      expect(leftDefinition?.range.start.line).toBe(1);
      expect(rightDefinition?.uri).toBe(libraryUri);
      expect(rightDefinition?.range.start.line).toBe(4);
    } finally {
      workspaceService.dispose();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
