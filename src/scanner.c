#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum TokenType {
  INDENT,
  DEDENT,
  NEWLINE,
};

#define MAX_INDENT_DEPTH 128

typedef struct {
  uint16_t levels[MAX_INDENT_DEPTH];
  uint8_t depth;
  bool at_line_start;
  uint8_t pending_dedents;
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
  return size;
}

void tree_sitter_dream_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *scanner = payload;
  scanner->depth = 1;
  scanner->levels[0] = 0;
  scanner->at_line_start = true;
  scanner->pending_dedents = 0;
  if (length == 0) return;

  unsigned offset = 0;
  uint8_t depth = (uint8_t)buffer[offset++];
  if (depth == 0 || depth > MAX_INDENT_DEPTH) return;
  if (offset + depth * sizeof(uint16_t) + 2 > length) return;
  scanner->depth = depth;
  memcpy(scanner->levels, buffer + offset, depth * sizeof(uint16_t));
  offset += depth * sizeof(uint16_t);
  scanner->at_line_start = buffer[offset++] != 0;
  scanner->pending_dedents = (uint8_t)buffer[offset];
}

static void skip_horizontal_space(TSLexer *lexer, uint16_t *indent) {
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    *indent += lexer->lookahead == '\t' ? 8 : 1;
    lexer->advance(lexer, true);
  }
}

bool tree_sitter_dream_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *scanner = payload;

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

    uint16_t indent = 0;
    skip_horizontal_space(lexer, &indent);

    if (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
      scanner->at_line_start = true;
      if (!valid_symbols[NEWLINE]) return false;

      if (lexer->lookahead == '\r') lexer->advance(lexer, false);
      if (lexer->lookahead == '\n') lexer->advance(lexer, false);
      lexer->result_symbol = NEWLINE;
      lexer->mark_end(lexer);
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
        lexer->result_symbol = DEDENT;
        lexer->mark_end(lexer);
        return true;
      }
    }

    scanner->at_line_start = false;
    return false;
  }

  if (valid_symbols[NEWLINE] && (lexer->lookahead == '\n' || lexer->lookahead == '\r')) {
    if (lexer->lookahead == '\r') lexer->advance(lexer, false);
    if (lexer->lookahead == '\n') lexer->advance(lexer, false);
    lexer->result_symbol = NEWLINE;
    lexer->mark_end(lexer);
    scanner->at_line_start = true;
    return true;
  }

  return false;
}
