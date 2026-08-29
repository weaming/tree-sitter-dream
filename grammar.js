const PREC = {
  ternary: 1,
  union: 2,
  logicalOr: 3,
  logicalAnd: 4,
  bitwiseOr: 5,
  bitwiseXor: 6,
  bitwiseAnd: 7,
  compare: 8,
  shift: 9,
  sum: 10,
  product: 11,
  unary: 12,
  power: 13,
  postfix: 14,
};

function commaSep(rule) {
  return optional(seq(rule, repeat(seq(',', rule)), optional(',')));
}

function commaSep1(rule) {
  return seq(rule, repeat(seq(',', rule)), optional(','));
}

module.exports = grammar({
  name: 'dream',

  externals: $ => [
    $.indent,
    $.dedent,
    $.newline,
    $.lbrace,
    $.rbrace,
    $.lbracket,
    $.rbracket,
    $.lparen,
    $.rparen,
  ],

  extras: $ => [/[ \t\r\n]/, $.comment],

  word: $ => $.identifier,

  conflicts: $ => [
    [$.parenthesized_expression, $.tuple_expression],
    [$.source_file, $.statement],
    [$.top_level_item, $.statement],
    [$.pattern, $.type_pattern],
    [$.match_pattern, $.type_pattern],
    [$.match_expression, $.type_of_expression],
    [$.expression, $._postfix_base],
    [$.expression, $._postfixable_base],
    [$.expression, $.expression_statement],
    [$.return_statement, $.expression],
    [$.let_statement, $.expression],
    [$.match_case, $.expression],
    [$.field_assignment_statement, $._postfix_base],
  ],

  rules: {
    source_file: $ => repeat(choice($.top_level_item, $.newline)),

    top_level_item: $ => choice(
      $.from_import,
      $.import_statement,
      $.constant_definition,
      $.function_definition,
      $.struct_definition,
      $.interface_definition,
      $.enum_definition,
      $.impl_definition,
      $.statement,
    ),

    from_import: $ => seq(
      'from',
      field('module', choice(
        $.module_name,
        alias($.relative_module_name, $.module_name),
      )),
      'import',
      choice(
        field('names', commaSep1($.import_name)),
        seq(
          $.lparen,
          field('names', commaSep($.import_name)),
          $.rparen,
        ),
      ),
      $.newline,
    ),

    import_statement: $ => seq(
      'import',
      field('module', $.module_name),
      optional(seq('as', field('alias', $.identifier))),
      $.newline,
    ),

    import_name: $ => seq(
      choice(
        seq($.identifier, optional(seq('as', $.identifier))),
        '*',
      ),
    ),

    constant_definition: $ => seq(
      'const',
      field('name', $.identifier),
      optional(seq(':', field('type', $.type))),
      '=',
      field('value', $.expression),
      $.newline,
    ),

    statement_block: $ => repeat1($.statement),

    function_definition: $ => seq(
      optional('async'),
      'def',
      field('name', $.identifier),
      optional($.type_parameters),
      field('parameters', $.parameters),
      optional(seq('->', field('return_type', $.type))),
      ':',
      repeat1($.newline),
      $.indent,
      field('body', optional($.statement_block)),
      $.dedent,
    ),

    type_parameters: $ => seq(
      $.lbracket,
      commaSep1(choice($.identifier, $.bounded_type_parameter)),
      $.rbracket,
    ),

    bounded_type_parameter: $ => seq(
      field('name', $.identifier),
      ':',
      field('bound', $.type),
    ),

    parameters: $ => seq($.lparen, commaSep($.parameter), $.rparen),

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
      repeat1($.newline),
      $.indent,
      field('body', optional($.struct_member_block)),
      $.dedent,
    ),

    struct_member: $ => choice(
      $.newline,
      $.field_definition,
      $.embedded_field,
      $.function_definition,
    ),

    struct_member_block: $ => repeat1($.struct_member),

    embedded_field: $ => seq(
      field('type', $.type),
      $.newline,
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
      optional(seq('extends', field('parents', commaSep1($.interface_parent)))),
      ':',
      repeat1($.newline),
      $.indent,
      field('body', optional($.interface_member_block)),
      $.dedent,
    ),

    interface_parent: $ => seq(
      field('name', $.identifier),
      optional($.type_arguments),
    ),

    interface_member: $ => choice(
      $.newline,
      $.field_definition,
      $.interface_method,
      $.associated_type,
      $.associated_constant,
    ),

    interface_member_block: $ => repeat1($.interface_member),

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
          field('body', optional($.statement_block)),
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
      repeat1($.newline),
      $.indent,
      field('body', optional($.impl_member_block)),
      $.dedent,
    ),

    impl_member: $ => choice(
      $.newline,
      $.function_definition,
      $.associated_type_assignment,
      $.associated_constant_assignment,
    ),

    impl_member_block: $ => repeat1($.impl_member),

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

    type_arguments: $ => seq($.lbracket, commaSep1($.type), $.rbracket),

    enum_definition: $ => seq(
      'enum',
      field('name', $.identifier),
      optional($.type_parameters),
      ':',
      repeat1($.newline),
      $.indent,
      field('body', optional($.enum_member_block)),
      repeat($.newline),
      $.dedent,
    ),

    enum_member_variant: $ => seq(
      field('name', choice($.identifier, 'Some', 'None', 'Ok', 'Err', 'Option', 'Result')),
      optional(seq($.lparen, field('types', commaSep($.type)), $.rparen)),
      $.newline,
    ),

    enum_member_block: $ => repeat1($.enum_member_variant),

    statement: $ => choice(
      $.newline,
      $.constant_definition,
      $.let_statement,
      $.simple_assignment_statement,
      $.plus_assignment_statement,
      $.compound_assignment_statement,
      $.assignment_statement,
      $.field_assignment_statement,
      $.return_statement,
      $.print_statement,
      $.break_statement,
      $.continue_statement,
      $.with_statement,
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

    field_assignment_statement: $ => seq(
      field('object', choice($.identifier, $.self_expression)),
      '.',
      field('field', $.identifier),
      '=',
      field('value', $.expression),
      $.newline,
    ),

    assignment_statement: $ => seq(
      field('left', $.index_expression),
      '=',
      field('right', $.expression),
      $.newline,
    ),

    simple_assignment_statement: $ => seq(
      field('left', $.identifier),
      '=',
      field('right', $.expression),
      $.newline,
    ),

    plus_assignment_statement: $ => seq(
      field('left', $.identifier),
      '+=',
      field('right', $.expression),
      $.newline,
    ),

    compound_assignment_statement: $ => seq(
      field('left', $.identifier),
      field('operator', choice(
        '-=',
        '*=',
        '/=',
        '//=',
        '%=',
        '**=',
        '&=',
        '|=',
        '^=',
        '<<=',
        '>>=',
      )),
      field('right', $.expression),
      $.newline,
    ),

    return_statement: $ => choice(
      seq('return', field('value', $.match_expression)),
      seq('return', optional(field('value', $.expression)), $.newline),
    ),

    print_statement: $ => seq(
      field('function', choice('print', 'eprint')),
      $.lparen,
      optional(field('argument', commaSep1($.expression))),
      $.rparen,
      $.newline,
    ),

    break_statement: $ => seq('break', $.newline),

    continue_statement: $ => seq('continue', $.newline),

    expression_statement: $ => choice(
      $.match_expression,
      seq($.expression, $.newline),
    ),

    if_statement: $ => seq(
      'if',
      field('condition', $.expression),
      ':',
      repeat1($.newline),
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
      repeat1($.newline),
      $.indent,
      field('body', repeat($.statement)),
      $.dedent,
    ),

    else_clause: $ => seq(
      'else',
      ':',
      repeat1($.newline),
      $.indent,
      field('body', repeat($.statement)),
      $.dedent,
    ),

    while_statement: $ => seq(
      'while',
      field('condition', $.expression),
      ':',
      repeat1($.newline),
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
      repeat1($.newline),
      $.indent,
      field('body', repeat($.statement)),
      $.dedent,
    ),

    switch_statement: $ => seq(
      'switch',
      field('value', $.expression),
      ':',
      repeat1($.newline),
      $.indent,
      field('cases', repeat($.switch_case)),
      $.dedent,
    ),

    switch_case: $ => prec.right(seq(
      choice(
        seq('case', field('values', commaSep1($.expression))),
        'default',
      ),
      ':',
      repeat1($.newline),
      $.indent,
      field('body', repeat($.statement)),
      $.dedent,
    )),

    with_statement: $ => seq(
      'with',
      field('resource', $.expression),
      'as',
      field('name', $.identifier),
      ':',
      repeat1($.newline),
      $.indent,
      field('body', repeat($.statement)),
      $.dedent,
    ),

    match_expression: $ => seq(
      'match',
      optional(seq('type', 'of')),
      field('value', $.expression),
      ':',
      repeat1($.newline),
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
        seq(field('expression', $.match_expression), optional($.newline)),
        seq(
          repeat1($.newline),
          $.indent,
          field('body', repeat($.statement)),
          $.dedent,
        ),
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
      $.type_pattern,
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

    enum_pattern: $ => prec.dynamic(10, choice(
      seq(
        field('enum', choice($.identifier, 'Option', 'Result')),
        '.',
        field('variant', choice($.identifier, 'Some', 'None', 'Ok', 'Err')),
        optional(seq($.lparen, commaSep($.match_pattern), $.rparen)),
      ),
      seq(
        field('variant', choice('Some', 'Ok', 'Err')),
        $.lparen,
        commaSep($.match_pattern),
        $.rparen,
      ),
      seq(
        field('variant', $.identifier),
        $.lparen,
        commaSep($.match_pattern),
        $.rparen,
      ),
      field('variant', 'None'),
    )),

    wildcard_pattern: _ => '_',

    literal_pattern: $ => choice(
      $.integer,
      $.float,
      $.string,
      $.triple_string,
      $.boolean,
      $.rune,
      $.byte,
    ),

    list_pattern: $ => seq($.lbracket, commaSep($.match_pattern), $.rbracket),

    tuple_pattern_pattern: $ => seq($.lparen, commaSep1($.match_pattern), $.rparen),

    cons_pattern: $ => prec.right(PREC.union, seq($.match_pattern, '::', $.match_pattern)),

    struct_pattern: $ => seq(
      optional(field('name', $.identifier)),
      $.lbrace,
      commaSep($.struct_pattern_field),
      $.rbrace,
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
      $.rune,
      $.string,
      $.triple_string,
      $.byte,
      $.boolean,
      $.list_expression,
      $.dict_expression,
      $.tuple_expression,
      $.parenthesized_expression,
      $.struct_literal,
      $.enum_variant_expression,
      $.match_expression,
      $.if_expression,
      $.list_comprehension,
      $.lambda_expression,
      $.await_expression,
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

    call_expression: $ => prec.left(PREC.postfix, seq(
      field('function', $._postfixable_base),
      field('arguments', $.arguments),
    )),

    arguments: $ => seq($.lparen, commaSep($.expression), $.rparen),

    field_expression: $ => prec.left(PREC.postfix + 1, seq(
      field('object', $._postfixable_base),
      '.',
      field('field', $.identifier),
    )),

    index_expression: $ => prec.left(PREC.postfix, seq(
      field('object', $._postfixable_base),
      $.lbracket,
      field('index', choice($.slice, $.expression)),
      $.rbracket,
    )),

    _postfix_base: $ => choice(
      $.identifier,
      $.self_expression,
      $.super_expression,
      $.integer,
      $.float,
      $.rune,
      $.string,
      $.byte,
      $.boolean,
      $.list_expression,
      $.dict_expression,
      $.tuple_expression,
      $.parenthesized_expression,
      $.struct_literal,
      $.call_expression,
      $.field_expression,
      $.index_expression,
    ),

    _postfixable_base: $ => choice(
      $._postfix_base,
      $.enum_variant_expression,
    ),

    slice: $ => seq(
      optional($.expression),
      ':',
      optional($.expression),
    ),

    unary_expression: $ => prec(PREC.unary, seq(
      field('operator', choice('+', '-', 'not', '~')),
      field('argument', $.expression),
    )),

    binary_expression: $ => choice(
      prec.left(PREC.logicalOr, seq($.expression, 'or', $.expression)),
      prec.left(PREC.logicalAnd, seq($.expression, 'and', $.expression)),
      prec.left(PREC.bitwiseOr, seq($.expression, '|', $.expression)),
      prec.left(PREC.bitwiseXor, seq($.expression, '^', $.expression)),
      prec.left(PREC.bitwiseAnd, seq($.expression, '&', $.expression)),
      prec.left(PREC.compare, seq($.expression, 'not', 'in', $.expression)),
      prec.left(PREC.compare, seq($.expression, 'in', $.expression)),
      prec.left(PREC.compare, seq($.expression, choice('==', '!=', '<', '<=', '>', '>='), $.expression)),
      prec.left(PREC.shift, seq($.expression, choice('<<', '>>'), $.expression)),
      prec.left(PREC.sum, seq($.expression, choice('+', '-'), $.expression)),
      prec.left(PREC.product, seq($.expression, choice('*', '/', '//', '%'), $.expression)),
      prec.right(PREC.power, seq($.expression, '**', $.expression)),
    ),

    parenthesized_expression: $ => seq($.lparen, $.expression, $.rparen),

    tuple_expression: $ => seq($.lparen, commaSep1($.expression), $.rparen),

    list_expression: $ => seq($.lbracket, commaSep($.expression), $.rbracket),

    dict_expression: $ => seq($.lbrace, commaSep($.dict_pair), $.rbrace),

    dict_pair: $ => seq($.expression, ':', $.expression),

    struct_literal: $ => seq(
      field('name', $.identifier),
      $.lbrace,
      commaSep($.struct_field_init),
      $.rbrace,
    ),

    struct_field_init: $ => seq(
      field('name', $.identifier),
      ':',
      field('value', $.expression),
    ),

    enum_variant_expression: $ => prec.left(PREC.postfix + 1, seq(
      choice(
        seq(
          field('enum', choice($.identifier, 'Option', 'Result')),
          '.',
          field('variant', choice($.identifier, 'Some', 'None', 'Ok', 'Err')),
        ),
        field('variant', choice('Some', 'Ok', 'Err', 'None')),
      ),
      optional($.arguments),
    )),

    if_expression: $ => prec.right(PREC.ternary, seq(
      'if',
      field('condition', $.expression),
      ':',
      field('consequence', $.expression),
      'else',
      ':',
      field('alternative', $.expression),
    )),

    ternary_expression: $ => prec.right(PREC.ternary, seq(
      field('condition', $.expression),
      '?',
      field('consequence', $.expression),
      ':',
      field('alternative', $.expression),
    )),

    try_expression: $ => prec(PREC.postfix, seq(field('value', $._postfixable_base), '?')),

    list_comprehension: $ => seq(
      $.lbracket,
      $.expression,
      'for',
      $.identifier,
      'in',
      $.expression,
      optional(seq('if', $.expression)),
      $.rbracket,
    ),

    lambda_expression: $ => seq(
      'lambda',
      field('parameters', $.parameters),
      '->',
      field('body', $.expression),
    ),

    await_expression: $ => prec(PREC.unary, seq(
      'await',
      field('argument', $.expression),
    )),

    type_of_expression: $ => seq('type', 'of', field('value', $.expression)),

    type: $ => choice(
      prec.left(PREC.union, seq($.type_atom, repeat1(seq('|', $.type_atom)))),
      $.type_atom,
    ),

    type_atom: $ => choice(
      $.identifier,
      seq($.identifier, $.lbracket, commaSep1($.type), $.rbracket),
      seq($.lbracket, $.type, $.rbracket),
      seq($.lparen, commaSep($.type), $.rparen, optional(seq('->', $.type))),
    ),

    module_name: $ => seq($.identifier, repeat(seq('.', $.identifier))),
    relative_module_name: $ => seq(
      repeat1('.'),
      $.identifier,
      repeat(seq('.', $.identifier)),
    ),

    identifier: _ => /[A-Za-z_][A-Za-z0-9_]*/,
    integer: _ => token(choice(
      /0[xX][0-9A-Fa-f]+/,
      /[0-9]+/,
    )),
    float: _ => /[0-9]+\.[0-9]*/,
    rune: _ => token(prec(2, choice(
      seq("'", /[^'\\\n]/, "'"),
      seq("'", /\\./, "'"),
    ))),
    string: _ => token(choice(
      seq('"', repeat(choice(/[^"\\\n]/, /\\./)), '"'),
      prec(1, seq("'", repeat1(choice(/[^'\\\n]/, /\\./)), "'")),
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
