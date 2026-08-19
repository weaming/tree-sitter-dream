import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DocumentSymbol, Location, Position, Range } from 'vscode-languageserver/node.js';
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

interface RelationEndpoint {
  path?: string;
  uri?: string;
  name?: string;
  line?: number;
  character?: number;
}

interface CodeRelation {
  kind: 'import' | 'reference';
  from: RelationEndpoint;
  to: RelationEndpoint;
}

export interface WorkspaceRelationsResult {
  root: string;
  files: WorkspaceFileResult[];
  relations: CodeRelation[];
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

function toEndpoint(uri: string, range: Range, name?: string): RelationEndpoint {
  return {
    uri,
    name,
    line: range.start.line,
    character: range.start.character,
  };
}

function collectImportRelations(document: LoadedDocument): CodeRelation[] {
  const relations: CodeRelation[] = [];
  const lines = document.document.getText().split('\n');

  for (const [line, sourceLine] of lines.entries()) {
    const match = sourceLine.match(IMPORT_PATTERN);
    if (!match) continue;

    const moduleName = match[1] ?? match[2];
    const importedNames = match[1] ? match[2] : undefined;
    relations.push({
      kind: 'import',
      from: {
        path: document.path,
        uri: document.uri,
        line,
        character: sourceLine.search(/\S/),
      },
      to: {
        name: importedNames ? `${moduleName}: ${importedNames}` : moduleName,
      },
    });
  }

  return relations;
}

function collectReferenceRelations(
  languageService: DreamLanguageService,
  document: LoadedDocument,
): CodeRelation[] {
  const relations: CodeRelation[] = [];

  for (const symbol of document.analysis.symbols) {
    const references = languageService.references(
      document.uri,
      symbol.selectionRange.start,
      false,
    );
    for (const reference of references) {
      relations.push({
        kind: 'reference',
        from: toEndpoint(document.uri, symbol.selectionRange, symbol.name),
        to: toEndpoint(reference.uri, reference.range, symbol.name),
      });
    }
  }

  return relations;
}

export async function exploreWorkspace(
  languageService: DreamLanguageService,
  rootPath: string,
  maxFiles = 500,
): Promise<WorkspaceRelationsResult> {
  const root = resolve(rootPath);
  const documents = await loadDocuments(languageService, root, maxFiles);
  const relations = documents.flatMap((document) => [
    ...collectImportRelations(document),
    ...collectReferenceRelations(languageService, document),
  ]);

  return {
    root,
    files: documents.map(toWorkspaceFile),
    relations,
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
