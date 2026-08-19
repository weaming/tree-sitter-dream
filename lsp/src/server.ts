#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dreamGrammarWasmPath from '../../tree-sitter-dream.wasm' with { type: 'file' };
import {
  CompletionParams,
  createConnection,
  FoldingRangeParams,
  HoverParams,
  InitializeParams,
  InitializeResult,
  Location,
  ProposedFeatures,
  ReferenceParams,
  RenameParams,
  TextDocumentSyncKind,
  TextDocuments,
  TextDocumentPositionParams,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DreamLanguageService } from './analyzer.js';

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
let languageService: DreamLanguageService | undefined;

function findWasmPath(): string {
  const configuredWasmPath = process.env.DREAM_TREE_SITTER_WASM;
  if (configuredWasmPath && existsSync(configuredWasmPath)) return configuredWasmPath;
  if (dreamGrammarWasmPath) return dreamGrammarWasmPath;

  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(currentDirectory, 'tree-sitter-dream.wasm'),
    join(currentDirectory, '../tree-sitter-dream.wasm'),
    join(currentDirectory, '../../tree-sitter-dream.wasm'),
    resolve(process.cwd(), 'tree-sitter-dream.wasm'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const wasmPath = candidates.find((candidate) => existsSync(candidate));
  if (!wasmPath) {
    throw new Error(
      'Cannot find tree-sitter-dream.wasm. Build the WASM parser or set DREAM_TREE_SITTER_WASM.',
    );
  }
  return wasmPath;
}

function publishDiagnostics(document: TextDocument): void {
  if (!languageService) return;

  try {
    const analysis = languageService.update(document);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: analysis.diagnostics });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    connection.console.error(message);
    connection.sendDiagnostics({
      uri: document.uri,
      diagnostics: [
        {
          severity: 1,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          message: `Dream LSP could not parse the document: ${message}`,
          source: 'dream-lsp',
        },
      ],
    });
  }
}

connection.onInitialize((_params: InitializeParams): InitializeResult => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Full,
    documentSymbolProvider: true,
    foldingRangeProvider: true,
    hoverProvider: true,
    definitionProvider: true,
    referencesProvider: true,
    renameProvider: { prepareProvider: true },
    completionProvider: { triggerCharacters: ['.', '_'] },
  },
}));

documents.onDidOpen((event) => publishDiagnostics(event.document));
documents.onDidChangeContent((event) => publishDiagnostics(event.document));
documents.onDidClose((event) => {
  languageService?.remove(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onHover((params: HoverParams) =>
  languageService?.hover(params.textDocument.uri, params.position) ?? null,
);

connection.onDefinition((params: TextDocumentPositionParams) =>
  languageService?.definition(params.textDocument.uri, params.position) as Location | null,
);

connection.onReferences((params: ReferenceParams) =>
  languageService?.references(
    params.textDocument.uri,
    params.position,
    params.context.includeDeclaration,
  ) ?? [],
);

connection.onPrepareRename((params: TextDocumentPositionParams) =>
  languageService?.prepareRename(params.textDocument.uri, params.position) ?? null,
);

connection.onRenameRequest((params: RenameParams) =>
  languageService?.rename(params.textDocument.uri, params.position, params.newName) ?? null,
);

connection.onCompletion((params: CompletionParams) =>
  languageService?.completion(params.textDocument.uri, params.position) ?? [],
);

connection.onDocumentSymbol((params) => languageService?.getAnalysis(params.textDocument.uri)?.symbols ?? []);

connection.onFoldingRanges((params: FoldingRangeParams) =>
  languageService?.getAnalysis(params.textDocument.uri)?.foldingRanges ?? [],
);

async function main(): Promise<void> {
  languageService = await DreamLanguageService.create(findWasmPath());
  documents.listen(connection);
  connection.listen();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
