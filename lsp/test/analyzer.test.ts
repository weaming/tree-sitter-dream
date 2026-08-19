import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
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
    const document = TextDocument.create(invalidUri, 'dream', 1, 'def broken(:\n');

    const analysis = service.update(document);

    expect(analysis.diagnostics.length).toBeGreaterThan(0);
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
  });
});
