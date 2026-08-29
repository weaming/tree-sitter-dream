import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  methodOwnerTypeName?: string;
  returnTypeName?: string;
  nodeId: number;
  nameNodeId: number;
  scopeId: number;
  declarationIndex: number;
}

interface IdentifierRecord {
  name: string;
  range: Range;
  nodeId: number;
  scopeId: number;
}

interface FieldRecord {
  name: string;
  ownerTypeName: string;
  typeName: string | null;
  nameNodeId: number;
  nameNode: SyntaxNode;
}

interface FieldAccess {
  fieldNode: SyntaxNode;
  objectNode: SyntaxNode | null;
}

interface TypeBinding {
  name: string;
  typeName: string;
  declarationIndex: number;
  scopeId: number;
}

interface ScopeRecord {
  id: number;
  parentId: number | null;
  startIndex: number;
  endIndex: number;
  kind: string;
}

interface ScopeData {
  scopes: ScopeRecord[];
  nodeScopeIds: Map<number, number>;
}

interface ImportBinding {
  localName: string;
  importedName?: string;
  ranges: Range[];
  nodeIds: number[];
}

interface ImportRecord {
  module: string;
  moduleRange: Range;
  bindings: ImportBinding[];
}

interface SymbolTarget {
  uri: string;
  symbolName?: string;
  symbolNodeId?: number;
  fieldOwnerTypeName?: string;
  methodOwnerTypeName?: string;
}

interface AnalysisEntry {
  document: TextDocument;
  analysis: DocumentAnalysis;
  positions: SourcePositions;
  definitions: SymbolRecord[];
  identifiers: IdentifierRecord[];
  imports: ImportRecord[];
  fields: FieldRecord[];
  fieldsByKey: Map<string, FieldRecord>;
  fieldsByName: Map<string, FieldRecord>;
  fieldAccesses: FieldAccess[];
  fieldAccessesByName: Map<string, FieldAccess[]>;
  typeBindings: TypeBinding[];
  typeBindingsByName: Map<string, TypeBinding[]>;
  scopes: ScopeData;
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
  'async',
  'await',
  'break',
  'case',
  'const',
  'continue',
  'def',
  'elif',
  'else',
  'enum',
  'eprint',
  'extends',
  'for',
  'from',
  'if',
  'impl',
  'import',
  'in',
  'interface',
  'let',
  'lambda',
  'match',
  'not',
  'of',
  'or',
  'return',
  'struct',
  'super',
  'switch',
  'type',
  'while',
  'with',
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

function fieldKey(ownerTypeName: string, fieldName: string): string {
  return `${ownerTypeName}\u0000${fieldName}`;
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

  lineLength(line: number): number {
    return (this.lines[line] ?? '').length;
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

function getIdentifierChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter(
    (child): child is SyntaxNode => child?.type === 'identifier',
  );
}

function getTypeName(node: SyntaxNode | null): string | null {
  if (!node) return null;

  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[|$)/.exec(node.text.trim());
  return match?.[1] ?? null;
}

function getPatternIdentifier(node: SyntaxNode | null): SyntaxNode | null {
  if (!node) return null;
  if (node.type === 'identifier') return node;

  const identifiers = node.descendantsOfType('identifier');
  return identifiers.length === 1 ? identifiers[0] ?? null : null;
}

function getStructLiteralTypeName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === 'struct_literal') return node.childForFieldName('name')?.text ?? null;

  for (const child of node.namedChildren) {
    const typeName = getStructLiteralTypeName(child);
    if (typeName) return typeName;
  }
  return null;
}

function getMethodOwnerTypeName(node: SyntaxNode): string | null {
  if (node.type !== 'function_definition' && node.type !== 'interface_method') return null;

  let current = node.parent;
  while (current) {
    if (current.type === 'struct_definition' || current.type === 'interface_definition') {
      return current.childForFieldName('name')?.text ?? null;
    }
    if (current.type === 'impl_definition') {
      return getTypeName(current.childForFieldName('target'));
    }
    if (current.type === 'function_definition' || current.type === 'interface_method') return null;
    current = current.parent;
  }
  return null;
}

const FUNCTION_SCOPE_NODE_TYPES = new Set([
  'function_definition',
  'interface_method',
  'lambda_expression',
]);

const BLOCK_SCOPE_FIELDS: Readonly<Record<string, string[]>> = {
  if_statement: ['consequence'],
  elif_clause: ['body'],
  else_clause: ['body'],
  while_statement: ['body'],
  for_statement: ['pattern', 'body'],
  switch_case: ['body'],
  with_statement: ['name', 'body'],
};

function collectScopes(root: SyntaxNode): ScopeData {
  const scopes: ScopeRecord[] = [{
    id: 0,
    parentId: null,
    startIndex: root.startIndex,
    endIndex: root.endIndex,
    kind: 'file',
  }];
  const nodeScopeIds = new Map<number, number>();

  const createScope = (
    parentId: number,
    node: SyntaxNode,
    kind: string,
    startIndex = node.startIndex,
    endIndex = node.endIndex,
  ): number => {
    const id = scopes.length;
    scopes.push({ id, parentId, startIndex, endIndex, kind });
    return id;
  };

  const visit = (node: SyntaxNode, parentScopeId: number): void => {
    let nodeScopeId = parentScopeId;
    if (node.type === 'match_case') {
      nodeScopeId = createScope(parentScopeId, node, 'match_case');
    }
    nodeScopeIds.set(node.id, nodeScopeId);

    let childScopeId = nodeScopeId;
    if (FUNCTION_SCOPE_NODE_TYPES.has(node.type)) {
      childScopeId = createScope(nodeScopeId, node, node.type);
    }

    const bodyScopeIds = new Map<number, number>();
    for (const fieldName of BLOCK_SCOPE_FIELDS[node.type] ?? []) {
      const bodyChildren = node.childrenForFieldName(fieldName).filter(
        (child): child is SyntaxNode => child !== null,
      );
      if (bodyChildren.length === 0) continue;

      const bodyScopeId = createScope(
        childScopeId,
        node,
        `${node.type}.${fieldName}`,
        bodyChildren[0].startIndex,
        bodyChildren[bodyChildren.length - 1].endIndex,
      );
      for (const bodyChild of bodyChildren) bodyScopeIds.set(bodyChild.id, bodyScopeId);
    }

    for (const child of node.namedChildren) {
      if (child) visit(child, bodyScopeIds.get(child.id) ?? childScopeId);
    }
  };

  visit(root, 0);
  return { scopes, nodeScopeIds };
}

function isDeclarationNameNode(node: SyntaxNode): boolean {
  const parent = node.parent;
  return parent !== null &&
    parent.childForFieldName('name')?.id === node.id &&
    (parent.type === 'function_definition' ||
      parent.type === 'interface_method' ||
      parent.type === 'struct_definition' ||
      parent.type === 'interface_definition' ||
      parent.type === 'enum_definition');
}

function getNodeScopeId(node: SyntaxNode, scopeData: ScopeData): number {
  if (isDeclarationNameNode(node) && node.parent) {
    return scopeData.nodeScopeIds.get(node.parent.id) ?? 0;
  }
  return scopeData.nodeScopeIds.get(node.id) ?? 0;
}

function collectFieldRecords(root: SyntaxNode): FieldRecord[] {
  const fields: FieldRecord[] = [];

  const visit = (node: SyntaxNode, ownerTypeName: string | null): void => {
    let currentOwner = ownerTypeName;
    if (node.type === 'struct_definition' || node.type === 'interface_definition') {
      currentOwner = node.childForFieldName('name')?.text ?? null;
    }

    if (node.type === 'field_definition' && currentOwner) {
      const nameNode = node.childForFieldName('name');
      if (nameNode?.type === 'identifier') {
        fields.push({
          name: nameNode.text,
          ownerTypeName: currentOwner,
          typeName: getTypeName(node.childForFieldName('type')),
          nameNodeId: nameNode.id,
          nameNode,
        });
      }
    }

    for (const child of node.namedChildren) {
      if (child) visit(child, currentOwner);
    }
  };

  visit(root, null);
  return fields;
}

function collectTypeBindings(root: SyntaxNode, scopeData: ScopeData): TypeBinding[] {
  const bindings: TypeBinding[] = [];

  walkNode(root, (node) => {
    let nameNode: SyntaxNode | null = null;
    let typeName = getTypeName(node.childForFieldName('type'));

    if (node.type === 'parameter') {
      nameNode = node.childForFieldName('name');
    } else if (node.type === 'let_statement') {
      nameNode = getPatternIdentifier(node.childForFieldName('name'));
      typeName ??= getStructLiteralTypeName(node.childForFieldName('value'));
    }

    if (!nameNode || nameNode.type !== 'identifier' || !typeName) return;

    bindings.push({
      name: nameNode.text,
      typeName,
      declarationIndex: nameNode.startIndex,
      scopeId: getNodeScopeId(nameNode, scopeData),
    });
  });

  return bindings;
}

function containsSyntaxNodePosition(node: SyntaxNode, position: Position): boolean {
  return containsPosition(
    {
      start: { line: node.startPosition.row, character: node.startPosition.column },
      end: { line: node.endPosition.row, character: node.endPosition.column },
    },
    position,
  );
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
  private readonly analyses = new Map<string, AnalysisEntry>();
  private readonly fileUris = new Map<string, string>();
  private readonly fieldEntryUris = new Map<string, Set<string>>();
  private readonly fieldKeysByUri = new Map<string, Set<string>>();
  private readonly moduleCache = new Map<string, string | null>();
  private readonly openUris = new Set<string>();
  private workspaceRoots: string[] = [];

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
    this.openUris.add(document.uri);
    return this.updateDocument(document);
  }

  async loadWorkspace(roots: string[]): Promise<void> {
    this.workspaceRoots = roots.map((root) => resolve(root));
    const filePaths = await this.collectWorkspaceFiles();

    for (const filePath of filePaths) {
      const uri = pathToFileURL(filePath).href;
      this.fileUris.set(filePath, uri);
      if (this.openUris.has(uri)) continue;

      const source = await readFile(filePath, 'utf8');
      this.updateDocument(TextDocument.create(uri, 'dream', 1, source));
    }
  }

  async close(uri: string): Promise<void> {
    this.openUris.delete(uri);
    const filePath = this.filePath(uri);
    if (!filePath || !this.workspaceRoots.length || !(await this.isWorkspaceFile(filePath))) {
      this.remove(uri);
      return;
    }

    const source = await readFile(filePath, 'utf8');
    this.updateDocument(TextDocument.create(uri, 'dream', 1, source));
  }

  private updateDocument(document: TextDocument): DocumentAnalysis {
    const oldTree = this.trees.get(document.uri);
    const tree = this.parser.parse(document.getText(), oldTree);
    if (!tree) throw new Error(`Unable to parse document: ${document.uri}`);
    this.trees.set(document.uri, tree);
    const filePath = this.filePath(document.uri);
    const scopes = collectScopes(tree.rootNode);
    const fields = collectFieldRecords(tree.rootNode);
    const fieldAccesses = this.fieldAccesses(tree.rootNode);
    const typeBindings = collectTypeBindings(tree.rootNode, scopes);
    if (filePath) this.fileUris.set(filePath, document.uri);

    const fieldsByKey = new Map<string, FieldRecord>();
    const fieldsByName = new Map<string, FieldRecord>();
    for (const field of fields) {
      fieldsByKey.set(fieldKey(field.ownerTypeName, field.name), field);
      fieldsByName.set(field.name, field);
    }

    const typeBindingsByName = new Map<string, TypeBinding[]>();
    for (const binding of typeBindings) {
      const bindings = typeBindingsByName.get(binding.name) ?? [];
      bindings.push(binding);
      typeBindingsByName.set(binding.name, bindings);
    }

    const fieldAccessesByName = new Map<string, FieldAccess[]>();
    for (const access of fieldAccesses) {
      const accesses = fieldAccessesByName.get(access.fieldNode.text) ?? [];
      accesses.push(access);
      fieldAccessesByName.set(access.fieldNode.text, accesses);
    }

    const positions = new SourcePositions(document.getText());
    const definitions: SymbolRecord[] = [];
    const identifiers: IdentifierRecord[] = [];
    const imports: ImportRecord[] = [];
    const definitionKeys = new Set<string>();

    const addDefinition = (
      nameNode: SyntaxNode,
      kind: SymbolKind,
      detail: string,
      owner: SyntaxNode,
      methodOwnerTypeName?: string,
      returnTypeName?: string,
    ): void => {
      const key = nodeKey(nameNode);
      if (definitionKeys.has(key)) return;
      definitionKeys.add(key);
      definitions.push({
        name: nameNode.text,
        kind,
        range: positions.range(owner),
        selectionRange: positions.range(nameNode),
        detail,
        methodOwnerTypeName,
        returnTypeName,
        nodeId: owner.id,
        nameNodeId: nameNode.id,
        scopeId: getNodeScopeId(nameNode, scopes),
        declarationIndex: nameNode.startIndex,
      });
    };

    walkNode(tree.rootNode, (node) => {
      const declarationKind = DECLARATION_KINDS[node.type];
      if (declarationKind) {
        const nameNode = getDeclarationNameNode(node);
        if (nameNode) {
          addDefinition(
            nameNode,
            declarationKind.kind,
            declarationKind.detail,
            node,
            getMethodOwnerTypeName(node) ?? undefined,
            getTypeName(node.childForFieldName('return_type')) ?? undefined,
          );
        }
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
        identifiers.push({
          name: node.text,
          range: positions.range(node),
          nodeId: node.id,
          scopeId: getNodeScopeId(node, scopes),
        });
      }

      if (node.type === 'from_import' || node.type === 'import_statement') {
        const moduleNode = node.childForFieldName('module');
        if (!moduleNode) return;

        const importRecord: ImportRecord = {
          module: moduleNode.text,
          moduleRange: positions.range(moduleNode),
          bindings: [],
        };

        if (node.type === 'from_import') {
          for (const importNameNode of node.namedChildren) {
            if (importNameNode?.type !== 'import_name') continue;
            const names = getIdentifierChildren(importNameNode);
            const importedName = names[0];
            if (!importedName) continue;
            const alias = names[1];
            importRecord.bindings.push({
              localName: alias?.text ?? importedName.text,
              importedName: importedName.text,
              ranges: [
                positions.range(importedName),
                ...(alias ? [positions.range(alias)] : []),
              ],
              nodeIds: names.map((nameNode) => nameNode.id),
            });
          }
        } else {
          const alias = node.childForFieldName('alias');
          const moduleParts = getIdentifierChildren(moduleNode);
          const defaultName = moduleParts.at(-1)?.text;
          if (defaultName) {
            importRecord.bindings.push({
              localName: alias?.text ?? defaultName,
              ranges: [alias ? positions.range(alias) : positions.range(moduleNode)],
              nodeIds: [alias ?? moduleParts.at(-1)!].map((nameNode) => nameNode.id),
            });
          }
        }

        imports.push(importRecord);
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

    this.removeFieldIndex(document.uri);
    const entry = {
      document,
      analysis,
      positions,
      definitions,
      identifiers,
      imports,
      fields,
      fieldsByKey,
      fieldsByName,
      fieldAccesses,
      fieldAccessesByName,
      typeBindings,
      typeBindingsByName,
      scopes,
    } satisfies AnalysisEntry;
    this.analyses.set(document.uri, entry);
    this.addFieldIndex(entry);
    this.moduleCache.clear();
    return analysis;
  }

  getAnalysis(uri: string): DocumentAnalysis | undefined {
    return this.analyses.get(uri)?.analysis;
  }

  remove(uri: string): void {
    this.removeFieldIndex(uri);
    this.trees.get(uri)?.delete();
    this.trees.delete(uri);
    this.analyses.delete(uri);
    const filePath = this.filePath(uri);
    if (filePath && this.fileUris.get(filePath) === uri) this.fileUris.delete(filePath);
    this.moduleCache.clear();
  }

  definition(uri: string, position: Position): Location | null {
    const entry = this.analyses.get(uri);
    if (!entry) return null;

    const target = this.resolveTarget(entry, position);
    if (!target) return null;
    if (!target.symbolName) return Location.create(target.uri, this.emptyRange());

    const targetEntry = this.analyses.get(target.uri);
    const definition = targetEntry && this.findTargetDefinition(targetEntry, target);
    return definition ? Location.create(target.uri, definition.selectionRange) : null;
  }

  references(uri: string, position: Position, includeDeclaration: boolean): Location[] {
    const entry = this.analyses.get(uri);
    if (!entry) return [];

    const target = this.resolveTarget(entry, position);
    if (!target) return [];

    if (!target.symbolName) return this.moduleReferences(target.uri);

    const targetEntry = this.analyses.get(target.uri);
    const definition = targetEntry && this.findTargetDefinition(targetEntry, target);
    if (!targetEntry || !definition) return [];

    if (target.fieldOwnerTypeName) {
      return this.findFieldReferences(target, definition, includeDeclaration);
    }
    if (target.methodOwnerTypeName) {
      return this.findMethodReferences(target, definition, includeDeclaration);
    }

    const locations: Location[] = [];
    if (includeDeclaration) locations.push(Location.create(target.uri, definition.selectionRange));

    for (const candidate of this.analyses.values()) {
      for (const identifier of candidate.identifiers) {
        if (candidate.document.uri === target.uri) {
          if (identifier.name !== target.symbolName) continue;
          const candidateTarget = this.resolveTarget(candidate, identifier.range.start);
          if (candidateTarget?.uri !== target.uri ||
            candidateTarget.symbolName !== target.symbolName ||
            candidateTarget.fieldOwnerTypeName !== target.fieldOwnerTypeName ||
            candidateTarget.methodOwnerTypeName !== target.methodOwnerTypeName ||
            candidateTarget.symbolNodeId !== target.symbolNodeId) {
            continue;
          }
        } else if (!this.matchesImportedTarget(candidate, identifier, target)) {
          continue;
        }

        if (identifier.nodeId === definition.nameNodeId && !includeDeclaration) continue;
        if (identifier.nodeId === definition.nameNodeId) continue;
        locations.push(Location.create(candidate.document.uri, identifier.range));
      }
    }
    return locations;
  }

  prepareRename(uri: string, position: Position): Range | null {
    const entry = this.analyses.get(uri);
    const word = entry && getWordAtPosition(entry.document, position);
    if (!entry || !word || !this.resolveTarget(entry, position)) return null;
    return word.range;
  }

  rename(uri: string, position: Position, newName: string): WorkspaceEdit | null {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return null;

    const entry = this.analyses.get(uri);
    const word = entry && getWordAtPosition(entry.document, position);
    if (!entry || !word) return null;

    const target = this.resolveTarget(entry, position);
    if (!target?.symbolName) return null;

    const locations = this.references(uri, position, true);
    const changes: Record<string, TextEdit[]> = {};
    for (const location of locations) {
      (changes[location.uri] ??= []).push(TextEdit.replace(location.range, newName));
    }

    return { changes };
  }

  hover(uri: string, position: Position): Hover | null {
    const entry = this.analyses.get(uri);
    const word = entry && getWordAtPosition(entry.document, position);
    if (!entry || !word) return null;

    const target = this.resolveTarget(entry, position);
    if (!target?.symbolName) return null;

    const targetEntry = this.analyses.get(target.uri);
    const definition = targetEntry && this.findTargetDefinition(targetEntry, target);
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
    this.fieldEntryUris.clear();
    this.fieldKeysByUri.clear();
    this.moduleCache.clear();
  }

  private findDefinition(
    entry: AnalysisEntry,
    name: string,
    position: Position,
  ): SymbolRecord | null {
    const index = entry.document.offsetAt(position);
    const candidates = entry.definitions.filter((definition) => definition.name === name);
    if (candidates.length === 0) return null;

    const declaration = candidates.find((definition) => containsPosition(definition.selectionRange, position));
    if (declaration) return declaration;

    const globalCandidates = candidates.filter((definition) => !definition.methodOwnerTypeName);
    if (globalCandidates.length === 0) return null;

    const scopeId = this.scopeIdAtPosition(entry, position);
    for (const currentScopeId of this.scopeChain(entry, scopeId)) {
      const localCandidates = globalCandidates.filter((definition) =>
        definition.scopeId === currentScopeId && definition.declarationIndex <= index);
      if (localCandidates.length === 0) continue;

      return localCandidates.reduce((nearest, definition) =>
        definition.declarationIndex > nearest.declarationIndex ? definition : nearest);
    }

    return null;
  }

  private scopeIdAtPosition(entry: AnalysisEntry, position: Position): number {
    const tree = this.trees.get(entry.document.uri);
    if (!tree) return 0;

    const node = tree.rootNode.descendantForPosition({
      row: position.line,
      column: position.character,
    });
    return node ? getNodeScopeId(node, entry.scopes) : 0;
  }

  private scopeChain(entry: AnalysisEntry, scopeId: number): number[] {
    const chain: number[] = [];
    let currentScopeId: number | null = scopeId;

    while (currentScopeId !== null) {
      const scope: ScopeRecord | undefined = entry.scopes.scopes[currentScopeId];
      if (!scope) break;
      chain.push(scope.id);
      currentScopeId = scope.parentId;
    }

    return chain;
  }

  private async collectWorkspaceFiles(): Promise<string[]> {
    const filePaths: string[] = [];
    const ignoredDirectories = new Set([
      '.git',
      'dist',
      'node_modules',
      'target',
      'tmp',
      'venv',
      '.venv',
      '__pycache__',
    ]);

    const visitDirectory = async (directoryPath: string): Promise<void> => {
      const entries = await readdir(directoryPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(directoryPath, entry.name);
        if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
          await visitDirectory(entryPath);
        } else if (entry.isFile() && extname(entry.name) === '.dm') {
          filePaths.push(resolve(entryPath));
        }
      }
    };

    for (const root of this.workspaceRoots) {
      const rootStat = await stat(root);
      if (rootStat.isFile()) {
        if (extname(root) === '.dm') filePaths.push(root);
        continue;
      }
      await visitDirectory(root);
    }

    return filePaths;
  }

  private async isWorkspaceFile(filePath: string): Promise<boolean> {
    const absolutePath = resolve(filePath);
    for (const root of this.workspaceRoots) {
      const rootPath = resolve(root);
      if (absolutePath === rootPath || absolutePath.startsWith(`${rootPath}/`)) return true;
    }
    return false;
  }

  private filePath(uri: string): string | null {
    if (!uri.startsWith('file:')) return null;
    try {
      return resolve(fileURLToPath(uri));
    } catch {
      return null;
    }
  }

  private emptyRange(): Range {
    return {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    };
  }

  private findSymbol(definitions: SymbolRecord[], name: string): SymbolRecord | null {
    return definitions.find((definition) => definition.name === name) ?? null;
  }

  private findTargetDefinition(entry: AnalysisEntry, target: SymbolTarget): SymbolRecord | null {
    if (!target.symbolName) return null;
    if (target.methodOwnerTypeName) {
      const candidates = entry.definitions.filter((definition) =>
        definition.name === target.symbolName &&
        definition.methodOwnerTypeName === target.methodOwnerTypeName);
      if (target.symbolNodeId !== undefined) {
        return candidates.find((definition) => definition.nameNodeId === target.symbolNodeId) ?? null;
      }
      return candidates[0] ?? null;
    }
    if (!target.fieldOwnerTypeName) {
      if (target.symbolNodeId !== undefined) {
        return entry.definitions.find((definition) =>
          definition.nameNodeId === target.symbolNodeId) ?? null;
      }
      return this.findSymbol(entry.definitions, target.symbolName);
    }

    const field = entry.fields.find((candidate) =>
      candidate.ownerTypeName === target.fieldOwnerTypeName && candidate.name === target.symbolName,
    );
    if (!field) return null;
    return entry.definitions.find((definition) => definition.nameNodeId === field.nameNodeId) ?? null;
  }

  private findFieldReferences(
    target: SymbolTarget,
    definition: SymbolRecord,
    includeDeclaration: boolean,
  ): Location[] {
    const locations: Location[] = [];
    if (includeDeclaration) locations.push(Location.create(target.uri, definition.selectionRange));
    const targetFieldName = target.symbolName;
    if (!targetFieldName) return locations;

    for (const entry of this.analyses.values()) {
      const tree = this.trees.get(entry.document.uri);
      if (!tree) continue;

      for (const fieldAccess of entry.fieldAccessesByName.get(targetFieldName) ?? []) {
        const fieldNode = fieldAccess.fieldNode;
        const fieldTarget = this.resolveFieldAccessTarget(entry, fieldAccess);
        if (fieldTarget?.uri !== target.uri ||
          fieldTarget.symbolName !== target.symbolName ||
          fieldTarget.fieldOwnerTypeName !== target.fieldOwnerTypeName) {
          continue;
        }

        locations.push(Location.create(
          entry.document.uri,
          entry.positions.range(fieldNode),
        ));
      }
    }

    return locations;
  }

  private findMethodReferences(
    target: SymbolTarget,
    definition: SymbolRecord,
    includeDeclaration: boolean,
  ): Location[] {
    const locations: Location[] = [];
    if (includeDeclaration) locations.push(Location.create(target.uri, definition.selectionRange));
    const targetMethodName = target.symbolName;
    if (!targetMethodName) return locations;

    for (const entry of this.analyses.values()) {
      for (const access of entry.fieldAccessesByName.get(targetMethodName) ?? []) {
        const methodTarget = this.resolveFieldAccessTarget(entry, access);
        if (methodTarget?.uri !== target.uri ||
          methodTarget.symbolName !== target.symbolName ||
          methodTarget.methodOwnerTypeName !== target.methodOwnerTypeName ||
          methodTarget.symbolNodeId !== target.symbolNodeId) {
          continue;
        }

        locations.push(Location.create(
          entry.document.uri,
          entry.positions.range(access.fieldNode),
        ));
      }
    }

    return locations;
  }

  private resolveTarget(entry: AnalysisEntry, position: Position): SymbolTarget | null {
    const word = getWordAtPosition(entry.document, position);
    if (!word) return null;

    const importRecord = entry.imports.find((record) => containsPosition(record.moduleRange, position));
    if (importRecord) {
      const uri = this.resolveModule(entry, importRecord.module);
      return uri ? { uri } : null;
    }

    const binding = this.findImportBinding(entry, position, word.name);
    if (binding) {
      const uri = this.resolveModule(entry, this.findImportModule(entry, binding));
      return uri ? { uri, symbolName: binding.importedName } : null;
    }

    const fieldTarget = this.resolveFieldTarget(entry, position);
    if (fieldTarget) return fieldTarget;

    const definition = this.findDefinition(entry, word.name, position);
    if (definition) {
      return {
        uri: entry.document.uri,
        symbolName: definition.name,
        symbolNodeId: definition.nameNodeId,
        methodOwnerTypeName: definition.methodOwnerTypeName,
      };
    }

    const importedBinding = entry.imports
      .flatMap((record) => record.bindings.map((candidate) => ({ record, candidate })))
      .find(({ candidate }) => candidate.localName === word.name);
    if (!importedBinding) return null;

    const uri = this.resolveModule(entry, importedBinding.record.module);
    return uri ? { uri, symbolName: importedBinding.candidate.importedName } : null;
  }

  private fieldAccesses(root: SyntaxNode): FieldAccess[] {
    const accesses: FieldAccess[] = [];

    for (const nodeType of ['field_expression', 'field_assignment_statement', 'enum_variant_expression']) {
      for (const node of root.descendantsOfType(nodeType)) {
        if (!node) continue;
        const fieldNode = node.childForFieldName('field') ?? node.childForFieldName('variant');
        if (!fieldNode) continue;
        const objectNode = node.childForFieldName('object') ?? node.childForFieldName('enum');
        accesses.push({ fieldNode, objectNode });
      }
    }

    return accesses;
  }

  private resolveFieldTarget(entry: AnalysisEntry, position: Position): SymbolTarget | null {
    const tree = this.trees.get(entry.document.uri);
    if (!tree) return null;

    const access = entry.fieldAccesses.find(({ fieldNode }) =>
      containsSyntaxNodePosition(fieldNode, position));
    const fieldTarget = access && this.resolveFieldAccessTarget(entry, access);
    if (fieldTarget) return fieldTarget;

    const declaration = entry.fields.find((field) =>
      containsSyntaxNodePosition(field.nameNode, position));
    if (!declaration) return null;
    return {
      uri: entry.document.uri,
      symbolName: declaration.name,
      fieldOwnerTypeName: declaration.ownerTypeName,
    };
  }

  private resolveFieldAccessTarget(
    entry: AnalysisEntry,
    access: FieldAccess,
  ): SymbolTarget | null {
    if (!access.objectNode) return null;

    const ownerTypeName = this.resolveExpressionType(entry, access.objectNode);
    const fieldEntry = ownerTypeName && this.findFieldEntry(entry, ownerTypeName, access.fieldNode.text);
    const field = fieldEntry && (
      this.findFieldRecord(fieldEntry, ownerTypeName, access.fieldNode.text) ??
      this.findFieldByName(fieldEntry, access.fieldNode.text)
    );
    if (fieldEntry && field) {
      return {
        uri: fieldEntry.document.uri,
        symbolName: field.name,
        fieldOwnerTypeName: field.ownerTypeName,
      };
    }

    const method = ownerTypeName && this.findMethodDefinition(entry, ownerTypeName, access.fieldNode.text);
    if (!method) return null;

    return {
      uri: method.entry.document.uri,
      symbolName: method.definition.name,
      symbolNodeId: method.definition.nameNodeId,
      methodOwnerTypeName: method.definition.methodOwnerTypeName,
    };
  }

  private resolveExpressionType(entry: AnalysisEntry, node: SyntaxNode | null): string | null {
    if (!node) return null;

    if (node.type === 'parenthesized_expression' || node.type === 'expression') {
      const child = node.namedChildren.length === 1 ? node.namedChildren[0] : null;
      if (child) return this.resolveExpressionType(entry, child);
    }

    if (node.type === 'identifier') {
      return this.findTypeBinding(
        entry,
        node.text,
        node.startIndex,
        getNodeScopeId(node, entry.scopes),
      )?.typeName ?? null;
    }

    if (node.type === 'struct_literal') return node.childForFieldName('name')?.text ?? null;
    if (node.type === 'self_expression') return this.findEnclosingTypeName(node);

    if (node.type === 'call_expression') {
      const functionNode = node.childForFieldName('function');
      if (!functionNode) return null;

      let definition: SymbolRecord | null = null;
      if (functionNode.type === 'field_expression' || functionNode.type === 'enum_variant_expression') {
        const fieldNode = functionNode.childForFieldName('field') ?? functionNode.childForFieldName('variant');
        const access = fieldNode && entry.fieldAccesses.find(({ fieldNode: candidate }) =>
          candidate.id === fieldNode.id);
        const target = access && this.resolveFieldAccessTarget(entry, access);
        const targetEntry = target && this.analyses.get(target.uri);
        definition = target && targetEntry ? this.findTargetDefinition(targetEntry, target) : null;
      } else if (functionNode.type === 'identifier') {
        definition = this.findDefinition(entry, functionNode.text, entry.positions.point(
          functionNode.startPosition.row,
          functionNode.startPosition.column,
        ));
      }
      return definition?.returnTypeName ?? null;
    }

    if (node.type === 'field_expression' || node.type === 'enum_variant_expression') {
      const objectNode = node.childForFieldName('object') ?? node.childForFieldName('enum');
      const fieldName = node.childForFieldName('field')?.text ?? node.childForFieldName('variant')?.text;
      const ownerTypeName = this.resolveExpressionType(entry, objectNode);
      if (!ownerTypeName || !fieldName) return null;

      const fieldEntry = this.findFieldEntry(entry, ownerTypeName, fieldName);
      if (!fieldEntry) return null;
      return (
        this.findFieldRecord(fieldEntry, ownerTypeName, fieldName) ??
        this.findFieldByName(fieldEntry, fieldName)
      )?.typeName ?? null;
    }

    return null;
  }

  private findTypeBinding(
    entry: AnalysisEntry,
    name: string,
    index: number,
    scopeId: number,
  ): TypeBinding | null {
    const candidates = (entry.typeBindingsByName.get(name) ?? [])
      .filter((binding) => binding.declarationIndex <= index);

    for (const currentScopeId of this.scopeChain(entry, scopeId)) {
      const localCandidates = candidates.filter((binding) => binding.scopeId === currentScopeId);
      if (localCandidates.length === 0) continue;

      return localCandidates.reduce((nearest, binding) =>
        binding.declarationIndex > nearest.declarationIndex ? binding : nearest);
    }

    return null;
  }

  private findFieldEntry(entry: AnalysisEntry, ownerTypeName: string, fieldName: string): AnalysisEntry | null {
    if (this.findFieldRecord(entry, ownerTypeName, fieldName)) return entry;

    for (const record of entry.imports) {
      const binding = record.bindings.find((candidate) =>
        candidate.localName === ownerTypeName && candidate.importedName);
      if (!binding) continue;

      const uri = this.resolveModule(entry, record.module);
      const importedEntry = uri && this.analyses.get(uri);
      if (importedEntry && this.findFieldRecord(importedEntry, binding.importedName!, fieldName)) {
        return importedEntry;
      }
    }

    const key = fieldKey(ownerTypeName, fieldName);
    for (const uri of this.fieldEntryUris.get(key) ?? []) {
      const candidate = this.analyses.get(uri);
      if (candidate && this.findFieldRecord(candidate, ownerTypeName, fieldName)) return candidate;
    }
    return null;
  }

  private findMethodDefinition(
    entry: AnalysisEntry,
    ownerTypeName: string,
    methodName: string,
  ): { entry: AnalysisEntry; definition: SymbolRecord } | null {
    const findInEntry = (candidate: AnalysisEntry, typeName: string): SymbolRecord | null =>
      candidate.definitions.find((definition) =>
        definition.name === methodName && definition.methodOwnerTypeName === typeName) ?? null;

    const localDefinition = findInEntry(entry, ownerTypeName);
    if (localDefinition) return { entry, definition: localDefinition };

    for (const record of entry.imports) {
      const binding = record.bindings.find((candidate) =>
        candidate.localName === ownerTypeName && candidate.importedName);
      if (!binding) continue;

      const uri = this.resolveModule(entry, record.module);
      const importedEntry = uri && this.analyses.get(uri);
      const importedDefinition = importedEntry && findInEntry(importedEntry, binding.importedName!);
      if (importedEntry && importedDefinition) return { entry: importedEntry, definition: importedDefinition };
    }

    for (const candidate of this.analyses.values()) {
      const definition = findInEntry(candidate, ownerTypeName);
      if (definition) return { entry: candidate, definition };
    }
    return null;
  }

  private findFieldRecord(entry: AnalysisEntry, ownerTypeName: string, fieldName: string): FieldRecord | null {
    return entry.fieldsByKey.get(fieldKey(ownerTypeName, fieldName)) ?? null;
  }

  private findFieldByName(entry: AnalysisEntry, fieldName: string): FieldRecord | null {
    return entry.fieldsByName.get(fieldName) ?? null;
  }

  private addFieldIndex(entry: AnalysisEntry): void {
    const keys = new Set<string>();
    for (const field of entry.fields) {
      const key = fieldKey(field.ownerTypeName, field.name);
      const uris = this.fieldEntryUris.get(key) ?? new Set<string>();
      uris.add(entry.document.uri);
      this.fieldEntryUris.set(key, uris);
      keys.add(key);
    }
    this.fieldKeysByUri.set(entry.document.uri, keys);
  }

  private removeFieldIndex(uri: string): void {
    const keys = this.fieldKeysByUri.get(uri);
    if (!keys) return;

    for (const key of keys) {
      const uris = this.fieldEntryUris.get(key);
      if (!uris) continue;
      uris.delete(uri);
      if (uris.size === 0) this.fieldEntryUris.delete(key);
    }
    this.fieldKeysByUri.delete(uri);
  }

  private findEnclosingTypeName(node: SyntaxNode): string | null {
    let current = node.parent;
    while (current) {
      if (current.type === 'struct_definition' || current.type === 'interface_definition') {
        return current.childForFieldName('name')?.text ?? null;
      }
      if (current.type === 'impl_definition') {
        return getTypeName(current.childForFieldName('target'));
      }
      current = current.parent;
    }
    return null;
  }

  private findImportBinding(
    entry: AnalysisEntry,
    position: Position,
    name: string,
  ): ImportBinding | null {
    for (const record of entry.imports) {
      for (const binding of record.bindings) {
        if (binding.localName !== name && binding.importedName !== name) continue;
        if (binding.ranges.some((range) => containsPosition(range, position))) return binding;
      }
    }
    return null;
  }

  private findImportModule(entry: AnalysisEntry, binding: ImportBinding): string {
    for (const record of entry.imports) {
      if (record.bindings.includes(binding)) return record.module;
    }
    return '';
  }

  private resolveImportForIdentifier(entry: AnalysisEntry, identifier: IdentifierRecord): SymbolTarget | null {
    for (const record of entry.imports) {
      for (const binding of record.bindings) {
        const isBindingIdentifier = binding.nodeIds.includes(identifier.nodeId);
        const isImportedUsage = binding.localName === identifier.name &&
          !entry.definitions.some((definition) => definition.nameNodeId === identifier.nodeId);
        if (!isBindingIdentifier && !isImportedUsage) continue;

        const uri = this.resolveModule(entry, record.module);
        if (uri) return { uri, symbolName: binding.importedName };
      }
    }
    return null;
  }

  private matchesImportedTarget(
    entry: AnalysisEntry,
    identifier: IdentifierRecord,
    target: SymbolTarget,
  ): boolean {
    const importedTarget = this.resolveImportForIdentifier(entry, identifier);
    return importedTarget?.uri === target.uri && importedTarget.symbolName === target.symbolName;
  }

  private moduleReferences(uri: string): Location[] {
    const locations: Location[] = [];
    const seen = new Set<string>();
    const addLocation = (documentUri: string, range: Range): void => {
      const key = `${documentUri}:${range.start.line}:${range.start.character}`;
      if (seen.has(key)) return;
      seen.add(key);
      locations.push(Location.create(documentUri, range));
    };

    for (const entry of this.analyses.values()) {
      for (const record of entry.imports) {
        if (this.resolveModule(entry, record.module) !== uri) continue;

        addLocation(entry.document.uri, record.moduleRange);
        for (const binding of record.bindings) {
          if (binding.importedName) continue;
          for (const identifier of entry.identifiers) {
            if (identifier.name !== binding.localName) continue;
            addLocation(entry.document.uri, identifier.range);
          }
        }
      }
    }
    return locations;
  }

  private resolveModule(entry: AnalysisEntry, moduleName: string): string | null {
    const cacheKey = `${entry.document.uri}\u0000${moduleName}`;
    if (this.moduleCache.has(cacheKey)) return this.moduleCache.get(cacheKey) ?? null;

    const sourcePath = this.filePath(entry.document.uri);
    const modulePaths = [...new Set([
      moduleName,
      moduleName.replaceAll('.', '/'),
    ])];
    const bases = [
      ...(sourcePath ? [dirname(sourcePath)] : []),
      ...this.workspaceRoots,
    ];

    for (const base of bases) {
      for (const modulePath of modulePaths) {
        const candidates = [
          resolve(base, modulePath),
          resolve(base, `${modulePath}.dm`),
          resolve(base, modulePath, '__init__.dm'),
        ];
        for (const candidate of candidates) {
          const uri = this.fileUris.get(candidate);
          if (uri) {
            this.moduleCache.set(cacheKey, uri);
            return uri;
          }
        }
      }
    }

    const matches = new Set<string>();
    for (const [filePath, uri] of this.fileUris) {
      const relativeModule = this.workspaceRelativeModule(filePath);
      if (relativeModule && modulePaths.includes(relativeModule)) {
        matches.add(uri);
        continue;
      }

      if (!moduleName.includes('.') && basename(filePath, '.dm') === moduleName) {
        matches.add(uri);
      }
    }

    const uri = matches.size === 1 ? [...matches][0] ?? null : null;
    this.moduleCache.set(cacheKey, uri);
    return uri;
  }

  private workspaceRelativeModule(filePath: string): string | null {
    for (const root of this.workspaceRoots) {
      const relativePath = relative(root, filePath).replaceAll('\\', '/');
      if (!relativePath || relativePath.startsWith('../')) continue;

      return relativePath
        .replace(/\.dm$/, '')
        .replace(/\/__init__$/, '');
    }

    return null;
  }

  private createDiagnostics(root: SyntaxNode, positions: SourcePositions): Diagnostic[] {
    const errors: SyntaxNode[] = [];
    const collectErrors = (node: SyntaxNode): void => {
      if (node.type === 'ERROR' || node.isMissing) errors.push(node);
      for (const child of node.children) {
        if (child) collectErrors(child);
      }
    };
    collectErrors(root);

    const diagnostics: Diagnostic[] = [];
    const seen = new Set<string>();

    for (const node of errors) {
      const range = this.diagnosticRange(node, positions);
      const key = `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range,
        message: 'Dream syntax error',
        source: 'dream-lsp',
      });
    }

    return diagnostics;
  }

  private diagnosticRange(node: SyntaxNode, positions: SourcePositions): Range {
    const range = positions.range(node);
    if (range.start.line === range.end.line) return this.ensureDiagnosticWidth(range);

    return {
      start: range.start,
      end: { line: range.start.line, character: positions.lineLength(range.start.line) },
    };
  }

  private ensureDiagnosticWidth(range: Range): Range {
    if (range.start.character !== range.end.character) return range;

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
