#!/usr/bin/env python3
import argparse
import ast
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from textwrap import indent
from typing import Dict, List, Optional, Tuple, Set

# ----------------- basic utils & regex ----------------- #
PY_FUNC_DEF = re.compile(r"^\s*def\s+([A-Za-z_]\w*)\s*\(")
CALL_RE = re.compile(r"[A-Za-z_]\w*\s*\(")
CALL_RE_WITH_PATH = re.compile(r"(?:/\S+::)?([A-Za-z_]\w*)\s*\(")

DEF_LINE_RE = re.compile(r"^\s*def\s+[A-Za-z_]\w*\s*\((.*)\)\s*(?:->\s*(.*))?:\s*$")


def run_git_diff(repo: str, cached: bool = False) -> Tuple[int, str, str]:
    cmd = [
        "git",
        "-C",
        repo,
        "diff",
    ]
    if cached:
        cmd.append("--cached")
    cmd.extend(
        [
            "--relative",
            "--ignore-space-at-eol",
            "-b",
            "-w",
            "--ignore-blank-lines",
        ],
    )
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return proc.returncode, proc.stdout, proc.stderr


def run_git_status(repo: str) -> Tuple[int, str, str]:
    cmd = ["git", "-C", repo, "status", "--porcelain"]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return proc.returncode, proc.stdout, proc.stderr


# ----------------- diff parsing & hunk heuristics ----------------- #
import difflib


def _strip_type_annotations_from_params(params_text: str) -> str:
    res = re.sub(r"\s*:\s*[^,=\)\]]+", "", params_text)
    res = re.sub(r"\s+", " ", res).strip()
    return res


def _normalize_def_line(line: str) -> Optional[str]:
    m = DEF_LINE_RE.match(line)
    if not m:
        return None
    params_text = m.group(1) or ""
    params_no_ann = _strip_type_annotations_from_params(params_text)
    name_m = re.match(r"^\s*def\s+([A-Za-z_]\w*)\s*\(", line)
    name = name_m.group(1) if name_m else ""
    return f"def {name}({params_no_ann})"


def _def_line_change_is_trivial(removed: str, added: str) -> bool:
    norm_removed = _normalize_def_line(removed)
    norm_added = _normalize_def_line(added)
    if norm_removed is None or norm_added is None:
        return False
    if norm_removed == norm_added:
        return True
    ratio = difflib.SequenceMatcher(None, norm_removed, norm_added).ratio()
    return ratio >= 0.85


def is_important_hunk(hunk_lines: List[str]) -> bool:
    added = [l for l in hunk_lines if l.startswith("+") and not l.startswith("+++")]
    removed = [l for l in hunk_lines if l.startswith("-") and not l.startswith("---")]
    if not added and not removed:
        return False
    total_changed_count = len(added) + len(removed)
    if total_changed_count == 1:
        line = (added[0] if added else removed[0])[1:]
        if PY_FUNC_DEF.match(line):
            return False
        if CALL_RE.search(line):
            return True
        return False

    trivial_pairs = 0
    def_pairs_checked = 0
    for r in removed:
        r_line = r[1:]
        if not PY_FUNC_DEF.match(r_line):
            continue
        r_name = PY_FUNC_DEF.match(r_line).group(1)
        for a in added:
            a_line = a[1:]
            if not PY_FUNC_DEF.match(a_line):
                continue
            a_name = PY_FUNC_DEF.match(a_line).group(1)
            if a_name == r_name:
                def_pairs_checked += 1
                if _def_line_change_is_trivial(r_line, a_line):
                    trivial_pairs += 1

    non_def_added = []
    for a in added:
        a_line = a[1:].strip()
        if not a_line:
            continue
        if PY_FUNC_DEF.match(a_line):
            continue
        if a_line.startswith("from ") or a_line.startswith("import "):
            continue
        if a_line.startswith("#"):
            continue
        non_def_added.append(a_line)

    if def_pairs_checked > 0 and def_pairs_checked == trivial_pairs and len(non_def_added) == 0:
        return False

    for a in added:
        if CALL_RE.search(a[1:]):
            return True

    return True


def parse_diff(diff_text: str):
    files = []
    current = None
    for line in diff_text.splitlines():
        if line.startswith("diff --git"):
            if current:
                files.append(current)
            current = {"file": None, "hunks": []}
        elif line.startswith("+++ b/"):
            if current:
                current["file"] = line.replace("+++ b/", "").strip()
        elif line.startswith("@@"):
            if current is None:
                continue
            current["hunks"].append({"header": line, "lines": []})
        elif current and current["hunks"]:
            current["hunks"][-1]["lines"].append(line)
    if current:
        files.append(current)

    filtered_files = []
    for f in files:
        important_hunks = [h for h in f["hunks"] if is_important_hunk(h["lines"])]
        if important_hunks:
            f["hunks"] = important_hunks
            filtered_files.append(f)

    return filtered_files


def extract_new_python_files(repo_root: str) -> Set[str]:
    code, stdout, _ = run_git_status(repo_root)
    if code != 0 or not stdout:
        return set()

    new_files: Set[str] = set()

    def collect_python_paths(rel_path: str):
        abs_path = os.path.join(repo_root, rel_path)
        if os.path.isdir(abs_path):
            for root, _, files in os.walk(abs_path):
                for fname in files:
                    if not fname.endswith(".py"):
                        continue
                    rel_child = os.path.relpath(os.path.join(root, fname), repo_root).replace("\\", "/")
                    new_files.add(rel_child)
        else:
            if rel_path.endswith(".py") and os.path.isfile(abs_path):
                new_files.add(rel_path)

    for line in stdout.splitlines():
        if not line:
            continue
        status = line[:2]
        path = line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        normalized = path.replace("\\", "/")
        if status == "??" or "A" in status:
            collect_python_paths(normalized)
    return new_files


def find_changed_functions(parsed_files):
    changed: Dict[str, Set[str]] = {}
    for f in parsed_files:
        file_path = f["file"]
        funcs: Set[str] = set()
        for h in f["hunks"]:
            for line in h["lines"]:
                if line.startswith(("+", " ")):
                    stripped = line[1:]
                    m = PY_FUNC_DEF.match(stripped)
                    if m:
                        funcs.add(m.group(1))
        if funcs:
            changed.setdefault(file_path, set()).update(funcs)
    return changed


# ----------------- utilities for canonical ids ----------------- #
def rel_path(repo_root: str, abs_path: str) -> str:
    try:
        return os.path.relpath(abs_path, repo_root).replace("\\", "/")
    except Exception:
        return abs_path.replace("\\", "/")


def make_full_id(rel_file: str, fn_name: str) -> str:
    rel_file = rel_file.lstrip("/")  # remove accidental leading /
    return f"/{rel_file}::{fn_name}"  # always add leading /


# ----------------- function extraction & saving ----------------- #
def save_function(path: str, name: str, body: str, start_line: int, repo_root: Optional[str] = None):
    file_path: str = "functions.json"
    json_path = Path(file_path)
    if json_path.exists():
        try:
            with json_path.open("r") as f:
                data = json.load(f)
        except json.JSONDecodeError:
            data = {}
    else:
        data = {}

    rel = path
    if repo_root:
        try:
            rel = os.path.relpath(path, repo_root)
        except Exception:
            rel = path
    rel = rel.replace("\\", "/")

    key = make_full_id(rel, name)
    data[key] = {
        "body": body,
        "start_line": start_line,
        "file_path": path  # Also save absolute path for easier matching
    }

    with json_path.open("w") as f:
        json.dump(data, f, indent=2)


def parse_imports(path: str) -> Dict[str, str]:
    import_map = {}
    text = Path(path).read_text().splitlines()
    for line in text:
        line = line.strip()
        if line.startswith("import "):
            parts = line.replace("import ", "").split(" as ")
            module = parts[0].strip()
            alias = parts[1].strip() if len(parts) > 1 else module.split(".")[-1]
            import_map[alias] = module
        elif line.startswith("from "):
            m = re.match(r"from\s+([\w\.]+)\s+import\s+([\w\,\s]+)", line)
            if m:
                mod = m.group(1)
                names = m.group(2).split(",")
                for n in names:
                    n = n.strip()
                    if " as " in n:
                        real, alias = n.split(" as ")
                        import_map[alias.strip()] = f"{mod}.{real.strip()}"
                    else:
                        import_map[n] = f"{mod}.{n}"
    return import_map


def qualify_calls_in_line(
    line: str,
    imports_map: Dict[str, str],
    local_funcs: set,
    current_file: str,
    repo_root: str
) -> str:
    def replacer(match):
        fn = match.group(0).rstrip("(").strip()
        if fn in local_funcs:
            rel_path_str = "/" + os.path.relpath(current_file, repo_root).replace("\\", "/")
            return f"{rel_path_str}::{fn}("
        elif fn in imports_map:
            module_str = imports_map[fn]
            current_file_pkg = Path(current_file).parent.relative_to(repo_root).as_posix()
            if module_str.startswith("."):
                rel_module_path = module_str.lstrip(".")
                parts = rel_module_path.split(".")
                file_name = parts[0]
                rel_module_path = file_name+".py"
                full_module_path = Path(current_file_pkg) / rel_module_path
            else:
                parts = module_str.split(".")
                func_name = parts[-1]
                module_path = "/".join(parts[:-1])
                full_module_path = Path(f"{module_path}.py")
            rel_path_str = "/" + full_module_path.as_posix()
            return f"{rel_path_str}::{fn}("
        else:
            return fn + "("
    return re.sub(r"\b[A-Za-z_]\w*\s*\(", replacer, line)


def extract_functions_from_file(path: str, function_names: Optional[Set[str]], repo_root: Optional[str] = None):
    text = Path(path).read_text().splitlines()
    results = {}
    current_name = None
    current_body = []
    current_start_line = 0
    imports_map = parse_imports(path)
    local_funcs = set()
    target_all = not function_names
    for i, line in enumerate(text):
        lineno = i + 1
        m = PY_FUNC_DEF.match(line)
        if m:
            name = m.group(1)
            if current_name and current_body:
                full_body = "\n".join([qualify_calls_in_line(l, imports_map, local_funcs, path, repo_root) for l in current_body])
                key = make_full_id(path, current_name)
                results[key] = full_body
                save_function(path, current_name, full_body, current_start_line, repo_root)
            current_name = name if (target_all or (function_names and name in function_names)) else None
            if current_name:
                local_funcs.add(current_name)
                current_start_line = lineno
            current_body = [line] if current_name else []
        elif current_name:
            current_body.append(line)
    if current_name and current_body:
        full_body = "\n".join([qualify_calls_in_line(l, imports_map, local_funcs, path, repo_root) for l in current_body])
        key = make_full_id(path, current_name)
        results[key] = full_body
        save_function(path, current_name, full_body, current_start_line, repo_root)
    return results


# ----------------- AST helpers to find calls ----------------- #
def find_calls_ast(body: str) -> List[str]:
    found = set()
    try:
        node = ast.parse(body)
    except SyntaxError:
        return list(found)
    for n in ast.walk(node):
        if isinstance(n, ast.Call):
            if isinstance(n.func, ast.Name):
                found.add(n.func.id)
            elif isinstance(n.func, ast.Attribute):
                found.add(n.func.attr)
    return list(found)


# ----------------- Repo index ----------------- #
def build_repo_index(repo_root: str) -> Dict[str, List[str]]:
    index: Dict[str, List[str]] = {}
    for root, dirs, files in os.walk(repo_root):
        if ".git" in dirs:
            dirs.remove(".git")
        for fname in files:
            if not fname.endswith(".py"):
                continue
            fpath = os.path.join(root, fname)
            if "/.venv/" in fpath or "/venv/" in fpath or "\\.venv\\" in fpath or "\\venv\\" in fpath:
                continue
            rel = os.path.relpath(fpath, repo_root).replace("\\", "/")
            try:
                src = Path(fpath).read_text()
                tree = ast.parse(src)
            except Exception:
                continue
            for node in tree.body:
                if isinstance(node, ast.FunctionDef):
                    index.setdefault(node.name, []).append(rel)
    return index


# ----------------- Resolution ----------------- #
def resolve_call(
    fn_name: str,
    bindings: Dict[str, str],
    current_file_abs: str,
    repo_root: str,
    repo_index: Dict[str, List[str]],
) -> str:
    if fn_name in bindings:
        mod = bindings[fn_name]
        mod_path = mod.replace(".", "/") + ".py"
        abs_mod_path = os.path.join(repo_root, mod_path)
        if os.path.isfile(abs_mod_path):
            rel = "/" + os.path.relpath(abs_mod_path, repo_root).replace("\\", "/")
            return f"{rel}::{fn_name}"
        return fn_name
    try:
        src = Path(current_file_abs).read_text()
        tree = ast.parse(src)
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name == fn_name:
                rel = "/" + os.path.relpath(current_file_abs, repo_root).replace("\\", "/")
                return f"{rel}::{fn_name}"
    except Exception:
        pass
    candidates = repo_index.get(fn_name, [])
    if len(candidates) == 1:
        return make_full_id(candidates[0], fn_name)
    return fn_name


# ----------------- Graph builders ----------------- #
def find_calls_in_qualified_body(body: str) -> List[str]:
    return [m.group(1) for m in CALL_RE_WITH_PATH.finditer(body)]


def normalize_path(path: str, repo_root: str) -> str:
    """Convert absolute file path to repo-relative path with leading /."""
    rel_path = os.path.relpath(path, repo_root)
    return "/" + rel_path.replace("\\", "/")  # Ensure Unix-style separators


def extract_calls_from_body(body: str, current_fn: str) -> List[str]:
    """
    Extract all function calls in the form /path/to/file.py::function_name(...)
    but ignore the function's own def line.
    """
    pattern = r"(/[^:]+\.py::[a-zA-Z0-9_]+)\("
    calls = re.findall(pattern, body)
    # Remove self-call from def line
    return [c for c in calls if c != current_fn]

def build_call_graph(functions: Dict[str, str]) -> Dict[str, List[str]]:
    """Build call graph from function bodies"""
    graph = {}
    all_funcs = set(functions.keys())
    for fn, body in functions.items():
        calls = extract_calls_from_body(body, fn)
        # Only keep calls to functions that exist in our set
        calls = [c for c in calls if c in all_funcs]
        graph[fn] = calls
    return graph

def find_parents(graph: Dict[str, List[str]]) -> List[str]:
    """Return functions not called by any other function"""
    all_funcs = set(graph.keys())
    called_funcs: Set[str] = set()
    for calls in graph.values():
        called_funcs.update(calls)
    return list(all_funcs - called_funcs)

def save_graph(graph: Dict[str, List[str]]):
    file_path = "call_graph.json"
    path = Path(file_path)
    with path.open("w") as f:
        json.dump(graph, f, indent=2)


def save_parent_functions(parents: List[str]):
    file_path = "parent_functions.json"
    path = Path(file_path)
    with path.open("w") as f:
        json.dump(parents, f, indent=2)


# ----------------- main ----------------- #
def main(argv: Optional[List[str]] = None):
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=False, default="/home/bimal/Documents/ucsd/research/code/trap", help="path to the git repo to analyze")
    args = p.parse_args(argv)
    repo_root = os.path.abspath(args.repo)
    try:
        parsed_diffs = []
        for cached in (False, True):
            diff_code, diff_stdout, _ = run_git_diff(repo_root, cached=cached)
            if diff_code == 0 and diff_stdout:
                parsed_diffs.extend(parse_diff(diff_stdout))

        changed_funcs_raw = find_changed_functions(parsed_diffs)
        changed_funcs: Dict[str, Optional[Set[str]]] = {k: v for k, v in changed_funcs_raw.items()}

        for new_file in extract_new_python_files(repo_root):
            changed_funcs.setdefault(new_file, None)

        if not changed_funcs:
            print(json.dumps({"parents": []}, indent=2))
            return
        repo_index = build_repo_index(repo_root)
        all_func_bodies: Dict[str, str] = {}
        for rel_file, funcs in changed_funcs.items():
            abs_file = os.path.join(repo_root, rel_file)
            extracted = extract_functions_from_file(abs_file, funcs, repo_root=repo_root)
            for full_id, body in extracted.items():
                key = "/"+ rel_path(repo_root, full_id)
                all_func_bodies[key] = body
        call_graph = build_call_graph(all_func_bodies)
        save_graph(call_graph)
        parents = find_parents(call_graph)
        save_parent_functions(parents)
        print(json.dumps({"parents": parents}, indent=2), file=sys.stdout)
    except Exception as e:
        raise e


if __name__ == "__main__":
    main()
