#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum TokenType {
  INDENT,
  DEDENT,
  NEWLINE,
  LBRACE,
  RBRACE,
  LBRACKET,
  RBRACKET,
  LPAREN,
  RPAREN,
};

#define MAX_INDENT_DEPTH 128

typedef struct {
  uint16_t levels[MAX_INDENT_DEPTH];
  uint8_t depth;
  bool at_line_start;
  uint8_t pending_dedents;
  int16_t bracket_depth;
  bool last_was_newline;
} Scanner;

void *tree_sitter_dream_external_scanner_create(void) {
  Scanner *scanner = calloc(1, sizeof(Scanner));
  scanner->levels[0] = 0;
  scanner->depth = 1;
  scanner->at_line_start = true;
  return scanner;
}

void tree_sitter_dream_external_scanner_destroy(void *payload) {
  free(payload);
}

unsigned tree_sitter_dream_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *scanner = payload;
  unsigned size = 0;
  buffer[size++] = scanner->depth;
  memcpy(buffer + size, scanner->levels, scanner->depth * sizeof(uint16_t));
  size += scanner->depth * sizeof(uint16_t);
  buffer[size++] = scanner->at_line_start ? 1 : 0;
  buffer[size++] = scanner->pending_dedents;
  buffer[size++] = (uint8_t)scanner->bracket_depth;
  buffer[size++] = (uint8_t)(scanner->bracket_depth >> 8);
  buffer[size++] = scanner->last_was_newline ? 1 : 0;
  return size;
}

void tree_sitter_dream_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *scanner = payload;
  scanner->depth = 1;
  scanner->levels[0] = 0;
  scanner->at_line_start = true;
  scanner->pending_dedents = 0;
  scanner->bracket_depth = 0;
  scanner->last_was_newline = false;
  if (length == 0) return;

  unsigned offset = 0;
  uint8_t depth = (uint8_t)buffer[offset++];
  if (depth == 0 || depth > MAX_INDENT_DEPTH) return;
  if (offset + depth * sizeof(uint16_t) + 5 > length) return;
  scanner->depth = depth;
  memcpy(scanner->levels, buffer + offset, depth * sizeof(uint16_t));
  offset += depth * sizeof(uint16_t);
  scanner->at_line_start = buffer[offset++] != 0;
  scanner->pending_dedents = (uint8_t)buffer[offset++];
  scanner->bracket_depth = (int16_t)((uint8_t)buffer[offset] | ((uint8_t)buffer[offset + 1] << 8));
  scanner->last_was_newline = buffer[offset + 2] != 0;
}

// 识别括号 token 并维护括号深度;识别成功返回 true
static bool match_bracket(TSLexer *lexer, Scanner *scanner, const bool *valid_symbols) {
  enum TokenType token = 0;
  switch (lexer->lookahead) {
    case '{': token = LBRACE; break;
    case '}': token = RBRACE; break;
    case '[': token = LBRACKET; break;
    case ']': token = RBRACKET; break;
    case '(': token = LPAREN; break;
    case ')': token = RPAREN; break;
    default: return false;
  }

  if (!valid_symbols[token]) {
    return false;
  }

  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  if (token == LBRACE || token == LBRACKET || token == LPAREN) {
    scanner->bracket_depth++;
  } else if (scanner->bracket_depth > 0) {
    scanner->bracket_depth--;
  }
  scanner->at_line_start = false;
  scanner->last_was_newline = false;
  lexer->result_symbol = token;
  return true;
}

bool tree_sitter_dream_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *scanner = payload;

  // 跳过前导空格(记录缩进数),识别括号 token(维护括号深度)
  // 识别失败时返回 false 会重置位置,不影响后续缩进计算
  bool skipped_space = false;
  uint16_t skipped_indent = 0;
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    skipped_indent += lexer->lookahead == '\t' ? 8 : 1;
    lexer->advance(lexer, true);
    skipped_space = true;
  }

  if (match_bracket(lexer, scanner, valid_symbols)) {
    return true;
  }

  // 括号内:跳过换行与缩进后继续识别括号
  if (scanner->bracket_depth > 0) {
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t'
           || lexer->lookahead == '\n' || lexer->lookahead == '\r') {
      lexer->advance(lexer, true);
    }
    if (match_bracket(lexer, scanner, valid_symbols)) {
      return true;
    }
    return false;
  }

  // 非行首且未识别到括号:重置位置,由缩进/换行逻辑重新处理
  if (skipped_space && !scanner->at_line_start) {
    return false;
  }

  if (scanner->pending_dedents > 0 && valid_symbols[DEDENT]) {
    scanner->pending_dedents--;
    lexer->result_symbol = DEDENT;
    lexer->mark_end(lexer);
    return true;
  }

  if (scanner->at_line_start) {
    if (lexer->eof(lexer) && valid_symbols[DEDENT] && scanner->depth > 1) {
      scanner->depth--;
      lexer->result_symbol = DEDENT;
      lexer->mark_end(lexer);
      return true;
    }

    uint16_t indent = skipped_indent;

    if (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
      scanner->at_line_start = true;
      if (!valid_symbols[NEWLINE]) return false;

      if (lexer->lookahead == '\r') lexer->advance(lexer, false);
      if (lexer->lookahead == '\n') lexer->advance(lexer, false);
      lexer->result_symbol = NEWLINE;
      lexer->mark_end(lexer);
      scanner->last_was_newline = true;
      return true;
    }

    if (lexer->eof(lexer)) {
      scanner->at_line_start = false;
      return false;
    }

    uint16_t current = scanner->levels[scanner->depth - 1];
    if (indent > current && valid_symbols[INDENT] && scanner->depth < MAX_INDENT_DEPTH) {
      scanner->levels[scanner->depth++] = indent;
      scanner->at_line_start = false;
      scanner->last_was_newline = false;
      lexer->result_symbol = INDENT;
      lexer->mark_end(lexer);
      return true;
    }

    if (indent < current && valid_symbols[DEDENT]) {
      while (scanner->depth > 1 && indent < scanner->levels[scanner->depth - 1]) {
        scanner->depth--;
        scanner->pending_dedents++;
      }

      if (scanner->pending_dedents > 0) {
        scanner->pending_dedents--;
        scanner->at_line_start = false;
        scanner->last_was_newline = false;
        lexer->result_symbol = DEDENT;
        lexer->mark_end(lexer);
        return true;
      }
    }

    scanner->at_line_start = false;
    scanner->last_was_newline = false;
    return false;
  }

  if (valid_symbols[NEWLINE] && (lexer->lookahead == '\n' || lexer->lookahead == '\r')) {
    if (lexer->lookahead == '\r') lexer->advance(lexer, false);
    if (lexer->lookahead == '\n') lexer->advance(lexer, false);
    lexer->result_symbol = NEWLINE;
    lexer->mark_end(lexer);
    scanner->at_line_start = true;
    scanner->last_was_newline = true;
    return true;
  }

  return false;
}
