#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DreamLanguageService } from './analyzer.js';
import { findWasmPath } from './wasm.js';

export interface CliOptions {
  filePaths: string[];
  isPretty: boolean;
}

export interface CliFileResult {
  path: string;
  uri: string;
  diagnostics: ReturnType<DreamLanguageService['update']>['diagnostics'];
}

export interface CliResult {
  ok: boolean;
  files: CliFileResult[];
}

export function parseCliArguments(argumentsList: readonly string[]): CliOptions {
  const filePaths: string[] = [];
  let isPretty = false;
  let isReadingOptions = true;

  for (const argument of argumentsList) {
    if (isReadingOptions && argument === '--') {
      isReadingOptions = false;
      continue;
    }
    if (isReadingOptions && (argument === '--pretty' || argument === '-p')) {
      isPretty = true;
      continue;
    }
    if (isReadingOptions && (argument === '--help' || argument === '-h')) {
      throw new Error(getUsage());
    }
    if (isReadingOptions && argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}\n\n${getUsage()}`);
    }
    filePaths.push(argument);
  }

  if (filePaths.length === 0) {
    throw new Error(`At least one Dream source file is required.\n\n${getUsage()}`);
  }
  return { filePaths, isPretty };
}

export function getUsage(): string {
  return [
    'Usage: dream-lsp-cli [--pretty] <file.dm> [...file.dm]',
    '',
    'Analyze Dream files and print LSP diagnostics as JSON.',
    '',
    'Options:',
    '  -p, --pretty  Format JSON with indentation',
    '  -h, --help    Show this help',
  ].join('\n');
}

async function analyzeFile(
  languageService: DreamLanguageService,
  filePath: string,
): Promise<CliFileResult> {
  const absolutePath = resolve(filePath);
  const uri = pathToFileURL(absolutePath).href;
  const source = await readFile(absolutePath, 'utf8');
  const document = TextDocument.create(uri, 'dream', 1, source);
  const analysis = languageService.update(document);

  return {
    path: filePath,
    uri,
    diagnostics: analysis.diagnostics,
  };
}

async function run(argumentsList: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArguments(argumentsList);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Usage:') || message.includes('\n\nUsage:')) {
      console.log(message);
      return message.startsWith('Usage:') ? 0 : 2;
    }
    console.error(message);
    return 2;
  }

  const languageService = await DreamLanguageService.create(findWasmPath());
  try {
    const files: CliFileResult[] = [];
    for (const filePath of options.filePaths) {
      files.push(await analyzeFile(languageService, filePath));
    }

    const result: CliResult = {
      ok: files.every((file) => file.diagnostics.length === 0),
      files,
    };
    const indentation = options.isPretty ? 2 : undefined;
    console.log(JSON.stringify(result, null, indentation));
    return result.ok ? 0 : 1;
  } finally {
    languageService.dispose();
  }
}

run(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 2;
  },
);
