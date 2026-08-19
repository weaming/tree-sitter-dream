#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { DreamLanguageService } from './analyzer.js';
import { findWasmPath } from './wasm.js';
import { analyzePath, exploreWorkspace, findReferences } from './relations.js';

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
    name: 'dream_diagnostics',
    description: 'Parse one Dream file and return LSP diagnostics and symbols.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to a .dm file.' } },
      required: ['path'],
    },
  },
  {
    name: 'dream_workspace_relations',
    description:
      'Index a Dream workspace and return files, symbols, imports, and same-file symbol references.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Workspace directory or a .dm file.' },
        maxFiles: { type: 'number', description: 'Maximum number of .dm files to index.' },
      },
      required: ['root'],
    },
  },
  {
    name: 'dream_references',
    description: 'Find the definition and references for a symbol at an LSP position.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to a .dm file.' },
        line: { type: 'number', description: 'Zero-based line number.' },
        character: { type: 'number', description: 'Zero-based character offset.' },
        includeDeclaration: { type: 'boolean' },
      },
      required: ['path', 'line', 'character'],
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

async function callTool(
  languageService: DreamLanguageService,
  toolName: string,
  argumentsRecord: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (toolName === 'dream_diagnostics') {
    const file = await analyzePath(languageService, requireString(argumentsRecord, 'path'));
    return createToolResult({
      ok: file.diagnostics.length === 0,
      file,
    });
  }

  if (toolName === 'dream_workspace_relations') {
    const root = requireString(argumentsRecord, 'root');
    const maxFilesValue = argumentsRecord.maxFiles;
    const maxFiles =
      maxFilesValue === undefined ? 500 : requireNumber(argumentsRecord, 'maxFiles');
    return createToolResult(await exploreWorkspace(languageService, root, maxFiles));
  }

  if (toolName === 'dream_references') {
    const path = requireString(argumentsRecord, 'path');
    const line = requireNumber(argumentsRecord, 'line');
    const character = requireNumber(argumentsRecord, 'character');
    const includeDeclaration = argumentsRecord.includeDeclaration !== false;
    return createToolResult(
      await findReferences(languageService, path, { line, character }, includeDeclaration),
    );
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
        writeResponse(request.id, createToolResult({ error: message }, true));
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
