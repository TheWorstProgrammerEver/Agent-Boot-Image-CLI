#!/usr/bin/env bash
set -euo pipefail

config_dir="$HOME/.codex"
config_file="$config_dir/config.toml"

mkdir -p "$config_dir"
chmod 0700 "$config_dir"
if [[ -L "$config_file" ]]; then
  printf 'Refusing symbolic link at interactive Codex config destination.\n' >&2
  exit 1
fi
touch "$config_file"

temporary="$(mktemp "$config_dir/.config.toml.XXXXXX")"
cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT

{
  printf '%s\n' 'approval_policy = "never"'
  printf '%s\n' 'sandbox_mode = "danger-full-access"'
  awk '
    function is_escaped(line, position,    backslashes, cursor) {
      for (cursor = position - 1; cursor > 0 && substr(line, cursor, 1) == "\\"; cursor--) {
        backslashes++
      }
      return backslashes % 2
    }

    function quote_run_end(line, position, quote_character,    cursor) {
      for (cursor = position; cursor <= length(line) && substr(line, cursor, 1) == quote_character; cursor++) {
      }
      return cursor - 1
    }

    function hex_value(text,    character, cursor, digit, value) {
      for (cursor = 1; cursor <= length(text); cursor++) {
        character = tolower(substr(text, cursor, 1))
        digit = index("0123456789abcdef", character)
        if (digit == 0) {
          return -1
        }
        value = (value * 16) + digit - 1
      }
      return value
    }

    function decode_basic_quoted_key(line,    character, cursor, decoded,
      digits, escape_character, escape_length, rest, unicode_value) {
      sub(/^[[:space:]]*/, "", line)
      if (substr(line, 1, 1) != "\"") {
        return invalid_key
      }

      for (cursor = 2; cursor <= length(line); cursor++) {
        character = substr(line, cursor, 1)
        if (character == "\"") {
          rest = substr(line, cursor + 1)
          return rest ~ /^[[:space:]]*=/ ? decoded : invalid_key
        }
        if (character != "\\") {
          decoded = decoded character
          continue
        }

        cursor++
        escape_character = substr(line, cursor, 1)
        if (escape_character == "u" || escape_character == "U") {
          escape_length = escape_character == "u" ? 4 : 8
          digits = substr(line, cursor + 1, escape_length)
          unicode_value = length(digits) == escape_length ? hex_value(digits) : -1
          if (unicode_value < 0 || unicode_value > 127) {
            return invalid_key
          }
          decoded = decoded sprintf("%c", unicode_value)
          cursor += escape_length
        } else if (escape_character == "\"" || escape_character == "\\") {
          decoded = decoded escape_character
        } else {
          return invalid_key
        }
      }
      return invalid_key
    }

    function is_owned_key_assignment(line,    decoded_key) {
      decoded_key = decode_basic_quoted_key(line)
      return line ~ /^[[:space:]]*(approval_policy|sandbox_mode)[[:space:]]*=/ ||
        decoded_key == "approval_policy" || decoded_key == "sandbox_mode" ||
        line ~ ("^[[:space:]]*" quote "(approval_policy|sandbox_mode)" quote "[[:space:]]*=")
    }

    function scan_value(line,    character, cursor, in_basic, in_literal, next_three) {
      for (cursor = 1; cursor <= length(line); cursor++) {
        character = substr(line, cursor, 1)
        next_three = substr(line, cursor, 3)

        if (in_multiline_basic) {
          if (next_three == "\"\"\"" && !is_escaped(line, cursor)) {
            in_multiline_basic = 0
            cursor = quote_run_end(line, cursor, "\"")
          }
          continue
        }
        if (in_multiline_literal) {
          if (next_three == quote quote quote) {
            in_multiline_literal = 0
            cursor = quote_run_end(line, cursor, quote)
          }
          continue
        }
        if (in_basic) {
          if (character == "\\") {
            cursor++
          } else if (character == "\"") {
            in_basic = 0
          }
          continue
        }
        if (in_literal) {
          if (character == quote) {
            in_literal = 0
          }
          continue
        }

        if (next_three == "\"\"\"") {
          in_multiline_basic = 1
          cursor += 2
        } else if (next_three == quote quote quote) {
          in_multiline_literal = 1
          cursor += 2
        } else if (character == "\"") {
          in_basic = 1
        } else if (character == quote) {
          in_literal = 1
        } else if (character == "#") {
          break
        } else if (character == "[" || character == "{") {
          value_depth++
        } else if ((character == "]" || character == "}") && value_depth > 0) {
          value_depth--
        }
      }
    }

    BEGIN {
      invalid_key = "<not-a-basic-key-assignment>"
      quote = sprintf("%c", 39)
    }
    !in_table && value_depth == 0 && !in_multiline_basic &&
      !in_multiline_literal && /^[[:space:]]*\[/ { in_table = 1 }
    !in_table && value_depth == 0 && !in_multiline_basic &&
      !in_multiline_literal &&
      is_owned_key_assignment($0) { next }
    {
      print
      if (!in_table) {
        scan_value($0)
      }
    }
  ' "$config_file"
} >"$temporary"

chmod 0600 "$temporary"
mv "$temporary" "$config_file"
trap - EXIT
