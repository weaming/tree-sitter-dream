import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DocumentSymbol, Location, Position, SymbolKind } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DreamLanguageService, DocumentAnalysis } from './analyzer.js';

const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'dist', 'node_modules', 'target', 'tmp']);
const IMPORT_PATTERN = /^\s*(?:from\s+([A-Za-z_][A-Za-z0-9_./]*)\s+)?import\s+(.+?)\s*$/;

export interface WorkspaceFileResult {
  path: string;
  uri: string;
  diagnostics: DocumentAnalysis['diagnostics'];
  symbols: DocumentSymbol[];
}

type ReferenceTuple = [number, number];
type FileTuple = [path: string, diagnosticCount: number];
type SymbolTuple = [
  file: number,
  name: string,
  kind: number,
  startLine: number,
  endLine: number,
  referenceCount: number,
];
type ImportTuple = [
  file: number,
  line: number,
  character: number,
  module: string,
  names?: string,
];

export interface WorkspaceExploreOptions {
  maxFiles?: number;
  level?: 'summary' | 'full';
  maxSymbols?: number;
  includeReferences?: boolean;
  maxReferences?: number;
  file?: string;
}

export interface WorkspaceRelationsResult {
  schemaVersion: 3;
  root: string;
  level: 'summary' | 'full';
  files: FileTuple[];
  symbols: SymbolTuple[];
  imports: ImportTuple[];
  references?: Record<string, ReferenceTuple[]>;
  truncatedSymbols?: number;
  truncatedReferences?: number;
}

export interface SymbolReferenceSearchResult {
  query: string;
  root: string;
  matches: Array<{
    path: string;
    uri: string;
    symbol: DocumentSymbol;
    definition: Location;
    references: Location[];
  }>;
  truncatedMatches?: number;
}

interface LoadedDocument {
  path: string;
  uri: string;
  document: TextDocument;
  analysis: DocumentAnalysis;
}

async function collectDreamFiles(rootPath: string, maxFiles: number): Promise<string[]> {
  const absoluteRoot = resolve(rootPath);
  const rootStats = await stat(absoluteRoot);
  if (rootStats.isFile()) {
    if (extname(absoluteRoot) !== '.dm') return [];
    return [absoluteRoot];
  }

  const filePaths: string[] = [];
  const visitDirectory = async (directoryPath: string): Promise<void> => {
    if (filePaths.length >= maxFiles) return;

    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (filePaths.length >= maxFiles) return;
      if (entry.isDirectory() && !IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        await visitDirectory(resolve(directoryPath, entry.name));
        continue;
      }
      if (entry.isFile() && extname(entry.name) === '.dm') {
        filePaths.push(resolve(directoryPath, entry.name));
      }
    }
  };

  await visitDirectory(absoluteRoot);
  return filePaths;
}

async function loadDocuments(
  languageService: DreamLanguageService,
  rootPath: string,
  maxFiles: number,
): Promise<LoadedDocument[]> {
  const filePaths = await collectDreamFiles(rootPath, maxFiles);
  const documents: LoadedDocument[] = [];

  for (const filePath of filePaths) {
    const uri = pathToFileURL(filePath).href;
    const source = await readFile(filePath, 'utf8');
    const document = TextDocument.create(uri, 'dream', 1, source);
    const analysis = languageService.update(document);
    documents.push({ path: filePath, uri, document, analysis });
  }

  return documents;
}

function toWorkspaceFile(document: LoadedDocument): WorkspaceFileResult {
  return {
    path: document.path,
    uri: document.uri,
    diagnostics: document.analysis.diagnostics,
    symbols: document.analysis.symbols,
  };
}

function collectImportRelations(
  document: LoadedDocument,
  fileId: number,
): ImportTuple[] {
  const imports: ImportTuple[] = [];
  const lines = document.document.getText().split('\n');

  for (const [line, sourceLine] of lines.entries()) {
    const match = sourceLine.match(IMPORT_PATTERN);
    if (!match) continue;

    const moduleName = match[1] ?? match[2];
    const importedNames = match[1] ? match[2] : undefined;
    const character = sourceLine.search(/\S/);
    imports.push(importedNames
      ? [fileId, line, character, moduleName, importedNames]
      : [fileId, line, character, moduleName]);
  }

  return imports;
}

const SUMMARY_CONTAINER_DETAILS = new Set([
  'function',
  'interface method',
  'struct',
  'interface',
  'enum',
]);

export const SYMBOL_KIND_NAMES: Readonly<Record<number, string>> = {
  [SymbolKind.File]: 'File',
  [SymbolKind.Module]: 'Module',
  [SymbolKind.Namespace]: 'Namespace',
  [SymbolKind.Package]: 'Package',
  [SymbolKind.Class]: 'Class',
  [SymbolKind.Method]: 'Method',
  [SymbolKind.Property]: 'Property',
  [SymbolKind.Field]: 'Field',
  [SymbolKind.Constructor]: 'Constructor',
  [SymbolKind.Enum]: 'Enum',
  [SymbolKind.Interface]: 'Interface',
  [SymbolKind.Function]: 'Function',
  [SymbolKind.Variable]: 'Variable',
  [SymbolKind.Constant]: 'Constant',
  [SymbolKind.String]: 'String',
  [SymbolKind.Number]: 'Number',
  [SymbolKind.Boolean]: 'Boolean',
  [SymbolKind.Array]: 'Array',
  [SymbolKind.Object]: 'Object',
  [SymbolKind.Key]: 'Key',
  [SymbolKind.Null]: 'Null',
  [SymbolKind.EnumMember]: 'EnumMember',
  [SymbolKind.Struct]: 'Struct',
  [SymbolKind.Event]: 'Event',
  [SymbolKind.Operator]: 'Operator',
  [SymbolKind.TypeParameter]: 'TypeParameter',
};

function isRangeInside(outer: DocumentSymbol['range'], inner: DocumentSymbol['selectionRange']): boolean {
  const startsBefore = outer.start.line < inner.start.line ||
    (outer.start.line === inner.start.line && outer.start.character <= inner.start.character);
  const endsAfter = outer.end.line > inner.end.line ||
    (outer.end.line === inner.end.line && outer.end.character >= inner.end.character);
  return startsBefore && endsAfter;
}

function getSymbolsForLevel(
  symbols: DocumentSymbol[],
  level: WorkspaceExploreOptions['level'],
): DocumentSymbol[] {
  if (level === 'full') return symbols;

  const containers = symbols.filter((symbol) =>
    SUMMARY_CONTAINER_DETAILS.has(symbol.detail ?? '')
  );
  return symbols.filter((symbol) => !containers.some((container) =>
    container !== symbol && isRangeInside(container.range, symbol.selectionRange)
  ));
}

function uniqueReferencePositions(references: Location[]): Map<string, ReferenceTuple> {
  const unique = new Map<string, ReferenceTuple>();
  for (const reference of references) {
    const position: ReferenceTuple = [
      reference.range.start.line,
      reference.range.start.character,
    ];
    unique.set(position.join(':'), position);
  }
  return unique;
}

async function collectSymbolIndexes(
  languageService: DreamLanguageService,
  document: LoadedDocument,
  fileId: number,
  sourceSymbols: DocumentSymbol[],
): Promise<{
  symbols: SymbolTuple[];
  symbolSources: Array<{ document: LoadedDocument; symbol: DocumentSymbol }>;
}> {
  const symbols: SymbolTuple[] = [];
  const symbolSources: Array<{ document: LoadedDocument; symbol: DocumentSymbol }> = [];

  for (const symbol of sourceSymbols) {
    const referenceCount = uniqueReferencePositions(
      languageService.references(document.uri, symbol.selectionRange.start, false),
    ).size;

    symbols.push([
      fileId,
      symbol.name,
      symbol.kind,
      symbol.selectionRange.start.line,
      symbol.range.end.line,
      referenceCount,
    ]);
    symbolSources.push({ document, symbol });
  }

  return { symbols, symbolSources };
}

// 只对最终输出的符号收集引用位置,引用预算不会浪费在未选中的符号上
async function collectSelectedReferences(
  languageService: DreamLanguageService,
  targets: Array<{ document: LoadedDocument; symbol: DocumentSymbol }>,
  maxReferences: number,
): Promise<{ references: Record<string, ReferenceTuple[]>; truncatedReferences: number }> {
  const references: Record<string, ReferenceTuple[]> = {};
  let remainingReferences = maxReferences;
  let truncatedReferences = 0;

  for (const [symbolIndex, target] of targets.entries()) {
    const referenceList = [
      ...uniqueReferencePositions(
        languageService.references(target.document.uri, target.symbol.selectionRange.start, false),
      ).values(),
    ];
    const selectedReferences = referenceList.slice(0, remainingReferences);
    if (selectedReferences.length > 0) references[String(symbolIndex)] = selectedReferences;
    remainingReferences -= selectedReferences.length;
    truncatedReferences += referenceList.length - selectedReferences.length;
  }

  return { references, truncatedReferences };
}

function getDisplayPath(root: string, filePath: string): string {
  const basePath = extname(root).toLowerCase() === '.dm' ? dirname(root) : root;
  return relative(basePath, filePath).split('/').join('/');
}

export async function exploreWorkspace(
  languageService: DreamLanguageService,
  rootPath: string,
  options: WorkspaceExploreOptions = {},
): Promise<WorkspaceRelationsResult> {
  const root = resolve(rootPath);
  const maxFiles = options.maxFiles ?? 500;
  const level = options.level ?? 'summary';
  const maxSymbols = options.maxSymbols ?? 30;
  const includeReferences = options.includeReferences === true;
  const maxReferences = options.maxReferences ?? 10_000;
  const documents = await loadDocuments(languageService, root, maxFiles);
  const files: FileTuple[] = documents.map((document) => [
    getDisplayPath(root, document.path),
    document.analysis.diagnostics.length,
  ]);
  const symbols: SymbolTuple[] = [];
  const imports: ImportTuple[] = [];
  const symbolSources: Array<{ document: LoadedDocument; symbol: DocumentSymbol }> = [];

  for (const [fileId, document] of documents.entries()) {
    imports.push(...collectImportRelations(document, fileId));
    const availableSymbols = getSymbolsForLevel(document.analysis.symbols, level);
    const collected = await collectSymbolIndexes(
      languageService,
      document,
      fileId,
      availableSymbols,
    );
    symbols.push(...collected.symbols);
    symbolSources.push(...collected.symbolSources);
  }

  let truncatedSymbols = 0;

  if (options.file) {
    const candidates = [
      resolve(options.file),
      resolve(root, options.file),
    ];
    const matchingFileId = documents.findIndex(
      (doc) => candidates.includes(doc.path),
    );

    if (matchingFileId !== -1) {
      const filteredSymbols = symbols
        .filter((symbol) => symbol[0] === matchingFileId)
        .map((symbol): SymbolTuple => [0, symbol[1], symbol[2], symbol[3], symbol[4], symbol[5]]);
      const filteredImports = imports
        .filter((entry) => entry[0] === matchingFileId)
        .map((entry): ImportTuple => [0, entry[1], entry[2], entry[3], entry[4]]);
      const filteredFiles: FileTuple[] = [files[matchingFileId]!];

      let references: Record<string, ReferenceTuple[]> = {};
      let truncatedReferences = 0;
      if (includeReferences) {
        const fileSources = symbolSources.filter(
          (source) => source.document.path === documents[matchingFileId]!.path,
        );
        const collectedRefs = await collectSelectedReferences(
          languageService,
          fileSources,
          maxReferences,
        );
        references = collectedRefs.references;
        truncatedReferences = collectedRefs.truncatedReferences;
      }

      return {
        schemaVersion: 3,
        root,
        level,
        files: filteredFiles,
        symbols: filteredSymbols,
        imports: filteredImports,
        ...(includeReferences ? { references } : {}),
        ...(truncatedReferences > 0 ? { truncatedReferences } : {}),
      };
    }

    return {
      schemaVersion: 3,
      root,
      level,
      files: [],
      symbols: [],
      imports: [],
    };
  }

  const indexed = symbols.map((symbol, index) => ({ symbol, index }));
  indexed.sort((left, right) => {
    const leftWeight = left.symbol[2] === SymbolKind.Function ? 2 : 1;
    const rightWeight = right.symbol[2] === SymbolKind.Function ? 2 : 1;
    return (right.symbol[5] * rightWeight) - (left.symbol[5] * leftWeight);
  });

  if (indexed.length > maxSymbols) {
    truncatedSymbols = indexed.length - maxSymbols;
  }

  const selected = indexed.slice(0, maxSymbols);
  const sortedSymbols = selected.map((entry) => entry.symbol);

  let references: Record<string, ReferenceTuple[]> = {};
  let truncatedReferences = 0;
  if (includeReferences) {
    const selectedSources = selected.map((entry) => symbolSources[entry.index]!);
    const collectedRefs = await collectSelectedReferences(
      languageService,
      selectedSources,
      maxReferences,
    );
    references = collectedRefs.references;
    truncatedReferences = collectedRefs.truncatedReferences;
  }

  return {
    schemaVersion: 3,
    root,
    level,
    files,
    symbols: sortedSymbols,
    imports,
    ...(includeReferences ? { references } : {}),
    ...(truncatedSymbols > 0 ? { truncatedSymbols } : {}),
    ...(truncatedReferences > 0 ? { truncatedReferences } : {}),
  };
}

export async function analyzePath(
  languageService: DreamLanguageService,
  filePath: string,
): Promise<WorkspaceFileResult> {
  const documents = await loadDocuments(languageService, filePath, 1);
  const document = documents[0];
  if (!document) throw new Error(`No Dream source file found at ${filePath}`);
  return toWorkspaceFile(document);
}

export async function findReferences(
  languageService: DreamLanguageService,
  filePath: string,
  position: Position,
  includeDeclaration: boolean,
): Promise<{ file: WorkspaceFileResult; definition: Location | null; references: Location[] }> {
  const documents = await loadDocuments(languageService, filePath, 1);
  const document = documents[0];
  if (!document) throw new Error(`No Dream source file found at ${filePath}`);

  const definition = languageService.definition(document.uri, position);
  const references = languageService.references(document.uri, position, includeDeclaration);
  return { file: toWorkspaceFile(document), definition, references };
}

export async function findReferencesBySymbol(
  languageService: DreamLanguageService,
  rootPath: string,
  symbolName: string,
  maxFiles = 500,
  maxMatches = 100,
): Promise<SymbolReferenceSearchResult> {
  const root = resolve(rootPath);
  const documents = await loadDocuments(languageService, root, maxFiles);
  const normalizedName = symbolName.toLocaleLowerCase();
  const matches: SymbolReferenceSearchResult['matches'] = [];
  let truncatedMatches = 0;

  for (const document of documents) {
    for (const symbol of document.analysis.symbols) {
      if (symbol.name.toLocaleLowerCase() !== normalizedName) continue;
      if (matches.length >= maxMatches) {
        truncatedMatches++;
        continue;
      }

      matches.push({
        path: document.path,
        uri: document.uri,
        symbol,
        definition: Location.create(document.uri, symbol.selectionRange),
        references: languageService.references(
          document.uri,
          symbol.selectionRange.start,
          false,
        ),
      });
    }
  }

  return {
    query: symbolName,
    root,
    matches,
    ...(truncatedMatches > 0 ? { truncatedMatches } : {}),
  };
}
