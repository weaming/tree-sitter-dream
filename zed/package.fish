#!/usr/bin/env fish

set -l extension_dir (realpath (dirname (status filename)))
set -l output_dir "$extension_dir/dist"

if test (count $argv) -gt 0
    set output_dir (realpath -m $argv[1])
end

set -l temporary_root /tmp
if set -q TMPDIR
    set temporary_root $TMPDIR
end

set -l temporary_dir (mktemp -d "$temporary_root/dream-zed-package.XXXXXX")
set -g dream_package_temporary_dir $temporary_dir

function dream_package_cleanup --on-event fish_exit
    if test -n "$dream_package_temporary_dir"; and test -d "$dream_package_temporary_dir"
        rm -rf "$dream_package_temporary_dir"
    end
end

if type -q rustup
    set -l rust_cargo (rustup which cargo)
    set -l rust_toolchain_dir (dirname "$rust_cargo")
    set -gx PATH "$rust_toolchain_dir" $PATH
end

set -l extension_cli
if set -q ZED_EXTENSION_CLI; and test -n "$ZED_EXTENSION_CLI"
    set extension_cli "$ZED_EXTENSION_CLI"
else if not type -q zed-extension
    echo "zed-extension is required to package this extension." >&2
    echo "Install it from the Zed repository's extension_cli crate:" >&2
    echo "cargo install --git https://github.com/zed-industries/zed extension_cli --bin zed-extension" >&2
    exit 1
else
    set extension_cli (type -P zed-extension)
end

set -l source_dir "$temporary_dir/source"
set -l scratch_dir "$temporary_dir/scratch"
mkdir -p "$source_dir" "$output_dir"

if type -q rsync
    rsync -a \
        --exclude target \
        --exclude dist \
        --exclude extension.wasm \
        --exclude grammars \
        "$extension_dir/" "$source_dir/"
else
    cp -R "$extension_dir/." "$source_dir/"
    rm -rf "$source_dir/target" "$source_dir/dist" "$source_dir/extension.wasm" "$source_dir/grammars"
end

set -l manifest_path "$source_dir/extension.toml"
if string match -q '*rev = "HEAD"*' < "$manifest_path"
    set -l repository_root (realpath "$extension_dir/..")
    set -l grammar_revision (git -C "$repository_root" rev-parse --verify origin/main 2>/dev/null)
    if test -z "$grammar_revision"
        set grammar_revision (git -C "$repository_root" rev-parse --verify HEAD 2>/dev/null)
    end
    if test -z "$grammar_revision"
        echo "Could not resolve the Dream grammar HEAD revision." >&2
        exit 1
    end

    set -l temporary_manifest_path "$manifest_path.tmp"
    string replace 'rev = "HEAD"' "rev = \"$grammar_revision\"" \
        < "$manifest_path" > "$temporary_manifest_path"
    mv "$temporary_manifest_path" "$manifest_path"
    echo "Resolved Dream grammar HEAD to $grammar_revision"
end

if not $extension_cli \
    --source-dir "$source_dir" \
    --output-dir "$output_dir" \
    --scratch-dir "$scratch_dir"
    echo "Failed to package the extension." >&2
    exit 1
end

echo "Packaged extension: $output_dir/archive.tar.gz"
echo "Package metadata: $output_dir/manifest.json"
