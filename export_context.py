
"""
Exports project source code and configurations into a single consolidated .txt file
for feeding into an LLM context window. Automatically excludes dependencies, 
build directories, binary assets, and massive lockfiles.
"""

import os
import sys

# Output text file
OUTPUT_FILE = "project_context.txt"

# Exact directories to skip (evaluated against relative paths or directory names)
EXCLUDE_DIRS = {
    "node_modules",
    ".git",
    ".expo",
    ".gradle",
    "build",
    ".idea",
    ".vscode",
    "coverage",
    "dist",
}

# Root-level generated folders to bypass (preserves custom modules/<mod>/android)
EXCLUDE_ROOT_DIRS = {
    "android",
    "ios",
}

# Massive, minified, or binary extensions to skip
EXCLUDE_EXTENSIONS = {
    # Binaries & Archives
    ".apk", ".aab", ".jar", ".aar", ".so", ".dylib", ".zip", ".tar", ".gz", ".7z",
    # Images & Media
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
    ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg",
    # Fonts
    ".ttf", ".otf", ".woff", ".woff2",
    # OS & Tool metadata
    ".ds_store", ".log", ".keystore", ".jks",
}

# Exact filenames to skip (large metadata or lockfiles)
EXCLUDE_FILES = {
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    OUTPUT_FILE,
    os.path.basename(__file__),
}

# Recognized code and configuration extensions to include
INCLUDE_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".json", ".java", ".kt", ".gradle", ".xml",
    ".md", ".txt", ".env", ".example", ".yaml", ".yml",
}


def is_text_file(filepath: str) -> bool:
    """Check whether a file is valid UTF-8 text."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            f.read(2048)
        return True
    except (UnicodeDecodeError, IsADirectoryError, PermissionError):
        return False


def collect_project_files(root_dir: str):
    collected_files = []

    for dirpath, dirnames, filenames in os.walk(root_dir):
        rel_dir = os.path.relpath(dirpath, root_dir)

        # 1. Skip standard excluded directory names
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]

        # 2. Skip root-level prebuilt /android or /ios folders, but keep modules/
        if rel_dir == ".":
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_ROOT_DIRS]

        for filename in sorted(filenames):
            if filename in EXCLUDE_FILES or filename.startswith(".DS_Store"):
                continue

            ext = os.path.splitext(filename)[1].lower()

            if ext in EXCLUDE_EXTENSIONS:
                continue

            file_path = os.path.join(dirpath, filename)
            rel_path = os.path.relpath(file_path, root_dir)

            # Include if extension matches or file is a known root config (e.g. .env, Dockerfile)
            if ext in INCLUDE_EXTENSIONS or filename.startswith(".env") or ext == "":
                if is_text_file(file_path):
                    collected_files.append((rel_path, file_path))

    return collected_files


def main():
    root_dir = os.path.abspath(os.path.dirname(__file__))
    output_path = os.path.join(root_dir, OUTPUT_FILE)

    files = collect_project_files(root_dir)

    print(f"Scanning project root: {root_dir}")
    print(f"Found {len(files)} relevant files to aggregate...")

    with open(output_path, "w", encoding="utf-8") as out:
        out.write("# PROJECT CODEBASE CONTEXT DUMP\n")
        out.write(f"# Total Files: {len(files)}\n\n")

        for rel_path, abs_path in files:
            separator = "=" * 80
            out.write(f"{separator}\n")
            out.write(f"FILE: {rel_path}\n")
            out.write(f"{separator}\n")

            try:
                with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                    out.write(content)
                    if not content.endswith("\n"):
                        out.write("\n")
            except Exception as err:
                out.write(f"[ERROR READING FILE: {err}]\n")

            out.write("\n\n")

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"Context successfully written to: {OUTPUT_FILE} ({size_mb:.2f} MB)")


if __name__ == "__main__":
    main()