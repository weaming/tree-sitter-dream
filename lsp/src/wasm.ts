import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dreamGrammarWasmPath from '../../tree-sitter-dream.wasm' with { type: 'file' };

export function findWasmPath(): string {
  const configuredWasmPath = process.env.DREAM_TREE_SITTER_WASM;
  if (configuredWasmPath && existsSync(configuredWasmPath)) return configuredWasmPath;
  if (dreamGrammarWasmPath) return dreamGrammarWasmPath;

  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(currentDirectory, 'tree-sitter-dream.wasm'),
    join(currentDirectory, '../tree-sitter-dream.wasm'),
    join(currentDirectory, '../../tree-sitter-dream.wasm'),
    resolve(process.cwd(), 'tree-sitter-dream.wasm'),
  ];
  const wasmPath = candidates.find((candidate) => existsSync(candidate));

  if (!wasmPath) {
    throw new Error(
      'Cannot find tree-sitter-dream.wasm. Build the WASM parser or set DREAM_TREE_SITTER_WASM.',
    );
  }
  return wasmPath;
}
