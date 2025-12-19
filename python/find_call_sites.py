#!/usr/bin/env python3
"""
Script to find all call sites for a given function in a repository.
Takes a function ID (e.g., "backend/services/analytics.py::get_metric_period_analytics")
and returns all locations where that function is called.
"""
import argparse
import ast
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple


def find_function_calls_in_file(file_path: str, target_function_name: str, repo_root: str) -> List[Dict[str, any]]:
    """
    Find all calls to target_function_name in a given file.
    Returns a list of call sites with file, line, column, and call context.
    """
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            source_code = f.read()
        
        tree = ast.parse(source_code, filename=file_path)
        call_sites = []
        
        class CallSiteVisitor(ast.NodeVisitor):
            def __init__(self):
                self.current_function = None
                self.function_stack = []
            
            def visit_FunctionDef(self, node):
                self.function_stack.append(self.current_function)
                self.current_function = node.name
                self.generic_visit(node)
                self.current_function = self.function_stack.pop()
            
            def visit_AsyncFunctionDef(self, node):
                self.function_stack.append(self.current_function)
                self.current_function = node.name
                self.generic_visit(node)
                self.current_function = self.function_stack.pop()
            
            def visit_Call(self, node):
                # Check if this is a call to our target function
                func_name = None
                
                if isinstance(node.func, ast.Name):
                    # Direct call: function_name()
                    func_name = node.func.id
                elif isinstance(node.func, ast.Attribute):
                    # Method call: obj.method_name()
                    func_name = node.func.attr
                
                if func_name == target_function_name:
                    # Get the line number (1-indexed)
                    lineno = node.lineno
                    col_offset = node.col_offset
                    
                    # Get surrounding context (a few lines before and after)
                    lines = source_code.split('\n')
                    start_line = max(0, lineno - 2)
                    end_line = min(len(lines), lineno + 2)
                    context_lines = lines[start_line:end_line]
                    
                    # Get the actual call line
                    call_line = lines[lineno - 1] if lineno <= len(lines) else ""
                    
                    # Get the calling function name (from our stack)
                    calling_function = self.current_function
                    
                    rel_path = os.path.relpath(file_path, repo_root).replace('\\', '/')
                    full_id = f"/{rel_path}::{calling_function}" if calling_function else None
                    
                    call_sites.append({
                        "file": rel_path,
                        "line": lineno,
                        "column": col_offset,
                        "call_line": call_line.strip(),
                        "context": context_lines,
                        "calling_function": calling_function,
                        "calling_function_id": full_id
                    })
                
                self.generic_visit(node)
        
        visitor = CallSiteVisitor()
        visitor.visit(tree)
        
        return call_sites
    
    except SyntaxError as e:
        # File has syntax errors, skip it
        return []
    except Exception as e:
        # Error reading or parsing file
        return []


def find_call_sites(repo_root: str, target_function_id: str) -> List[Dict[str, any]]:
    """
    Find all call sites for a function identified by target_function_id.
    target_function_id format: "backend/services/analytics.py::get_metric_period_analytics"
    """
    if "::" not in target_function_id:
        return []
    
    # Parse the function ID
    path_part, func_name = target_function_id.split("::", 1)
    
    # Remove leading slash if present
    if path_part.startswith("/"):
        path_part = path_part[1:]
    
    # Construct absolute path to the function's file (for reference, not searching)
    target_file = os.path.join(repo_root, path_part)
    target_file_abs = os.path.abspath(target_file)
    
    if not os.path.isfile(target_file_abs):
        return []
    
    all_call_sites = []
    
    # Walk through all Python files in the repo
    for root, dirs, files in os.walk(repo_root):
        # Skip common directories that shouldn't be searched
        dirs[:] = [d for d in dirs if d not in {'.git', '__pycache__', '.venv', 'venv', 'env', 'node_modules'}]
        
        for file in files:
            if not file.endswith('.py'):
                continue
            
            file_path = os.path.join(root, file)
            call_sites = find_function_calls_in_file(file_path, func_name, repo_root)
            all_call_sites.extend(call_sites)
    
    return all_call_sites


def main():
    parser = argparse.ArgumentParser(description="Find all call sites for a function")
    parser.add_argument("--repo", required=True, help="Path to the git repository root")
    parser.add_argument("--function-id", required=True, help="Function ID in format path/to/file.py::function_name")
    
    args = parser.parse_args()
    repo_root = os.path.abspath(args.repo)
    
    call_sites = find_call_sites(repo_root, args.function_id)
    
    result = {
        "call_sites": call_sites,
        "count": len(call_sites)
    }
    
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

