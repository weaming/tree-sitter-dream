import {
  CompletionItem,
  CompletionItemKind,
  Diagnostic,
  DiagnosticSeverity,
  DocumentSymbol,
  FoldingRange,
  Hover,
  Location,
  Position,
  Range,
  SymbolKind,
  TextEdit,
  WorkspaceEdit,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Language, Node as SyntaxNode, Parser, Tree } from 'web-tree-sitter';
import treeSitterRuntimeWasmPath from 'web-tree-sitter/tree-sitter.wasm' with { type: 'file' };

interface SymbolRecord {
  name: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  detail: string;
  nodeId: number;
  nameNodeId: number;
}

interface IdentifierRecord {
  name: string;
  range: Range;
  nodeId: number;
}

interface WordAtPosition {
  name: string;
  range: Range;
}

export interface DocumentAnalysis {
  diagnostics: Diagnostic[];
  symbols: DocumentSymbol[];
  foldingRanges: FoldingRange[];
}

const KEYWORDS = [
  'and',
  'as',
  'case',
  'const',
  'def',
  'elif',
  'else',
  'enum',
  'for',
  'from',
  'if',
  'impl',
  'import',
  'in',
  'interface',
  'let',
  'match',
  'not',
  'or',
  'pass',
  'return',
  'struct',
  'super',
  'switch',
  'type',
  'while',
];

const BUILTINS = [
  'False',
  'None',
  'True',
  'Err',
  'Ok',
  'Some',
  'bool',
  'bytes',
  'dict',
  'float',
  'int',
  'len',
  'list',
  'print',
  'range',
  'str',
  'tuple',
];

const FOLDABLE_NODE_TYPES = new Set([
  'def',
  'function_definition',
  'struct_definition',
  'interface_definition',
  'enum_definition',
  'impl_definition',
  'if_statement',
  'while_statement',
  'for_statement',
  'switch_statement',
  'match_expression',
  'lambda_expression',
]);

const DECLARATION_KINDS: Readonly<Record<string, { kind: SymbolKind; detail: string }>> = {
  function_definition: { kind: SymbolKind.Function, detail: 'function' },
  interface_method: { kind: SymbolKind.Method, detail: 'interface method' },
  struct_definition: { kind: SymbolKind.Struct, detail: 'struct' },
  interface_definition: { kind: SymbolKind.Interface, detail: 'interface' },
  enum_definition: { kind: SymbolKind.Enum, detail: 'enum' },
  enum_member_variant: { kind: SymbolKind.EnumMember, detail: 'enum member' },
  field_definition: { kind: SymbolKind.Field, detail: 'field' },
  constant_definition: { kind: SymbolKind.Constant, detail: 'constant' },
  associated_type: { kind: SymbolKind.TypeParameter, detail: 'associated type' },
  associated_constant: { kind: SymbolKind.Constant, detail: 'associated constant' },
  associated_type_assignment: { kind: SymbolKind.TypeParameter, detail: 'associated type' },
  associated_constant_assignment: { kind: SymbolKind.Constant, detail: 'associated constant' },
  parameter: { kind: SymbolKind.Variable, detail: 'parameter' },
  bounded_type_parameter: { kind: SymbolKind.TypeParameter, detail: 'type parameter' },
};

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

function walkNode(node: SyntaxNode, visit: (currentNode: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    if (child) walkNode(child, visit);
  }
}

function nodeKey(node: SyntaxNode): string {
  return `${node.startIndex}:${node.endIndex}:${node.type}`;
}

function createPosition(line: number, character: number): Position {
  return { line, character };
}

class SourcePositions {
  private readonly lines: string[];

  constructor(source: string) {
    this.lines = source.split('\n');
  }

  range(node: SyntaxNode): Range {
    return {
      start: this.point(node.startPosition.row, node.startPosition.column),
      end: this.point(node.endPosition.row, node.endPosition.column),
    };
  }

  point(line: number, byteColumn: number): Position {
    const sourceLine = this.lines[line] ?? '';
    const prefix = Buffer.from(sourceLine, 'utf8').subarray(0, byteColumn).toString('utf8');
    return createPosition(line, prefix.length);
  }
}

function containsPosition(range: Range, position: Position): boolean {
  if (position.line < range.start.line || position.line > range.end.line) return false;
  if (position.line === range.start.line && position.character < range.start.character) return false;
  if (position.line === range.end.line && position.character > range.end.character) return false;
  return true;
}

function collectPatternBindings(
  node: SyntaxNode | null,
  addDefinition: (nameNode: SyntaxNode, kind: SymbolKind, detail: string, owner: SyntaxNode) => void,
  owner: SyntaxNode,
): void {
  if (!node) return;

  if (node.type === 'identifier') {
    addDefinition(node, SymbolKind.Variable, 'variable', owner);
    return;
  }

  if (node.type === 'type_pattern') {
    const nameNode = node.childForFieldName('name');
    if (nameNode?.type === 'identifier') {
      addDefinition(nameNode, SymbolKind.Variable, 'pattern variable', owner);
    }
    return;
  }

  if (node.type === 'enum_pattern') {
    for (const child of node.namedChildren) {
      if (child?.type === 'match_pattern') {
        collectPatternBindings(child, addDefinition, owner);
      }
    }
    return;
  }

  if (node.type === 'struct_pattern') {
    for (const child of node.namedChildren) {
      if (child?.type !== 'struct_pattern_field') continue;
      collectPatternBindings(child.childForFieldName('value'), addDefinition, owner);
    }
    return;
  }

  for (const child of node.namedChildren) {
    if (child) collectPatternBindings(child, addDefinition, owner);
  }
}

function getDeclarationNameNode(node: SyntaxNode): SyntaxNode | null {
  const nameNode = node.childForFieldName('name');
  return nameNode?.type === 'identifier' ? nameNode : null;
}

function getWordAtPosition(document: TextDocument, position: Position): WordAtPosition | null {
  const line = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line + 1, character: 0 },
  }).replace(/\r?\n$/, '');

  if (!line) return null;

  let index = Math.min(position.character, line.length);
  if (index === line.length || !isIdentifierCharacter(line[index])) index--;
  if (index < 0 || !isIdentifierCharacter(line[index])) return null;

  let start = index;
  let end = index + 1;
  while (start > 0 && isIdentifierCharacter(line[start - 1])) start--;
  while (end < line.length && isIdentifierCharacter(line[end])) end++;

  return {
    name: line.slice(start, end),
    range: {
      start: { line: position.line, character: start },
      end: { line: position.line, character: end },
    },
  };
}

export class DreamLanguageService {
  private readonly parser: Parser;
  private readonly trees = new Map<string, Tree>();
  private readonly analyses = new Map<string, {
    document: TextDocument;
    analysis: DocumentAnalysis;
    definitions: SymbolRecord[];
    identifiers: IdentifierRecord[];
  }>();

  private constructor(parser: Parser) {
    this.parser = parser;
  }

  static async create(wasmPath: string): Promise<DreamLanguageService> {
    await Parser.init({ locateFile: () => treeSitterRuntimeWasmPath });
    const language = await Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(language);
    return new DreamLanguageService(parser);
  }

  update(document: TextDocument): DocumentAnalysis {
    const oldTree = this.trees.get(document.uri);
    const tree = this.parser.parse(document.getText(), oldTree);
    if (!tree) throw new Error(`Unable to parse document: ${document.uri}`);
    this.trees.set(document.uri, tree);

    const positions = new SourcePositions(document.getText());
    const definitions: SymbolRecord[] = [];
    const identifiers: IdentifierRecord[] = [];
    const definitionNodeIds = new Set<number>();
    const definitionKeys = new Set<string>();

    const addDefinition = (
      nameNode: SyntaxNode,
      kind: SymbolKind,
      detail: string,
      owner: SyntaxNode,
    ): void => {
      const key = nodeKey(nameNode);
      if (definitionKeys.has(key)) return;
      definitionKeys.add(key);
      definitionNodeIds.add(nameNode.id);
      definitions.push({
        name: nameNode.text,
        kind,
        range: positions.range(owner),
        selectionRange: positions.range(nameNode),
        detail,
        nodeId: owner.id,
        nameNodeId: nameNode.id,
      });
    };

    walkNode(tree.rootNode, (node) => {
      const declarationKind = DECLARATION_KINDS[node.type];
      if (declarationKind) {
        const nameNode = getDeclarationNameNode(node);
        if (nameNode) addDefinition(nameNode, declarationKind.kind, declarationKind.detail, node);
      }

      if (node.type === 'let_statement') {
        collectPatternBindings(node.childForFieldName('name'), addDefinition, node);
      }

      if (node.type === 'for_statement') {
        collectPatternBindings(node.childForFieldName('pattern'), addDefinition, node);
      }

      if (node.type === 'match_case') {
        collectPatternBindings(node.childForFieldName('pattern'), addDefinition, node);
      }

      if (node.type === 'identifier') {
        identifiers.push({ name: node.text, range: positions.range(node), nodeId: node.id });
      }
    });

    const diagnostics = this.createDiagnostics(tree.rootNode, positions);
    const symbols = definitions.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      range: symbol.range,
      selectionRange: symbol.selectionRange,
      detail: symbol.detail,
    }));
    const foldingRanges = this.createFoldingRanges(tree.rootNode);
    const analysis = { diagnostics, symbols, foldingRanges };

    this.analyses.set(document.uri, { document, analysis, definitions, identifiers });
    return analysis;
  }

  getAnalysis(uri: string): DocumentAnalysis | undefined {
    return this.analyses.get(uri)?.analysis;
  }

  remove(uri: string): void {
    this.trees.get(uri)?.delete();
    this.trees.delete(uri);
    this.analyses.delete(uri);
  }

  definition(uri: string, position: Position): Location | null {
    const entry = this.analyses.get(uri);
    const word = entry && getWordAtPosition(entry.document, position);
    if (!entry || !word) return null;

    const definition = this.findDefinition(entry.definitions, word.name, position);
    return definition ? Location.create(uri, definition.selectionRange) : null;
  }

  references(uri: string, position: Position, includeDeclaration: boolean): Location[] {
    const entry = this.analyses.get(uri);
    const word = entry && getWordAtPosition(entry.document, position);
    if (!entry || !word) return [];

    const definition = this.findDefinition(entry.definitions, word.name, position);
    if (!definition) return [];

    const locations: Location[] = [];
    if (includeDeclaration) locations.push(Location.create(uri, definition.selectionRange));

    for (const identifier of entry.identifiers) {
      if (identifier.name !== definition.name || identifier.nodeId === definition.nameNodeId) continue;
      locations.push(Location.create(uri, identifier.range));
    }
    return locations;
  }

  prepareRename(uri: string, position: Position): Range | null {
    const entry = this.analyses.get(uri);
    const word = entry && getWordAtPosition(entry.document, position);
    if (!entry || !word || !this.findDefinition(entry.definitions, word.name, position)) return null;
    return word.range;
  }

  rename(uri: string, position: Position, newName: string): WorkspaceEdit | null {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return null;

    const entry = this.analyses.get(uri);
    const word = entry && getWordAtPosition(entry.document, position);
    if (!entry || !word || !this.findDefinition(entry.definitions, word.name, position)) return null;

    const edits: TextEdit[] = entry.identifiers
      .filter((identifier) => identifier.name === word.name)
      .map((identifier) => TextEdit.replace(identifier.range, newName));
    return { changes: { [uri]: edits } };
  }

  hover(uri: string, position: Position): Hover | null {
    const entry = this.analyses.get(uri);
    const word = entry && getWordAtPosition(entry.document, position);
    if (!entry || !word) return null;

    const definition = this.findDefinition(entry.definitions, word.name, position);
    if (!definition) return null;

    return {
      contents: {
        kind: 'markdown',
        value: `**${definition.name}**  \n${definition.detail}`,
      },
      range: word.range,
    };
  }

  completion(uri: string, position: Position): CompletionItem[] {
    const entry = this.analyses.get(uri);
    if (!entry) return [];

    const word = getWordAtPosition(entry.document, position);
    const prefix = word?.name ?? '';
    const names = new Set([
      ...KEYWORDS,
      ...BUILTINS,
      ...entry.definitions.map((definition) => definition.name),
    ]);

    return [...names]
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((label) => ({
        label,
        kind: KEYWORDS.includes(label) ? CompletionItemKind.Keyword : CompletionItemKind.Text,
      }));
  }

  dispose(): void {
    for (const tree of this.trees.values()) tree.delete();
    this.trees.clear();
    this.parser.delete();
    this.analyses.clear();
  }

  private findDefinition(
    definitions: SymbolRecord[],
    name: string,
    position: Position,
  ): SymbolRecord | null {
    const candidates = definitions.filter((definition) => definition.name === name);
    if (candidates.length === 0) return null;

    const exact = candidates.find((definition) => containsPosition(definition.selectionRange, position));
    if (exact) return exact;

    const preceding = candidates.filter(
      (definition) => definition.selectionRange.start.line <= position.line,
    );
    return preceding[preceding.length - 1] ?? candidates[0] ?? null;
  }

  private createDiagnostics(root: SyntaxNode, positions: SourcePositions): Diagnostic[] {
    const errors = root.descendantsOfType('ERROR').filter(
      (node): node is SyntaxNode => node !== null,
    );
    const diagnostics: Diagnostic[] = [];
    const seen = new Set<string>();

    for (const node of errors) {
      const range = positions.range(node);
      const key = `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: this.ensureDiagnosticRange(range),
        message: 'Dream syntax error',
        source: 'dream-lsp',
      });
    }

    return diagnostics;
  }

  private ensureDiagnosticRange(range: Range): Range {
    if (range.start.line !== range.end.line || range.start.character !== range.end.character) {
      return range;
    }
    return {
      start: range.start,
      end: { line: range.end.line, character: range.end.character + 1 },
    };
  }

  private createFoldingRanges(root: SyntaxNode): FoldingRange[] {
    const ranges: FoldingRange[] = [];
    walkNode(root, (node) => {
      if (!FOLDABLE_NODE_TYPES.has(node.type)) return;
      if (node.startPosition.row >= node.endPosition.row) return;
      ranges.push({
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        kind: 'region',
      });
    });
    return ranges;
  }
}
