#!/usr/bin/env node

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
import { fileURLToPath } from 'node:url';
import { DreamLanguageService } from './analyzer.js';
import { findWasmPath } from './wasm.js';

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
let languageService: DreamLanguageService | undefined;

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

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
  const roots = new Set<string>();
  for (const folder of params.workspaceFolders ?? []) {
    if (!folder.uri.startsWith('file:')) continue;
    roots.add(fileURLToPath(folder.uri));
  }
  if (roots.size === 0 && params.rootUri?.startsWith('file:')) {
    roots.add(fileURLToPath(params.rootUri));
  }
  if (roots.size === 0 && params.rootPath) roots.add(params.rootPath);

  await languageService?.loadWorkspace([...roots]);

  return {
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
  };
});

documents.onDidOpen((event) => publishDiagnostics(event.document));
documents.onDidChangeContent((event) => publishDiagnostics(event.document));
documents.onDidClose((event) => {
  void languageService?.close(event.document.uri).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    connection.console.error(`Dream LSP could not restore ${event.document.uri}: ${message}`);
  });
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
