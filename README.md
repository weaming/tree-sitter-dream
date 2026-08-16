# tree-sitter-dream

Tree-sitter grammar for the Dream programming language.

The initial grammar covers the syntax used by `bootstrap/compiler.dm`:
imports, functions, typed parameters, `let`, assignments, returns, calls,
expressions, indentation-based blocks, conditionals, loops, and switches.

```sh
tree-sitter generate
tree-sitter test
tree-sitter build --wasm --output tree-sitter-dream.wasm
```
