#!/usr/bin/env fish

set -l script_dir (dirname (status filename))
set -l repo_root (realpath "$script_dir/..")
set -l dream_root $argv[1]

if test -z "$dream_root"
    set dream_root "$repo_root/../dream"
end

if not type -q tree-sitter
    echo "tree-sitter CLI not found" >&2
    exit 1
end

for source_dir in "$dream_root/bootstrap" "$dream_root/runtime/stdlib"
    if not test -d "$source_dir"
        echo "Dream source directory not found: $source_dir" >&2
        exit 1
    end
end

for reference_file in parser.mly lexer.mll
    set -l dream_file "$dream_root/ocaml/lib/$reference_file"
    set -l local_file "$repo_root/ref/$reference_file"

    if not test -f "$dream_file"
        echo "Dream reference file not found: $dream_file" >&2
        exit 1
    end

    if not cmp -s "$local_file" "$dream_file"
        echo "$local_file is out of sync with $dream_file" >&2
        exit 1
    end
end

set -l source_files (rg --files "$dream_root/bootstrap" "$dream_root/runtime/stdlib" | rg '\.dm$')
set -l source_count (count $source_files)

if test $source_count -eq 0
    echo "No Dream source files found" >&2
    exit 1
end

set -l failed_count 0
for source_file in $source_files
    set -l output (tree-sitter parse -p "$repo_root" "$source_file" 2>&1)
    if string match -q -r 'ERROR|MISSING' -- $output
        set failed_count (math $failed_count + 1)
        echo "FAILED: $source_file"
        printf '%s\n' $output | string match -r -C 2 'ERROR|MISSING'
    end
end

set -l passed_count (math $source_count - $failed_count)
echo "Dream parser: $passed_count/$source_count files passed"
test $failed_count -eq 0
