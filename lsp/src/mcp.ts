#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { DreamLanguageService } from './analyzer.js';
import { findWasmPath } from './wasm.js';
import {
  analyzePath,
  exploreWorkspace,
  findReferences,
  findReferencesBySymbol,
  SYMBOL_KIND_NAMES,
} from './relations.js';
import type { WorkspaceRelationsResult } from './relations.js';

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

const SERVER_NAME = 'dream-lsp-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'dream_analyze',
    description: 'Parse one Dream file and return LSP diagnostics and symbols.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to a .dm file.' } },
      required: ['path'],
    },
  },
  {
    name: 'dream_workspace',
    description:
      'Return a compact Markdown Dream workspace index. Files, symbols, and imports are CSV code blocks. ' +
      'Symbols are module-level by default; kind is numeric with one mapping table; references are counts unless positions are requested.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Workspace directory or a .dm file.' },
        file: {
          type: 'string',
          description: 'Optional file path (relative or absolute). When set, lists all symbols from that file only.',
        },
        maxFiles: { type: 'number', description: 'Maximum number of .dm files to index.' },
        level: {
          type: 'string',
          enum: ['summary', 'full'],
          description: 'summary returns module-level symbols (default); full includes local symbols.',
        },
        maxSymbols: {
          type: 'number',
          description: 'Maximum symbols to return. Defaults to 30. Symbols are ranked by weighted reference count (functions count double).',
        },
        includeReferences: {
          type: 'boolean',
          description: 'Include reference positions. Defaults to false; use dream_references for one symbol.',
        },
        maxReferences: {
          type: 'number',
          description: 'Maximum reference positions when includeReferences is true. Defaults to 10000.',
        },
      },
      required: ['root'],
    },
  },
  {
    name: 'dream_find',
    description:
      'Find references by LSP position, or search a workspace for a symbol name case-insensitively.',
    inputSchema: {
      type: 'object',
      description:
        'Two call modes: symbol-name search (root + symbol) or LSP position lookup (path + line + character).',
      properties: {
        root: { type: 'string', description: 'Workspace directory for symbol-name search.' },
        symbol: { type: 'string', description: 'Symbol name to search, case-insensitive.' },
        path: { type: 'string', description: 'Path to a .dm file.' },
        line: { type: 'number', description: 'Zero-based line number.' },
        character: { type: 'number', description: 'Zero-based character offset.' },
        includeDeclaration: { type: 'boolean' },
        maxFiles: { type: 'number', description: 'Maximum .dm files for symbol-name search.' },
        maxMatches: { type: 'number', description: 'Maximum symbol matches. Defaults to 100.' },
      },
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getArguments(request: JsonRpcRequest): Record<string, unknown> {
  return isRecord(request.params) && isRecord(request.params.arguments)
    ? request.params.arguments
    : {};
}

function requireString(argumentsRecord: Record<string, unknown>, name: string): string {
  const value = argumentsRecord[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`The '${name}' argument must be a non-empty string.`);
  }
  return value;
}

function requireNumber(argumentsRecord: Record<string, unknown>, name: string): number {
  const value = argumentsRecord[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`The '${name}' argument must be a non-negative integer.`);
  }
  return value;
}

function createToolResult(value: unknown, isError = false): ToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function csvValue(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(values: Array<string | number | undefined>): string {
  return values.map((value) => csvValue(value ?? '')).join(',');
}

function appendLocationTable(
  lines: string[],
  title: string,
  rows: Array<[number, number, number]>,
): void {
  lines.push('', `## ${title}`, '', '```csv', 'file_idx,line,character');
  for (const row of rows) lines.push(csvRow(row));
  lines.push('```');
}

function createWorkspaceToolResult(value: WorkspaceRelationsResult): ToolCallResult {
  const referenceCount = value.symbols.reduce((total, symbol) => total + symbol[5], 0);
  const lines = [
    '# Dream workspace relations',
    '',
    `- Root: \`${value.root}\``,
    `- Level: \`${value.level}\``,
    `- Files: ${value.files.length}`,
    `- Symbols: ${value.symbols.length}`,
    `- Imports: ${value.imports.length}`,
    `- References: ${referenceCount}`,
  ];

  if (value.truncatedSymbols) lines.push(`- Truncated symbols: ${value.truncatedSymbols}`);
  if (value.truncatedReferences) lines.push(`- Truncated references: ${value.truncatedReferences}`);

  const usedKinds = new Set(value.symbols.map((symbol) => symbol[2]));
  const kindEntries = Object.entries(SYMBOL_KIND_NAMES)
    .filter(([kind]) => usedKinds.has(Number(kind)))
    .sort(([left], [right]) => Number(left) - Number(right));

  lines.push(
    '',
    '## Files',
    '',
    '```csv',
    'file_idx,path,diagnostic_count',
    ...value.files.map((file, fileIndex) => csvRow([fileIndex, ...file])),
    '```',
    '',
    '## Symbol kinds',
    '',
    '```csv',
    'kind,name',
    ...kindEntries.map(([kind, name]) => csvRow([kind, name])),
    '```',
    '',
    'File indexes are zero-based references into this table; line and character indexes are zero-based.',
    '',
    '## Symbols',
    '',
    '```csv',
    'file_idx,name,kind,start_line,end_line,reference_count',
    ...value.symbols.map((symbol) => csvRow(symbol)),
    '```',
    '',
    '## Imports',
    '',
    '```csv',
    'file_idx,line,character,module,names',
    ...value.imports.map((entry) => csvRow(entry)),
    '```',
  );

  if (value.references) {
    lines.push(
      '',
      '## References',
      '',
      '```csv',
      'symbol_idx,line,character',
      ...Object.entries(value.references).flatMap(([symbolId, references]) =>
        references.map((reference) => csvRow([symbolId, ...reference]))
      ),
      '```',
    );
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function callTool(
  languageService: DreamLanguageService,
  toolName: string,
  argumentsRecord: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (toolName === 'dream_analyze') {
    const file = await analyzePath(languageService, requireString(argumentsRecord, 'path'));
    const lines = [
      '# Dream analyze',
      '',
      `- File: \`${file.path}\``,
      `- OK: ${file.diagnostics.length === 0}`,
      `- Symbols: ${file.symbols.length}`,
      `- Diagnostics: ${file.diagnostics.length}`,
    ];

    if (file.diagnostics.length > 0) {
      lines.push('', '## Diagnostics', '', '```csv', 'severity,line,character,end_line,end_character,message');
      for (const diagnostic of file.diagnostics) {
        lines.push(csvRow([
          diagnostic.severity,
          diagnostic.range.start.line,
          diagnostic.range.start.character,
          diagnostic.range.end.line,
          diagnostic.range.end.character,
          diagnostic.message,
        ]));
      }
      lines.push('```');
    }

    lines.push('', '## Symbols', '', '```csv', 'idx,name,kind,detail,start_line,start_char,end_line,end_char');
    file.symbols.forEach((symbol, index) => {
      lines.push(csvRow([
        index,
        symbol.name,
        symbol.kind,
        symbol.detail,
        symbol.selectionRange.start.line,
        symbol.selectionRange.start.character,
        symbol.range.end.line,
        symbol.range.end.character,
      ]));
    });
    lines.push('```');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (toolName === 'dream_workspace') {
    const root = requireString(argumentsRecord, 'root');
    const maxFilesValue = argumentsRecord.maxFiles;
    const maxFiles = maxFilesValue === undefined ? 500 : requireNumber(argumentsRecord, 'maxFiles');
    const levelValue = argumentsRecord.level;
    const level = levelValue === undefined ? 'summary' : levelValue;
    if (level !== 'summary' && level !== 'full') {
      throw new Error("The 'level' argument must be 'summary' or 'full'.");
    }
    const maxSymbolsValue = argumentsRecord.maxSymbols;
    const maxSymbols = maxSymbolsValue === undefined ? 30 : requireNumber(argumentsRecord, 'maxSymbols');
    const includeReferences = argumentsRecord.includeReferences === true;
    const maxReferencesValue = argumentsRecord.maxReferences;
    const maxReferences = maxReferencesValue === undefined
      ? 10_000
      : requireNumber(argumentsRecord, 'maxReferences');
    const fileValue = argumentsRecord.file;
    const file = typeof fileValue === 'string' && fileValue.length > 0 ? fileValue : undefined;
    return createWorkspaceToolResult(await exploreWorkspace(languageService, root, {
      maxFiles,
      level,
      maxSymbols,
      includeReferences,
      maxReferences,
      file,
    }));
  }

  if (toolName === 'dream_find') {
    if (argumentsRecord.symbol !== undefined) {
      const symbol = requireString(argumentsRecord, 'symbol');
      const root = argumentsRecord.root === undefined
        ? requireString(argumentsRecord, 'path')
        : requireString(argumentsRecord, 'root');
      const maxFilesValue = argumentsRecord.maxFiles;
      const maxFiles = maxFilesValue === undefined ? 500 : requireNumber(argumentsRecord, 'maxFiles');
      const maxMatchesValue = argumentsRecord.maxMatches;
      const maxMatches = maxMatchesValue === undefined
        ? 100
        : requireNumber(argumentsRecord, 'maxMatches');
      const result = await findReferencesBySymbol(languageService, root, symbol, maxFiles, maxMatches);

      const fileIds = new Map<string, number>();
      const files: string[] = [];
      const definitions: Array<[number, number, number]> = [];
      const references: Array<[number, number, number]> = [];
      for (const match of result.matches) {
        let fileId = fileIds.get(match.path);
        if (fileId === undefined) {
          fileId = files.length;
          fileIds.set(match.path, fileId);
          files.push(match.path);
        }
        definitions.push([
          fileId,
          match.definition.range.start.line,
          match.definition.range.start.character,
        ]);
        for (const reference of match.references) {
          references.push([
            fileId,
            reference.range.start.line,
            reference.range.start.character,
          ]);
        }
      }

      const lines = [
        '# Dream find',
        '',
        `- Query: \`${result.query}\``,
        `- Root: \`${result.root}\``,
        `- Matches: ${result.matches.length}`,
      ];
      if (result.truncatedMatches) lines.push(`- Truncated matches: ${result.truncatedMatches}`);
      lines.push('', '## Files', '', '```csv', 'file_idx,path');
      files.forEach((path, fileId) => lines.push(csvRow([fileId, path])));
      lines.push('```');
      appendLocationTable(lines, 'Definitions', definitions);
      appendLocationTable(lines, 'References', references);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    const path = requireString(argumentsRecord, 'path');
    const line = requireNumber(argumentsRecord, 'line');
    const character = requireNumber(argumentsRecord, 'character');
    const includeDeclaration = argumentsRecord.includeDeclaration !== false;
    const result = await findReferences(languageService, path, { line, character }, includeDeclaration);

    const lines = [
      '# Dream find',
      '',
      `- File: \`${result.file.path}\``,
      '',
      '## Files',
      '',
      '```csv',
      'file_idx,path',
      csvRow([0, result.file.path]),
      '```',
    ];
    const definitions: Array<[number, number, number]> = result.definition
      ? [[0, result.definition.range.start.line, result.definition.range.start.character]]
      : [];
    const references: Array<[number, number, number]> = result.references.map((reference) => [
      0,
      reference.range.start.line,
      reference.range.start.character,
    ]);
    appendLocationTable(lines, 'Definition', definitions);
    appendLocationTable(lines, 'References', references);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  throw new Error(`Unknown Dream MCP tool: ${toolName}`);
}

function writeResponse(id: JsonRpcId, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function writeError(id: JsonRpcId, code: number, message: string): void {
  writeResponse(id, { error: { code, message } });
}

async function main(): Promise<void> {
  const languageService = await DreamLanguageService.create(findWasmPath());
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

  try {
    for await (const line of input) {
      if (!line.trim()) continue;

      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        writeError(null, -32700, 'Invalid JSON.');
        continue;
      }

      if (request.id === undefined) continue;

      try {
        if (request.method === 'initialize') {
          const requestedVersion = isRecord(request.params)
            ? request.params.protocolVersion
            : undefined;
          writeResponse(request.id, {
            protocolVersion: typeof requestedVersion === 'string' ? requestedVersion : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          });
          continue;
        }

        if (request.method === 'notifications/initialized') {
          continue;
        }

        if (request.method === 'shutdown') {
          writeResponse(request.id, null);
          continue;
        }

        if (request.method === 'exit') {
          process.exit(0);
        }

        if (request.method === 'ping') {
          writeResponse(request.id, {});
          continue;
        }

        if (request.method === 'tools/list') {
          writeResponse(request.id, { tools: TOOLS });
          continue;
        }

        if (request.method === 'tools/call') {
          const argumentsRecord = getArguments(request);
          const toolName =
            isRecord(request.params) && typeof request.params.name === 'string'
              ? request.params.name
              : '';
          const result = await callTool(languageService, toolName, argumentsRecord);
          writeResponse(request.id, result);
          continue;
        }

        writeError(request.id, -32601, `Unsupported MCP method: ${request.method}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const suggestion = message.includes('No Dream source file found')
          ? ' Use dream_workspace to list available files.'
          : message.includes("must be a non-empty string")
          ? ' Check the required parameters for this tool.'
          : '';
        writeResponse(request.id, createToolResult({ error: message + suggestion }, true));
      }
    }
  } finally {
    input.close();
    languageService.dispose();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
