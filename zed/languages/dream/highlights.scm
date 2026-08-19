(comment) @comment

[
  "as"
  "and"
  "case"
  "const"
  "def"
  "default"
  "elif"
  "else"
  "enum"
  "for"
  "from"
  "if"
  "impl"
  "import"
  "in"
  "interface"
  "lambda"
  "let"
  "match"
  "not"
  "of"
  "or"
  "pass"
  "print"
  "return"
  "struct"
  "switch"
  "type"
  "while"
] @keyword

[
  "None"
  "Some"
  "Ok"
  "Err"
  "self"
] @variable.special

(super_expression) @variable.special

(boolean) @boolean
(integer) @number
(float) @number
(byte) @string
(rune) @string
(string) @string
(triple_string) @string

(function_definition
  name: (identifier) @function)

(call_expression
  function: (identifier) @function)

(constant_definition
  name: (identifier) @constant)

(associated_constant
  name: (identifier) @constant)

(associated_constant_assignment
  name: (identifier) @constant)

(struct_definition
  name: (identifier) @type)

(interface_definition
  name: (identifier) @type)

(enum_definition
  name: (identifier) @type)

(impl_definition
  interface: (identifier) @type)

(impl_definition
  target: (type) @type)

(enum_member_variant
  name: (identifier) @enum)

(field_definition
  name: (identifier) @property)

(struct_field_init
  name: (identifier) @property)

(field_expression
  field: (identifier) @property)

(type) @type
(type_atom) @type
(module_name) @module

[
  (lparen) (rparen)
  (lbracket) (rbracket)
  (lbrace) (rbrace)
] @punctuation.bracket

[
  ":"
  ","
  "."
  "->"
] @punctuation.delimiter

[
  "="
  "=="
  "!="
  "<"
  "<="
  ">"
  ">="
  "+"
  "-"
  "*"
  "/"
  "//"
  "%"
  "**"
  "&"
  "|"
  "^"
  "<<"
  ">>"
  "?"
  "::"
] @operator
