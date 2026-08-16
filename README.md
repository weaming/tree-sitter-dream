# tree-sitter-dream

Tree-sitter grammar for the Dream programming language.

The grammar covers the syntax used by `bootstrap/compiler.dm`, including
imports, functions, constants, interfaces, enums, implementations, generic
and bounded type parameters, lambdas, typed parameters, `let`, assignments,
returns, calls, expressions, and indentation-based control-flow blocks.

```sh
tree-sitter generate
tree-sitter test
tree-sitter build --wasm --output tree-sitter-dream.wasm
```
