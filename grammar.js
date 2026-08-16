const PREC = {
  ternary: 1,
  union: 2,
  logicalOr: 3,
  logicalAnd: 4,
  compare: 5,
  sum: 6,
  product: 7,
  unary: 8,
  postfix: 9,
};

function commaSep(rule) {
  return optional(seq(rule, repeat(seq(',', rule)), optional(',')));
}

function commaSep1(rule) {
  return seq(rule, repeat(seq(',', rule)), optional(','));
}

module.exports = grammar({
  name: 'dream',

  externals: $ => [$.indent, $.dedent, $.newline],

  extras: $ => [/[ \t\r]/, $.comment],

  word: $ => $.identifier,

  conflicts: $ => [
    [$.call_expression, $.binary_expression],
    [$.type, $.tuple_expression],
    [$.type, $.list_expression],
    [$.parenthesized_expression, $.tuple_expression],
    [$.pattern, $.match_pattern],
    [$.struct_literal, $.dict_expression],
    [$.field_expression, $.enum_variant_expression],
    [ $._postfix_base, $.enum_variant_expression ],
    [$.source_file, $.statement],
    [$.statement, $.expression],
    [$.pattern, $.type_pattern],
    [$.match_pattern, $.enum_pattern],
    [$.unary_expression, $.ternary_expression, $.try_expression],
    [$.binary_expression, $.ternary_expression, $.try_expression],
    [$.match_pattern, $.type_pattern, $.enum_pattern],
    [$.match_expression, $.type_of_expression],
    [$.expression, $._postfix_base],
    [$.expression, $.struct_literal],
    [$.expression, $.expression_statement],
    [$.return_statement, $.expression],
    [$.let_statement, $.expression],
    [$.match_case, $.expression],
  ],

  rules: {
    source_file: $ => repeat(choice($.top_level_item, $.newline)),

    top_level_item: $ => choice(
      $.from_import,
      $.import_statement,
      $.function_definition,
      $.struct_definition,
      $.interface_definition,
      $.enum_definition,
      $.impl_definition,
      $.statement,
    ),

    from_import: $ => seq(
      'from',
      field('module', $.module_name),
      'import',
      field('names', commaSep1($.import_name)),
      $.newline,
    ),

    import_statement: $ => seq(
      'import',
      field('module', $.module_name),
      optional(seq('as', field('alias', $.identifier))),
      $.newline,
    ),

    import_name: $ => seq(
      $.identifier,
      optional(seq('as', $.identifier)),
    ),

    function_definition: $ => seq(
      'def',
      field('name', $.identifier),
      optional($.type_parameters),
      field('parameters', $.parameters),
      optional(seq('->', field('return_type', $.type))),
      ':',
      $.newline,
      $.indent,
      field('body', repeat($.statement)),
      $.dedent,
    ),

    type_parameters: $ => seq('[', commaSep1($.identifier), ']'),

    parameters: $ => seq('(', commaSep($.parameter), ')'),

    parameter: $ => seq(
      field('name', choice($.identifier, 'self')),
      optional(seq(':', field('type', $.type))),
      optional(seq('=', field('default_value', $.expression))),
    ),

    struct_definition: $ => seq(
      'struct',
      field('name', $.identifier),
      optional($.type_parameters),
      ':',
      $.newline,
      $.indent,
      field('body', repeat($.struct_member)),
      $.dedent,
    ),

    struct_member: $ => choice(
      $.newline,
      $.field_definition,
      $.function_definition,
    ),

    field_definition: $ => seq(
      field('name', $.identifier),
      ':',
      field('type', $.type),
      $.newline,
    ),

    interface_definition: $ => seq(
      'interface',
      field('name', $.identifier),
      optional($.type_parameters),
      ':',
      $.newline,
      $.indent,
      field('body', repeat($.interface_member)),
      $.dedent,
    ),

    interface_member: $ => choice(
      $.newline,
      $.field_definition,
      $.interface_method,
      $.associated_type,
      $.associated_constant,
    ),

    interface_method: $ => seq(
      'def',
      field('name', $.identifier),
      optional($.type_parameters),
      field('parameters', $.parameters),
      optional(seq('->', field('return_type', $.type))),
      choice(
        $.newline,
        seq(
          ':',
          $.newline,
          $.indent,
          field('body', repeat($.statement)),
          $.dedent,
        ),
      ),
    ),

    associated_type: $ => seq(
      'type',
      field('name', $.identifier),
      optional(seq('=', field('value', $.type))),
      $.newline,
    ),

    associated_constant: $ => seq(
      'const',
      field('name', $.identifier),
      ':',
      field('type', $.type),
      optional(seq('=', field('value', $.expression))),
      $.newline,
    ),

    impl_definition: $ => seq(
      'impl',
      field('interface', $.identifier),
      optional($.type_arguments),
      'for',
      field('target', $.type),
      ':',
      $.newline,
      $.indent,
      field('body', repeat($.impl_member)),
      $.dedent,
    ),

    impl_member: $ => choice(
      $.newline,
      $.function_definition,
      $.associated_type_assignment,
      $.associated_constant_assignment,
    ),

    associated_type_assignment: $ => seq(
      'type',
      field('name', $.identifier),
      '=',
      field('value', $.type),
      $.newline,
    ),

    associated_constant_assignment: $ => seq(
      'const',
      field('name', $.identifier),
      '=',
      field('value', $.expression),
      $.newline,
    ),

    type_arguments: $ => seq('[', commaSep1($.type), ']'),

    enum_definition: $ => seq(
      'enum',
      field('name', $.identifier),
      optional($.type_parameters),
      ':',
      $.newline,
      $.indent,
      field('body', repeat($.enum_member_variant)),
      repeat($.newline),
      $.dedent,
    ),

    enum_member_variant: $ => seq(
      field('name', $.identifier),
      optional(seq('(', field('types', commaSep($.type)), ')')),
      $.newline,
    ),

    statement: $ => choice(
      $.newline,
      $.let_statement,
      $.assignment_statement,
      $.return_statement,
      $.print_statement,
      $.pass_statement,
      $.expression_statement,
      $.if_statement,
      $.while_statement,
      $.for_statement,
      $.switch_statement,
    ),

    let_statement: $ => choice(
      seq(
        'let',
        field('name', $.pattern),
        optional(seq(':', field('type', $.type))),
        '=',
        field('value', $.match_expression),
      ),
      seq(
        'let',
        field('name', $.pattern),
        optional(seq(':', field('type', $.type))),
        '=',
        field('value', $.expression),
        $.newline,
      ),
    ),

    assignment_statement: $ => seq(
      field('left', choice($.identifier, $.index_expression, $.field_expression)),
      '=',
      field('right', $.expression),
      $.newline,
    ),

    return_statement: $ => choice(
      seq('return', field('value', $.match_expression)),
      seq('return', optional(field('value', $.expression)), $.newline),
    ),

    print_statement: $ => seq(
      'print',
      '(',
      optional(field('argument', $.expression)),
      ')',
      $.newline,
    ),

    pass_statement: $ => seq('pass', $.newline),

    expression_statement: $ => choice(
      $.match_expression,
      seq($.expression, $.newline),
    ),

    if_statement: $ => seq(
      'if',
      field('condition', $.expression),
      ':',
      $.newline,
      $.indent,
      field('consequence', repeat($.statement)),
      $.dedent,
      repeat($.elif_clause),
      optional($.else_clause),
    ),

    elif_clause: $ => seq(
      'elif',
      field('condition', $.expression),
      ':',
      $.newline,
      $.indent,
      field('body', repeat($.statement)),
      $.dedent,
    ),

    else_clause: $ => seq(
      'else',
      ':',
      $.newline,
      $.indent,
      field('body', repeat($.statement)),
      $.dedent,
    ),

    while_statement: $ => seq(
      'while',
      field('condition', $.expression),
      ':',
      $.newline,
      $.indent,
      field('body', repeat($.statement)),
      $.dedent,
    ),

    for_statement: $ => seq(
      'for',
      field('pattern', $.for_pattern),
      'in',
      field('iterable', $.expression),
      ':',
      $.newline,
      $.indent,
      field('body', repeat($.statement)),
      $.dedent,
    ),

    switch_statement: $ => seq(
      'switch',
      field('value', $.expression),
      ':',
      $.newline,
      $.indent,
      field('cases', repeat($.switch_case)),
      $.dedent,
    ),

    switch_case: $ => seq(
      choice(
        seq('case', field('value', $.expression)),
        'default',
      ),
      ':',
      $.newline,
      $.indent,
      field('body', repeat($.statement)),
      $.dedent,
    ),

    match_expression: $ => seq(
      'match',
      optional(seq('type', 'of')),
      field('value', $.expression),
      ':',
      $.newline,
      $.indent,
      field('cases', repeat1($.match_case)),
      repeat($.newline),
      $.dedent,
    ),

    match_case: $ => prec.right(seq(
      optional('case'),
      field('pattern', $.match_pattern),
      optional(seq('if', field('guard', $.expression))),
      ':',
      choice(
        seq(
          $.newline,
          $.indent,
          field('body', repeat($.statement)),
          $.dedent,
        ),
        seq(field('expression', $.match_expression)),
        seq(field('expression', $.expression), $.newline),
      ),
    )),

    pattern: $ => choice(
      $.identifier,
      $.wildcard_pattern,
      $.literal_pattern,
      $.list_pattern,
      $.tuple_pattern_pattern,
      $.cons_pattern,
      $.struct_pattern,
    ),

    for_pattern: $ => choice(
      $.identifier,
      $.tuple_pattern_pattern,
    ),

    match_pattern: $ => choice(
      $.type_pattern,
      $.enum_pattern,
      $.struct_pattern,
      $.cons_pattern,
      $.list_pattern,
      $.tuple_pattern_pattern,
      $.literal_pattern,
      $.wildcard_pattern,
      $.identifier,
    ),

    type_pattern: $ => seq(
      field('name', $.identifier),
      ':',
      field('type', $.type),
    ),

    enum_pattern: $ => seq(
      optional(seq(field('enum', $.identifier), '.')),
      field('variant', $.identifier),
      optional(seq('(', commaSep($.match_pattern), ')')),
    ),

    wildcard_pattern: _ => '_',

    literal_pattern: $ => choice(
      $.integer,
      $.float,
      $.string,
      $.triple_string,
      $.boolean,
      $.byte,
      'None',
    ),

    list_pattern: $ => seq('[', commaSep($.match_pattern), ']'),

    tuple_pattern_pattern: $ => seq('(', commaSep1($.match_pattern), ')'),

    cons_pattern: $ => prec.right(PREC.union, seq($.match_pattern, '::', $.match_pattern)),

    struct_pattern: $ => seq(
      optional(field('name', $.identifier)),
      '{',
      commaSep($.struct_pattern_field),
      '}',
    ),

    struct_pattern_field: $ => seq(
      field('name', $.identifier),
      optional(seq(':', field('value', $.match_pattern))),
    ),

    expression: $ => choice(
      $.identifier,
      $.self_expression,
      $.super_expression,
      $.integer,
      $.float,
      $.string,
      $.triple_string,
      $.byte,
      $.boolean,
      $.none_expression,
      $.list_expression,
      $.dict_expression,
      $.tuple_expression,
      $.parenthesized_expression,
      $.struct_literal,
      $.enum_variant_expression,
      $.match_expression,
      $.if_expression,
      $.list_comprehension,
      $.type_of_expression,
      $.call_expression,
      $.field_expression,
      $.index_expression,
      $.unary_expression,
      $.binary_expression,
      $.ternary_expression,
      $.try_expression,
    ),

    self_expression: _ => 'self',
    super_expression: _ => 'super',
    none_expression: _ => 'None',

    call_expression: $ => prec.left(PREC.postfix, seq(
      field('function', $._postfix_base),
      field('arguments', $.arguments),
    )),

    arguments: $ => seq('(', commaSep($.expression), ')'),

    field_expression: $ => prec.left(PREC.postfix, seq(
      field('object', $._postfix_base),
      '.',
      field('field', $.identifier),
    )),

    index_expression: $ => prec.left(PREC.postfix, seq(
      field('object', $._postfix_base),
      '[',
      field('index', choice($.slice, $.expression)),
      ']',
    )),

    _postfix_base: $ => choice(
      $.identifier,
      $.self_expression,
      $.super_expression,
      $.integer,
      $.float,
      $.string,
      $.byte,
      $.boolean,
      $.none_expression,
      $.list_expression,
      $.dict_expression,
      $.tuple_expression,
      $.parenthesized_expression,
      $.struct_literal,
      $.enum_variant_expression,
      $.call_expression,
      $.field_expression,
      $.index_expression,
    ),

    slice: $ => seq(
      optional($.expression),
      ':',
      optional($.expression),
    ),

    unary_expression: $ => prec(PREC.unary, seq(
      field('operator', choice('-', 'not')),
      field('argument', $.expression),
    )),

    binary_expression: $ => choice(
      prec.left(PREC.logicalOr, seq($.expression, 'or', $.expression)),
      prec.left(PREC.logicalAnd, seq($.expression, 'and', $.expression)),
      prec.left(PREC.compare, seq($.expression, choice('==', '!=', '<', '<=', '>', '>='), $.expression)),
      prec.left(PREC.sum, seq($.expression, choice('+', '-'), $.expression)),
      prec.left(PREC.product, seq($.expression, choice('*', '/', '%'), $.expression)),
    ),

    parenthesized_expression: $ => seq('(', $.expression, ')'),

    tuple_expression: $ => seq('(', commaSep1($.expression), ')'),

    list_expression: $ => seq('[', commaSep($.expression), ']'),

    dict_expression: $ => seq('{', commaSep($.dict_pair), '}'),

    dict_pair: $ => seq($.expression, ':', $.expression),

    struct_literal: $ => seq(
      field('name', $.identifier),
      '{',
      commaSep($.struct_field_init),
      '}',
    ),

    struct_field_init: $ => seq(
      field('name', $.identifier),
      ':',
      field('value', $.expression),
    ),

    enum_variant_expression: $ => prec.left(PREC.postfix, seq(
      field('enum', $.identifier),
      '.',
      field('variant', $.identifier),
      optional(seq('(', commaSep($.expression), ')')),
    )),

    if_expression: $ => prec.right(PREC.ternary, seq(
      'if',
      $.expression,
      ':',
      $.expression,
      'else',
      ':',
      $.expression,
    )),

    ternary_expression: $ => prec.right(PREC.ternary, seq(
      $.expression,
      '?',
      $.expression,
      ':',
      $.expression,
    )),

    try_expression: $ => prec(PREC.postfix, seq($._postfix_base, '?')),

    list_comprehension: $ => seq(
      '[',
      $.expression,
      'for',
      $.identifier,
      'in',
      $.expression,
      optional(seq('if', $.expression)),
      ']',
    ),

    type_of_expression: $ => seq('type', 'of', $.expression),

    type: $ => choice(
      prec.left(PREC.union, seq($.type_atom, repeat1(seq('|', $.type_atom)))),
      $.type_atom,
    ),

    type_atom: $ => choice(
      $.identifier,
      seq($.identifier, '[', commaSep1($.type), ']'),
      seq('(', commaSep($.type), ')', optional(seq('->', $.type))),
    ),

    module_name: $ => seq($.identifier, repeat(seq('.', $.identifier))),

    identifier: _ => /[A-Za-z_][A-Za-z0-9_]*/,
    integer: _ => /[0-9]+/,
    float: _ => /[0-9]+\.[0-9]*/,
    string: _ => token(choice(
      seq('"', repeat(choice(/[^"\\\n]/, /\\./)), '"'),
      seq("'", repeat(choice(/[^'\\\n]/, /\\./)), "'"),
    )),
    triple_string: _ => token(seq(
      "'''",
      repeat(choice(/[^']/, /'[^']/, /''[^']/)),
      "'''",
    )),
    byte: $ => token(seq("b'", repeat(choice(/[^'\\\n]/, /\\./)), "'")),
    boolean: _ => choice('True', 'False', 'true', 'false'),
    comment: _ => token(seq('#', /.*/)),
  },
});
