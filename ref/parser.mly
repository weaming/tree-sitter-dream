%{
  open Ast

  (* 从 type_expr 提取类型名称字符串，使用 Buffer 避免中间字符串分配 *)
  let type_expr_to_string ty =
    let buf = Buffer.create 32 in
    let rec aux = function
      | TInt -> Buffer.add_string buf "int"
      | TFloat -> Buffer.add_string buf "float"
      | TStr -> Buffer.add_string buf "str"
      | TRune -> Buffer.add_string buf "rune"
      | TByte -> Buffer.add_string buf "byte"
      | TBytes -> Buffer.add_string buf "bytes"
      | TBool -> Buffer.add_string buf "bool"
      | TNone -> Buffer.add_string buf "None"
      | TVar name -> Buffer.add_string buf name
      | TList ty ->
          Buffer.add_string buf "list[";
          aux ty;
          Buffer.add_char buf ']'
      | TTuple tys ->
          Buffer.add_char buf '(';
          let first = ref true in
          List.iter (fun ty ->
            if !first then first := false
            else Buffer.add_string buf ", ";
            aux ty
          ) tys;
          Buffer.add_char buf ')'
      | TUnion tys ->
          let first = ref true in
          List.iter (fun ty ->
            if !first then first := false
            else Buffer.add_string buf " | ";
            aux ty
          ) tys
      | TDict (k, v) ->
          Buffer.add_string buf "dict[";
          aux k;
          Buffer.add_string buf ", ";
          aux v;
          Buffer.add_char buf ']'
      | TOption ty ->
          Buffer.add_string buf "Option[";
          aux ty;
          Buffer.add_char buf ']'
      | TResult (ok, err) ->
          Buffer.add_string buf "Result[";
          aux ok;
          Buffer.add_string buf ", ";
          aux err;
          Buffer.add_char buf ']'
      | TEnum (name, _) -> Buffer.add_string buf name
      | TStruct (name, _) -> Buffer.add_string buf name
      | TFunc (params, ret) ->
          Buffer.add_char buf '(';
          let first = ref true in
          List.iter (fun ty ->
            if !first then first := false
            else Buffer.add_string buf ", ";
            aux ty
          ) params;
          Buffer.add_string buf ") -> ";
          aux ret
      | TGeneric (name, _) -> Buffer.add_string buf name
      | TSelf -> Buffer.add_string buf "Self"
    in
    aux ty;
    Buffer.contents buf

  let get_expr_pos = function
    | EInt (_, p) | EFloat (_, p) | EString (_, p) | ERune (_, p) | EByte (_, p) | EBool (_, p)
    | EVar (_, p) | EBinOp (_, _, _, p) | EUnOp (_, _, p)
    | ECall (_, _, p) | EList (_, p) | EDict (_, p) | ETuple (_, p)
    | EIndex (_, _, p) | ESlice (_, _, _, p) | EAttr (_, _, p) | ELambda (_, _, p)
    | EIf (_, _, _, p) | EMatch (_, _, p) | EListComp (_, _, _, _, p)
    | EEnumVariant (_, _, _, p) | EStructLiteral (_, _, p) | EStructAccess (_, _, p)
    | ETernary (_, _, _, p) | ETry (_, p) | ETypeOf (_, p) -> p

  (* 从 Lexing.position 创建 AST position *)
  (* VSCode 使用 0-based 行号，所以减 1 *)
  let make_position (pos : Lexing.position) =
    { line = pos.pos_lnum - 1; column = pos.pos_cnum - pos.pos_bol }

  let compound_assign name operation value pos =
    let position = make_position pos in
    let left = EVar (name, position) in
    SAssign (name, EBinOp (left, operation, value, position), position)
%}

%token <int> INT
%token <float> FLOAT
%token <string> STRING
%token <int> RUNE
%token <int> BYTE
%token <bool> BOOL
%token <string> IDENT
%token LET LAMBDA DEF STRUCT INTERFACE IMPL TYPE CONST ENUM
%token IF WITH ELSE ELIF SWITCH MATCH CASE DEFAULT FOR WHILE BREAK CONTINUE RETURN
%token IMPORT FROM AS OF ASYNC AWAIT SELF SUPER IN
%token SOME NONE OK ERR OPTION RESULT
%token PLUS MINUS TIMES DIV FLOORDIV MOD POW
%token AMP CARET TILDE SHL SHR
%token EQ NEQ LT GT LTE GTE
%token AND OR NOT
%token ASSIGN PLUS_ASSIGN MINUS_ASSIGN TIMES_ASSIGN DIV_ASSIGN FLOORDIV_ASSIGN MOD_ASSIGN POW_ASSIGN
%token AMP_ASSIGN PIPE_ASSIGN CARET_ASSIGN SHL_ASSIGN SHR_ASSIGN
%token <string * string> FIELD_ASSIGN
%token ARROW PIPE UNDERSCORE
%token LPAREN RPAREN LBRACKET RBRACKET LBRACE RBRACE
%token COMMA COLON DOT QUESTION CONS
%token INDENT DEDENT NEWLINE
%token EOF

%right QUESTION COLON  (* 三元运算符优先级最低 *)
%right CONS  (* :: 右结合,用于列表模式匹配 *)
%left OR
%left AND
%left EQ NEQ LT GT LTE GTE IN
%left PIPE  (* 位或 |，类型注解中的 union 也复用该 token *)
%left CARET
%left AMP
%left SHL SHR
%left PLUS MINUS
%left TIMES DIV FLOORDIV MOD
%right NOT
%right UMINUS UPLUS TILDE  (* 一元负号/正号/按位取反 *)
%right POW  (* 幂运算右结合 *)
%left AS
%left LPAREN LBRACKET
%left DOT

%start <Ast.program> program

%%

program:
  | stmts = statement_list EOF { stmts }

statement_list:
  | newline_sep { [] }
  | newline_sep s = statement newline_sep ss = statement_list { s :: ss }

newline_sep:
  | { () }
  | NEWLINE newline_sep { () }

statement:
  | e = expr { SExpr (e, get_expr_pos e) }
  | CONST name = IDENT ASSIGN value = expr
      { SConst {
          const_name = name;
          const_name_pos = make_position $startpos(name);
          const_type = None;
          const_value = value;
          const_pos = make_position $startpos;
        } }
  | CONST name = IDENT COLON ty = type_expr ASSIGN value = expr
      { SConst {
          const_name = name;
          const_name_pos = make_position $startpos(name);
          const_type = Some ty;
          const_value = value;
          const_pos = make_position $startpos;
        } }
  | LET name = IDENT ASSIGN value = expr
      { SLet {
          let_name = name;
          let_name_pos = make_position $startpos(name);
          let_type = None;
          let_value = value;
          let_pos = make_position $startpos;
        } }
  | LET name = IDENT COLON ty = type_expr ASSIGN value = expr
      { SLet {
          let_name = name;
          let_name_pos = make_position $startpos(name);
          let_type = Some ty;
          let_value = value;
          let_pos = make_position $startpos;
        } }
  | LET pat = pattern ASSIGN value = expr
      { SLetPat (pat, value, make_position $startpos) }
  | arr = expr LBRACKET idx = expr RBRACKET ASSIGN value = expr
      { SIndexAssign (arr, idx, value, get_expr_pos arr) }
  | name = IDENT ASSIGN value = expr
      { SAssign (name, value, make_position $startpos(name)) }
  | name = IDENT PLUS_ASSIGN value = expr
      { compound_assign name Add value $startpos(name) }
  | name = IDENT MINUS_ASSIGN value = expr
      { compound_assign name Sub value $startpos(name) }
  | name = IDENT TIMES_ASSIGN value = expr
      { compound_assign name Mul value $startpos(name) }
  | name = IDENT DIV_ASSIGN value = expr
      { compound_assign name Div value $startpos(name) }
  | name = IDENT FLOORDIV_ASSIGN value = expr
      { compound_assign name FloorDiv value $startpos(name) }
  | name = IDENT MOD_ASSIGN value = expr
      { compound_assign name Mod value $startpos(name) }
  | name = IDENT POW_ASSIGN value = expr
      { compound_assign name Pow value $startpos(name) }
  | name = IDENT AMP_ASSIGN value = expr
      { compound_assign name BitAnd value $startpos(name) }
  | name = IDENT PIPE_ASSIGN value = expr
      { compound_assign name BitOr value $startpos(name) }
  | name = IDENT CARET_ASSIGN value = expr
      { compound_assign name BitXor value $startpos(name) }
  | name = IDENT SHL_ASSIGN value = expr
      { compound_assign name Shl value $startpos(name) }
  | name = IDENT SHR_ASSIGN value = expr
      { compound_assign name Shr value $startpos(name) }
  | DEF name = IDENT LPAREN params = separated_list(COMMA, param) RPAREN COLON newline_sep INDENT body = statement_list DEDENT
      { SDef {
          def_name = name;
          def_name_pos = make_position $startpos(name);
          def_type_params = [];
          def_params = params;
          def_return_type = None;
          def_body = body;
          def_pos = make_position $startpos;
        } }
  | DEF name = IDENT LPAREN params = separated_list(COMMA, param) RPAREN ARROW ret = type_expr COLON newline_sep INDENT body = statement_list DEDENT
      { SDef {
          def_name = name;
          def_name_pos = make_position $startpos(name);
          def_type_params = [];
          def_params = params;
          def_return_type = Some ret;
          def_body = body;
          def_pos = make_position $startpos;
        } }
  | DEF name = IDENT LBRACKET type_params = separated_list(COMMA, IDENT) RBRACKET LPAREN params = separated_list(COMMA, param) RPAREN COLON newline_sep INDENT body = statement_list DEDENT
      { SDef {
          def_name = name;
          def_name_pos = make_position $startpos(name);
          def_type_params = type_params;
          def_params = params;
          def_return_type = None;
          def_body = body;
          def_pos = make_position $startpos;
        } }
  | DEF name = IDENT LBRACKET type_params = separated_list(COMMA, IDENT) RBRACKET LPAREN params = separated_list(COMMA, param) RPAREN ARROW ret = type_expr COLON newline_sep INDENT body = statement_list DEDENT
      { SDef {
          def_name = name;
          def_name_pos = make_position $startpos(name);
          def_type_params = type_params;
          def_params = params;
          def_return_type = Some ret;
          def_body = body;
          def_pos = make_position $startpos;
        } }
  | BREAK
      { SBreak (make_position $startpos) }
  | CONTINUE
      { SContinue (make_position $startpos) }
  | RETURN
      { SReturn (None, { line = 0; column = 0 }) }
  | RETURN e = expr
      { SReturn (Some e, get_expr_pos e) }
  | IF cond = expr COLON newline_sep INDENT then_body = statement_list DEDENT newline_sep elifs = elif_list else_part = else_opt
      { SIf (cond, then_body, elifs, else_part, get_expr_pos cond) }
  | SWITCH value = expr COLON newline_sep INDENT cases = switch_case_list DEDENT
      { match cases with
        | ([], None) -> SExpr (value, get_expr_pos value)
        | ([], Some _) -> SExpr (value, get_expr_pos value)
        | (first_case, first_body) :: rest, default_body ->
            let position = get_expr_pos value in
            let make_condition case_value = EBinOp (value, Eq, case_value, position) in
            let elifs = List.map (fun (case_value, body) -> (make_condition case_value, body)) rest in
            SIf (make_condition first_case, first_body, elifs, default_body, position) }
  | WHILE cond = expr COLON newline_sep INDENT body = statement_list DEDENT
      { SWhile (cond, body, get_expr_pos cond) }
  | FOR pat = for_pattern IN iter = expr COLON newline_sep INDENT body = statement_list DEDENT
      { SFor (pat, iter, body, get_expr_pos iter) }
  | WITH resource = expr AS name = IDENT COLON newline_sep INDENT body = statement_list DEDENT
      { let position = get_expr_pos resource in
        let binding = SLet {
          let_name = name;
          let_name_pos = make_position $startpos(name);
          let_type = None;
          let_value = resource;
          let_pos = position;
        } in
        let close_call = EEnumVariant (name, "close", [], position) in
        SIf (EBool (true, position), binding :: body @ [SExpr (close_call, position)],
          [], None, position) }
  | MATCH e = expr COLON newline_sep INDENT cases = expr_case_list DEDENT
      { SExpr (EMatch (e, cases, get_expr_pos e), get_expr_pos e) }
  | MATCH TYPE OF e = expr COLON newline_sep INDENT cases = type_case_list DEDENT
      { SExpr (EMatch (ETypeOf (e, get_expr_pos e), cases, get_expr_pos e), get_expr_pos e) }
  | INTERFACE name = IDENT COLON newline_sep INDENT members = interface_member_list DEDENT
      { SInterface {
          interface_name = name;
          interface_name_pos = make_position $startpos(name);
          interface_type_params = [];
          interface_members = members;
          interface_pos = make_position $startpos;
        } }
  | INTERFACE name = IDENT LBRACKET type_params = separated_list(COMMA, IDENT) RBRACKET COLON newline_sep INDENT members = interface_member_list DEDENT
      { SInterface {
          interface_name = name;
          interface_name_pos = make_position $startpos(name);
          interface_type_params = type_params;
          interface_members = members;
          interface_pos = make_position $startpos;
        } }
  | IMPL interface_name = IDENT FOR target = type_expr COLON newline_sep INDENT members = impl_member_list DEDENT
      { SImpl ({ impl_interface = Some interface_name;
                 impl_type_params = [];
                 impl_target = target;
                 impl_members = members;
                 impl_pos = { line = 0; column = 0 } }, { line = 0; column = 0 }) }
  | IMPL interface_name = IDENT LBRACKET type_params = separated_list(COMMA, type_expr) RBRACKET FOR target = type_expr COLON newline_sep INDENT members = impl_member_list DEDENT
      { SImpl ({ impl_interface = Some interface_name;
                 impl_type_params = List.map type_expr_to_string type_params;
                 impl_target = target;
                 impl_members = members;
                 impl_pos = { line = 0; column = 0 } }, { line = 0; column = 0 }) }
  | STRUCT name = IDENT COLON newline_sep INDENT members = struct_member_list DEDENT
      { SStruct {
          struct_name = name;
          struct_name_pos = make_position $startpos(name);
          struct_type_params = [];
          struct_members = members;
          struct_pos = make_position $startpos;
        } }
  | STRUCT name = IDENT LBRACKET type_params = separated_list(COMMA, IDENT) RBRACKET COLON newline_sep INDENT members = struct_member_list DEDENT
      { SStruct {
          struct_name = name;
          struct_name_pos = make_position $startpos(name);
          struct_type_params = type_params;
          struct_members = members;
          struct_pos = make_position $startpos;
        } }
  | ENUM name = IDENT COLON newline_sep INDENT variants = enum_variant_list DEDENT
      { SEnum {
          enum_name = name;
          enum_name_pos = make_position $startpos(name);
          enum_type_params = [];
          enum_variants = variants;
          enum_pos = make_position $startpos;
        } }
  | ENUM name = IDENT LBRACKET type_params = separated_list(COMMA, IDENT) RBRACKET COLON newline_sep INDENT variants = enum_variant_list DEDENT
      { SEnum {
          enum_name = name;
          enum_name_pos = make_position $startpos(name);
          enum_type_params = type_params;
          enum_variants = variants;
          enum_pos = make_position $startpos;
        } }
  | target = FIELD_ASSIGN value = expr
      { let (object_name, field_name) = target in
        let object_expression = EVar (object_name, make_position $startpos) in
        SFieldAssign (object_expression, field_name, value, make_position $startpos) }
  | IMPORT modules = separated_list(DOT, IDENT)
      { SImport (modules, None, { line = 0; column = 0 }) }
  | IMPORT modules = separated_list(DOT, IDENT) AS alias = IDENT
      { SImport (modules, Some alias, { line = 0; column = 0 }) }
  | FROM module_path = import_module_path IMPORT names = import_names
      { SFromImport (module_path, names, { line = 0; column = 0 }) }

import_module_path:
  | components = separated_nonempty_list(DOT, IDENT) { components }
  | depth = relative_import_prefix components = separated_nonempty_list(DOT, IDENT)
      { List.init depth (fun _ -> "") @ components }

relative_import_prefix:
  | DOT { 1 }
  | DOT depth = relative_import_prefix { depth + 1 }

import_names:
  | names = separated_list(COMMA, import_name) { names }
  | LPAREN RPAREN { [] }
  | LPAREN names = separated_nonempty_list(COMMA, import_name) RPAREN { names }
  | LPAREN names = separated_nonempty_list(COMMA, import_name) COMMA RPAREN { names }

import_name:
  | name = IDENT { (name, None) }
  | name = IDENT AS alias = IDENT { (name, Some alias) }
  | TIMES { ("*", None) }

elif_list:
  | { [] }
  | ELIF cond = expr COLON newline_sep INDENT body = statement_list DEDENT newline_sep rest = elif_list
      { (cond, body) :: rest }

else_opt:
  | { None }
  | ELSE COLON newline_sep INDENT body = statement_list DEDENT
      { Some body }

switch_case_list:
  | { ([], None) }
  | CASE values = separated_nonempty_list(COMMA, expr) COLON newline_sep INDENT body = statement_list DEDENT newline_sep rest = switch_case_list
      { let (cases, default_body) = rest in
        (List.fold_right (fun value accumulated -> (value, body) :: accumulated)
          values cases, default_body) }
  | DEFAULT COLON newline_sep INDENT body = statement_list DEDENT
      { ([], Some body) }

type_case_list:
  | { [] }
  | ty = type_expr COLON newline_sep body = expr newline_sep rest = type_case_list
      { let type_str = match ty with
          | TInt -> "int"
          | TFloat -> "float"
          | TStr -> "str"
          | TRune -> "rune"
          | TByte -> "byte"
          | TBytes -> "bytes"
          | TBool -> "bool"
          | TNone -> "None"
          | TVar name -> name
          | _ -> "_unknown_"
        in
        (PString type_str, None, MExpr body) :: rest }
  | ty = type_expr COLON newline_sep INDENT body = statement_list DEDENT newline_sep rest = type_case_list
      { let type_str = match ty with
          | TInt -> "int"
          | TFloat -> "float"
          | TStr -> "str"
          | TRune -> "rune"
          | TByte -> "byte"
          | TBytes -> "bytes"
          | TBool -> "bool"
          | TNone -> "None"
          | TVar name -> name
          | _ -> "_unknown_"
        in
        (PString type_str, None, MStmts body) :: rest }
  | UNDERSCORE COLON newline_sep body = expr newline_sep rest = type_case_list
      { (PWildcard, None, MExpr body) :: rest }
  | UNDERSCORE COLON newline_sep INDENT body = statement_list DEDENT newline_sep rest = type_case_list
      { (PWildcard, None, MStmts body) :: rest }

expr_case_list:
  | { [] }
  | CASE p = match_pattern IF guard = expr COLON newline_sep body = expr newline_sep rest = expr_case_list
      { (p, Some guard, MExpr body) :: rest }
  | CASE p = match_pattern COLON newline_sep body = expr newline_sep rest = expr_case_list
      { (p, None, MExpr body) :: rest }
  | CASE p = match_pattern IF guard = expr COLON newline_sep INDENT body = statement_list DEDENT newline_sep rest = expr_case_list
      { (p, Some guard, MStmts body) :: rest }
  | CASE p = match_pattern COLON newline_sep INDENT body = statement_list DEDENT newline_sep rest = expr_case_list
      { (p, None, MStmts body) :: rest }
  | p = match_pattern IF guard = expr COLON newline_sep body = expr newline_sep rest = expr_case_list
      { (p, Some guard, MExpr body) :: rest }
  | p = match_pattern COLON newline_sep body = expr newline_sep rest = expr_case_list
      { (p, None, MExpr body) :: rest }
  | p = match_pattern IF guard = expr COLON newline_sep name = IDENT ASSIGN value = expr newline_sep rest = expr_case_list
      { (p, Some guard, MStmts [SAssign (name, value, { line = 0; column = 0 })]) :: rest }
  | p = match_pattern COLON newline_sep name = IDENT ASSIGN value = expr newline_sep rest = expr_case_list
      { (p, None, MStmts [SAssign (name, value, { line = 0; column = 0 })]) :: rest }
  | p = match_pattern IF guard = expr COLON newline_sep INDENT body = statement_list DEDENT newline_sep rest = expr_case_list
      { (p, Some guard, MStmts body) :: rest }
  | p = match_pattern COLON newline_sep INDENT body = statement_list DEDENT newline_sep rest = expr_case_list
      { (p, None, MStmts body) :: rest }

interface_member_list:
  | { [] }
  | m = interface_member NEWLINE* ms = interface_member_list { m :: ms }

interface_member:
  | name = IDENT COLON ty = type_expr
      { IField (name, ty, { line = 0; column = 0 }) }
  | DEF name = IDENT LPAREN params = separated_list(COMMA, param) RPAREN
      { IMethod (name, [], params, None, None, { line = 0; column = 0 }) }
  | DEF name = IDENT LPAREN params = separated_list(COMMA, param) RPAREN COLON newline_sep INDENT body = statement_list DEDENT
      { IMethod (name, [], params, None, Some body, { line = 0; column = 0 }) }
  | DEF name = IDENT LPAREN params = separated_list(COMMA, param) RPAREN ARROW ret = type_expr
      { IMethod (name, [], params, Some ret, None, { line = 0; column = 0 }) }
  | DEF name = IDENT LPAREN params = separated_list(COMMA, param) RPAREN ARROW ret = type_expr COLON newline_sep INDENT body = statement_list DEDENT
      { IMethod (name, [], params, Some ret, Some body, { line = 0; column = 0 }) }
  | TYPE assoc_name = IDENT
      { IAssocType (assoc_name, None, { line = 0; column = 0 }) }
  | TYPE assoc_name = IDENT ASSIGN assoc_ty = type_expr
      { IAssocType (assoc_name, Some assoc_ty, { line = 0; column = 0 }) }
  | CONST const_name = IDENT COLON const_ty = type_expr ASSIGN const_val = expr
      { IAssocConst (const_name, const_ty, const_val, { line = 0; column = 0 }) }

impl_member_list:
  | { [] }
  | m = impl_member NEWLINE* ms = impl_member_list { m :: ms }

impl_member:
  | DEF name = IDENT LPAREN params = separated_list(COMMA, param) RPAREN COLON newline_sep INDENT body = statement_list DEDENT
      { ImplMethod (name, [], params, None, body, { line = 0; column = 0 }) }
  | DEF name = IDENT LPAREN params = separated_list(COMMA, param) RPAREN ARROW ret = type_expr COLON newline_sep INDENT body = statement_list DEDENT
      { ImplMethod (name, [], params, Some ret, body, { line = 0; column = 0 }) }
  | TYPE assoc_name = IDENT ASSIGN assoc_ty = type_expr
      { ImplAssocType (assoc_name, assoc_ty, { line = 0; column = 0 }) }
  | CONST const_name = IDENT ASSIGN const_val = expr
      { ImplAssocConst (const_name, const_val, { line = 0; column = 0 }) }

struct_member_list:
  | { [] }
  | m = struct_member NEWLINE* ms = struct_member_list { m :: ms }

struct_member:
  | name = IDENT COLON ty = type_expr
      { SField { field_name = Some name; field_type = ty; field_pos = make_position $startpos } }
  | ty = type_expr
      { SField { field_name = None; field_type = ty; field_pos = make_position $startpos } }
  | DEF name = IDENT LPAREN params = separated_list(COMMA, param) RPAREN COLON newline_sep INDENT body = statement_list DEDENT
      { SMethod (name, [], params, None, body, make_position $startpos) }
  | DEF name = IDENT LPAREN params = separated_list(COMMA, param) RPAREN ARROW ret = type_expr COLON newline_sep INDENT body = statement_list DEDENT
      { SMethod (name, [], params, Some ret, body, make_position $startpos) }

enum_variant_list:
  | { [] }
  | v = enum_variant NEWLINE* vs = enum_variant_list { v :: vs }

variant_name:
  | name = IDENT { name }
  | SOME { "Some" }
  | NONE { "None" }
  | OK { "Ok" }
  | ERR { "Err" }
  | OPTION { "Option" }
  | RESULT { "Result" }

enum_variant:
  | name = variant_name
      { VSimple (name, { line = 0; column = 0 }) }
  | name = variant_name LPAREN types = separated_list(COMMA, type_expr) RPAREN
      { VTuple (name, types, { line = 0; column = 0 }) }

param:
  | name = IDENT { (name, None, None) }
  | name = IDENT COLON ty = type_expr { (name, Some ty, None) }
  | name = IDENT COLON ty = type_expr ASSIGN default_value = expr { (name, Some ty, Some default_value) }
  | SELF { ("self", None, None) }
  | SELF COLON ty = type_expr { ("self", Some ty, None) }

pattern:
  | n = INT { PInt n }
  | f = FLOAT { PFloat f }
  | s = STRING { PString s }
  | r = RUNE { PRune r }
  | by = BYTE { PByte by }
  | b = BOOL { PBool b }
  | UNDERSCORE { PWildcard }
  | LPAREN patterns = separated_list(COMMA, pattern) RPAREN
      { match patterns with
        | [p] -> p  (* 单个模式，不是元组 *)
        | _ -> PTuple patterns
      }
  | LBRACKET RBRACKET { PList [] }  (* 空列表 *)
  | LBRACKET patterns = separated_list(COMMA, pattern) RBRACKET { PList patterns }  (* 列表模式: [x, y, z] *)
  | p1 = pattern CONS p2 = pattern { PCons (p1, p2) }  (* Cons模式: head :: tail *)
  | LBRACE fields = separated_list(COMMA, struct_pattern_field) RBRACE
      { PStruct ("", fields) }  (* 匿名结构体模式: {x, y} 或 {x: a, y: b}，结构体名从类型推断 *)
  | struct_name = IDENT LBRACE fields = separated_list(COMMA, struct_pattern_field) RBRACE
      { PStruct (struct_name, fields) }  (* 命名结构体模式: StructName{field1: pattern1, field2: pattern2} *)
  | enum_name = IDENT DOT variant_name = IDENT LPAREN patterns = separated_list(COMMA, pattern) RPAREN
      { PEnumVariant (enum_name, variant_name, patterns) }
  | enum_name = IDENT DOT variant_name = IDENT
      { PEnumVariant (enum_name, variant_name, []) }
  | variant_name = IDENT LPAREN patterns = separated_list(COMMA, pattern) RPAREN
      { PEnumVariant ("", variant_name, patterns) }
  | name = IDENT
      { (* None 单独出现时作为枚举变体，其他作为变量 *)
        if name = "None" then PEnumVariant ("", "None", [])
        else PVar name
      }

match_pattern:
  | n = INT { PInt n }
  | f = FLOAT { PFloat f }
  | s = STRING { PString s }
  | r = RUNE { PRune r }
  | by = BYTE { PByte by }
  | b = BOOL { PBool b }
  | UNDERSCORE { PWildcard }
  | LPAREN patterns = separated_list(COMMA, match_pattern) RPAREN
      { match patterns with
        | [p] -> p
        | _ -> PTuple patterns
      }
  | LBRACKET RBRACKET { PList [] }  (* 空列表 *)
  | LBRACKET patterns = separated_list(COMMA, match_pattern) RBRACKET { PList patterns }  (* 列表模式: [x, y, z] *)
  | p1 = match_pattern CONS p2 = match_pattern { PCons (p1, p2) }  (* Cons模式: head :: tail *)
  | struct_name = IDENT LBRACE fields = separated_list(COMMA, struct_pattern_field_match) RBRACE
      { PStruct (struct_name, fields) }  (* 结构体模式: StructName{field1: pattern1, field2: pattern2} *)
  | OPTION DOT SOME LPAREN patterns = separated_list(COMMA, match_pattern) RPAREN
      { PEnumVariant ("Option", "Some", patterns) }
  | OPTION DOT NONE
      { PEnumVariant ("Option", "None", []) }
  | RESULT DOT OK LPAREN patterns = separated_list(COMMA, match_pattern) RPAREN
      { PEnumVariant ("Result", "Ok", patterns) }
  | RESULT DOT ERR LPAREN patterns = separated_list(COMMA, match_pattern) RPAREN
      { PEnumVariant ("Result", "Err", patterns) }
  | enum_name = IDENT DOT variant_name = IDENT LPAREN patterns = separated_list(COMMA, match_pattern) RPAREN
      { PEnumVariant (enum_name, variant_name, patterns) }
  | enum_name = IDENT DOT variant_name = IDENT
      { PEnumVariant (enum_name, variant_name, []) }
  | SOME LPAREN patterns = separated_list(COMMA, match_pattern) RPAREN
      { PEnumVariant ("Option", "Some", patterns) }
  | NONE
      { PEnumVariant ("Option", "None", []) }
  | OK LPAREN patterns = separated_list(COMMA, match_pattern) RPAREN
      { PEnumVariant ("Result", "Ok", patterns) }
  | ERR LPAREN patterns = separated_list(COMMA, match_pattern) RPAREN
      { PEnumVariant ("Result", "Err", patterns) }
  | variant_name = IDENT LPAREN patterns = separated_list(COMMA, match_pattern) RPAREN
      { PEnumVariant ("", variant_name, patterns) }
  | name = IDENT
      { PVar name }

for_pattern:
  | name = IDENT { PVar name }
  | LPAREN patterns = separated_list(COMMA, for_pattern) RPAREN { PTuple patterns }

type_expr:
  | RESULT LBRACKET ty1 = type_expr COMMA ty2 = type_expr RBRACKET {
      (* 支持 Result[T, E] 语法 *)
      TResult (ty1, ty2)
    }
  | name = IDENT LBRACKET key_type = type_expr COMMA value_type = type_expr RBRACKET {
      match name with
      | "dict" -> TDict (key_type, value_type)
      | "Result" -> TResult (key_type, value_type)
      | _ -> TGeneric (name, TTuple [key_type; value_type])
    }
  | name = IDENT LBRACKET ty = type_expr RBRACKET {
      (* 支持 list[T]、Option[T] 和接口/泛型类型语法 *)
      match name with
      | "list" -> TList ty
      | "Option" -> TOption ty
      | _ -> TGeneric (name, ty)
    }
  | IDENT { match $1 with
      | "int" -> TInt
      | "float" -> TFloat
      | "str" -> TStr
      | "rune" -> TRune
      | "byte" -> TByte
      | "bytes" -> TBytes
      | "bool" -> TBool
      | "Self" -> TSelf
      | name -> TVar name
    }
  | LBRACKET ty = type_expr RBRACKET { TList ty }
  | LPAREN params = separated_list(COMMA, type_expr) RPAREN ARROW ret = type_expr
      { TFunc (params, ret) }
  | LPAREN tys = separated_list(COMMA, type_expr) RPAREN { TTuple tys }
  | ty1 = type_expr PIPE ty2 = type_expr {
      (* 扁平化嵌套的TUnion: int | string | bool -> TUnion [int; string; bool] *)
      let flatten_union t =
        match t with
        | TUnion ts -> ts
        | _ -> [t]
      in
      TUnion (flatten_union ty1 @ flatten_union ty2)
    }

expr:
  | LAMBDA LPAREN params = separated_list(COMMA, lambda_param) RPAREN ARROW body = expr
      { ELambda (params, body, make_position $startpos) }
  | n = INT { EInt (n, make_position $startpos) }
  | f = FLOAT { EFloat (f, make_position $startpos) }
  | s = STRING { EString (s, make_position $startpos) }
  | r = RUNE { ERune (r, make_position $startpos) }
  | by = BYTE { EByte (by, make_position $startpos) }
  | b = BOOL { EBool (b, make_position $startpos) }
  | name = IDENT { EVar (name, make_position $startpos) }
  | SELF { EVar ("self", make_position $startpos) }
  | e1 = expr POW e2 = expr { EBinOp (e1, Pow, e2, { line = 0; column = 0 }) }
  | e1 = expr TIMES e2 = expr { EBinOp (e1, Mul, e2, { line = 0; column = 0 }) }
  | e1 = expr DIV e2 = expr { EBinOp (e1, Div, e2, { line = 0; column = 0 }) }
  | e1 = expr FLOORDIV e2 = expr { EBinOp (e1, FloorDiv, e2, { line = 0; column = 0 }) }
  | e1 = expr MOD e2 = expr { EBinOp (e1, Mod, e2, { line = 0; column = 0 }) }
  | e1 = expr PLUS e2 = expr { EBinOp (e1, Add, e2, { line = 0; column = 0 }) }
  | e1 = expr MINUS e2 = expr { EBinOp (e1, Sub, e2, { line = 0; column = 0 }) }
  | e1 = expr SHL e2 = expr { EBinOp (e1, Shl, e2, { line = 0; column = 0 }) }
  | e1 = expr SHR e2 = expr { EBinOp (e1, Shr, e2, { line = 0; column = 0 }) }
  | e1 = expr AMP e2 = expr { EBinOp (e1, BitAnd, e2, { line = 0; column = 0 }) }
  | e1 = expr CARET e2 = expr { EBinOp (e1, BitXor, e2, { line = 0; column = 0 }) }
  | e1 = expr PIPE e2 = expr { EBinOp (e1, BitOr, e2, { line = 0; column = 0 }) }
  | e1 = expr EQ e2 = expr { EBinOp (e1, Eq, e2, { line = 0; column = 0 }) }
  | e1 = expr NEQ e2 = expr { EBinOp (e1, Neq, e2, { line = 0; column = 0 }) }
  | e1 = expr LT e2 = expr { EBinOp (e1, Lt, e2, { line = 0; column = 0 }) }
  | e1 = expr GT e2 = expr { EBinOp (e1, Gt, e2, { line = 0; column = 0 }) }
  | e1 = expr LTE e2 = expr { EBinOp (e1, Lte, e2, { line = 0; column = 0 }) }
  | e1 = expr GTE e2 = expr { EBinOp (e1, Gte, e2, { line = 0; column = 0 }) }
  | e1 = expr IN e2 = expr { EBinOp (e1, In, e2, { line = 0; column = 0 }) }
  | e1 = expr NOT IN e2 = expr %prec IN
      { EUnOp (Not, EBinOp (e1, In, e2, { line = 0; column = 0 }), { line = 0; column = 0 }) }
  | e1 = expr AND e2 = expr { EBinOp (e1, And, e2, { line = 0; column = 0 }) }
  | e1 = expr OR e2 = expr { EBinOp (e1, Or, e2, { line = 0; column = 0 }) }
  | NOT e = expr { EUnOp (Not, e, { line = 0; column = 0 }) }
  | MINUS e = expr %prec UMINUS { EUnOp (Neg, e, { line = 0; column = 0 }) }
  | PLUS e = expr %prec UPLUS { EUnOp (Pos, e, { line = 0; column = 0 }) }
  | TILDE e = expr %prec TILDE { EUnOp (Invert, e, { line = 0; column = 0 }) }
  | func = expr LPAREN args = call_args RPAREN
      { ECall (func, args, get_expr_pos func) }
  | obj = expr DOT attr = IDENT
      { EAttr (obj, attr, get_expr_pos obj) }
  | arr = expr LBRACKET idx = expr RBRACKET
      { EIndex (arr, idx, get_expr_pos arr) }
  | arr = expr LBRACKET start = slice_start COLON end_opt = slice_end RBRACKET
      { ESlice (arr, start, end_opt, get_expr_pos arr) }
  | LBRACKET elems = list_expr RBRACKET
      { EList (elems, { line = 0; column = 0 }) }
  | LBRACE pairs = dict_pair_list RBRACE
      { EDict (pairs, { line = 0; column = 0 }) }
  | LPAREN elems = separated_list(COMMA, expr) RPAREN
      { match elems with
        | [] -> ETuple ([], { line = 0; column = 0 })
        | [e] -> e
        | _ -> ETuple (elems, { line = 0; column = 0 })
      }
  | IF cond = expr COLON then_expr = expr ELSE COLON else_expr = expr
      { EIf (cond, then_expr, Some else_expr, get_expr_pos cond) }
  | LBRACKET elem = expr FOR var = IDENT IN iter = expr RBRACKET
      { EListComp (elem, var, iter, None, { line = 0; column = 0 }) }
  | LBRACKET elem = expr FOR var = IDENT IN iter = expr IF cond = expr RBRACKET
      { EListComp (elem, var, iter, Some cond, { line = 0; column = 0 }) }
  | OPTION DOT SOME LPAREN args = call_args RPAREN
      { EEnumVariant ("Option", "Some", args, { line = 0; column = 0 }) }
  | OPTION DOT NONE
      { EEnumVariant ("Option", "None", [], { line = 0; column = 0 }) }
  | RESULT DOT OK LPAREN args = call_args RPAREN
      { EEnumVariant ("Result", "Ok", args, { line = 0; column = 0 }) }
  | RESULT DOT ERR LPAREN args = call_args RPAREN
      { EEnumVariant ("Result", "Err", args, { line = 0; column = 0 }) }
  | SOME LPAREN args = call_args RPAREN
      { EEnumVariant ("Option", "Some", args, { line = 0; column = 0 }) }
  | NONE
      { EEnumVariant ("Option", "None", [], { line = 0; column = 0 }) }
  | OK LPAREN args = call_args RPAREN
      { EEnumVariant ("Result", "Ok", args, { line = 0; column = 0 }) }
  | ERR LPAREN args = call_args RPAREN
      { EEnumVariant ("Result", "Err", args, { line = 0; column = 0 }) }
  | enum_name = IDENT DOT variant_name = IDENT LPAREN args = call_args RPAREN
      { EEnumVariant (enum_name, variant_name, args, { line = 0; column = 0 }) }
  | enum_name = IDENT DOT variant_name = IDENT
      { EEnumVariant (enum_name, variant_name, [], { line = 0; column = 0 }) }
  | struct_name = IDENT LBRACE fields = struct_field_list RBRACE
      { EStructLiteral (struct_name, fields, { line = 0; column = 0 }) }
  | MATCH e = expr COLON newline_sep INDENT cases = expr_case_list DEDENT
      { EMatch (e, cases, get_expr_pos e) }
  | MATCH TYPE OF e = expr COLON newline_sep INDENT cases = type_case_list DEDENT
      { EMatch (ETypeOf (e, get_expr_pos e), cases, get_expr_pos e) }
  | cond = expr QUESTION true_expr = expr COLON false_expr = expr
      { ETernary (cond, true_expr, false_expr, get_expr_pos cond) }
  | e = expr QUESTION
      { ETry (e, get_expr_pos e) }
  | TYPE OF e = expr
      { ETypeOf (e, make_position $startpos) }

lambda_param:
  | name = IDENT { (name, None) }
  | name = IDENT COLON ty = type_expr { (name, Some ty) }

dict_pair:
  | key = expr COLON value = expr { (key, value) }

list_expr:
  | { [] }
  | first = expr rest = list_expr_rest { first :: rest }

list_expr_rest:
  | { [] }
  | COMMA { [] }
  | COMMA first = expr rest = list_expr_rest { first :: rest }

call_args:
  | { [] }
  | first = expr rest = call_args_rest { first :: rest }

call_args_rest:
  | { [] }
  | COMMA { [] }
  | COMMA first = expr rest = call_args_rest { first :: rest }

dict_pair_list:
  | NEWLINE* { [] }
  | NEWLINE* dict_pair NEWLINE* COMMA NEWLINE* dict_pair_list { $2 :: $6 }
  | NEWLINE* dict_pair NEWLINE* { [$2] }

struct_field_init:
  | name = IDENT COLON value = expr { (name, value) }

struct_field_list:
  | NEWLINE* { [] }
  | NEWLINE* first = struct_field_init rest = struct_field_rest { first :: rest }

struct_field_rest:
  | NEWLINE* { [] }
  | NEWLINE* COMMA fields = struct_field_list { fields }

struct_pattern_field:
  | name = IDENT COLON p = pattern { (name, p) }
  | name = IDENT { (name, PVar name) }  (* 简写形式: {x, y} 等价于 {x: x, y: y} *)

struct_pattern_field_match:
  | name = IDENT COLON p = match_pattern { (name, p) }
  | name = IDENT { (name, PVar name) }  (* 简写形式: {x, y} 等价于 {x: x, y: y} *)

slice_start:
  | { None }
  | e = expr { Some e }

slice_end:
  | { None }
  | e = expr { Some e }
