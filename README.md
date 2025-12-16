# Linearizer

Linearizer surfaces the Python functions you have touched in your current Git diff, linearises their surrounding call graph with a Python helper process, and makes it easy to inspect and navigate the results inside VS Code.

## Features

- 🔍 **Show changed Python functions** – Runs `git diff` against `HEAD` (including staged and unstaged edits) via a Python helper and lists every affected function.
- 🧭 **Linearised call flows** – Builds a static call graph across the repository and emits a depth-first execution ordering for each changed entry-point so you can reason about value flow.
- �️ **Webview dashboard** – Renders changed functions, warnings, and Python-produced call flows in a dedicated editor panel so you can stay in the main canvas.
- 🚀 **Quick navigation** – Presents a quick pick so you can jump directly to any changed function definition with a single selection.

## Requirements

- Git must be available on your `PATH`.
- Python 3.8+ must be available (the extension auto-detects `python3`/`python`, or set `linearizer.pythonPath`).
- Run the command from a workspace that lives inside a Git repository.
- Only Python files (`*.py`) are analysed today.

## Usage

1. Open a Python repository in VS Code.
2. Make (or stage) some changes.
3. Run **Linearizer: Show Changed Python Functions** from the Command Palette.
4. The extension spawns the bundled `python/linearizer.py` helper to analyse the repo.
5. Review the interactive dashboard that opens in the main editor area; the webview lists changed functions, warnings, and linearised call flows while the quick pick still lets you jump straight to definitions.

> Tip: Newly created Python files count as fully changed – every defined function appears in the results.

## Known limitations

- Pure deletions (functions removed without any remaining lines) are not yet reported.
- Static analysis cannot resolve every dynamic Python call; unmatched calls are still listed as raw IDs in the flow sequence.
- Parsing relies on standard `def`/`class` indentation; highly unconventional formatting may be skipped.
- Non-Python files are ignored.

## Development

- `npm install` – install dependencies.
- `npm run compile` – build the extension.
- `npm run watch` – rebuild on file changes.
- `npm test` – run the VS Code extension tests.

PRs and suggestions are welcome!
