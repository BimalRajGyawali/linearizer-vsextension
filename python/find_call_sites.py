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


def find_function_calls_in_file(file_path: str, target_function_name: str, repo_root: str, target_file_path: str = None) -> List[Dict[str, any]]:
    """
    Find all calls to target_function_name in a given file.
    Returns a list of call sites with file, line, column, and call context.
    
    Args:
        file_path: Path to the file to search
        target_function_name: Name of the function to find calls to
        repo_root: Root of the repository
        target_file_path: Relative path to the file containing the target function (for import matching)
    """
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            source_code = f.read()
        
        tree = ast.parse(source_code, filename=file_path)
        call_sites = []
        
        # Track imports to find if the target function is imported
        imported_names = set()  # Names the function might be imported as (for direct calls)
        imported_modules = set()  # Module aliases that might contain the function (for module.function() calls)
        
        class ImportVisitor(ast.NodeVisitor):
            """First pass: collect imports to understand how the function might be called."""
            def visit_Import(self, node):
                # Track module imports: import analytics -> analytics is available
                for alias in node.names:
                    imported_modules.add(alias.asname if alias.asname else alias.name)
            
            def visit_ImportFrom(self, node):
                if node.module:
                    module_name = node.module
                    # Check if this import is from the target function's module
                    if target_file_path:
                        # Convert target_file_path to module path (e.g., "backend/services/analytics.py" -> "backend.services.analytics")
                        target_module_parts = target_file_path.replace('/', '.').replace('.py', '').split('.')
                        target_module_full = '.'.join(target_module_parts)  # "backend.services.analytics"
                        target_module_short = target_module_parts[-1]  # Just "analytics"
                        target_package = '.'.join(target_module_parts[:-1]) if len(target_module_parts) > 1 else None  # "backend.services"
                        
                        # Check if the import matches the target module
                        # Match cases like:
                        # - from backend.services.analytics import ... (full path)
                        # - from backend.services import ... (package level)
                        # - from .analytics import ... (relative import)
                        # - from analytics import ... (direct module)
                        module_matches = (
                            module_name == target_module_full or
                            module_name.endswith('.' + target_module_short) or
                            module_name == target_module_short or
                            (target_package and module_name == target_package) or
                            (target_package and module_name.endswith('.' + target_package.split('.')[-1]))
                        )
                        
                        # Also check for relative imports (e.g., from .analytics import ...)
                        if node.level > 0:  # Relative import
                            # For relative imports, we need to check if the relative path matches
                            # This is approximate - we check if the module name matches the target module short name
                            if target_module_short in module_name or module_name.endswith('.' + target_module_short):
                                module_matches = True
                        
                        if module_matches:
                            # This import is from the target function's module
                            for alias in node.names:
                                if alias.name == target_function_name:
                                    # Function is imported directly: from analytics import get_metric_period_analytics
                                    imported_names.add(alias.asname if alias.asname else alias.name)
                                elif alias.name == '*':
                                    # Wildcard import - the function might be available
                                    imported_names.add(target_function_name)
                    else:
                        # No target file path, but check if function name matches
                        for alias in node.names:
                            if alias.name == target_function_name:
                                imported_names.add(alias.asname if alias.asname else alias.name)
        
        # First pass: collect imports
        import_visitor = ImportVisitor()
        import_visitor.visit(tree)
        
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
                # We match any call where the function name matches exactly
                # This is permissive to catch all possible call sites
                is_match = False
                
                if isinstance(node.func, ast.Name):
                    # Direct call: function_name()
                    func_name = node.func.id
                    # Match if exact name matches or if it's imported with that name
                    is_match = (func_name == target_function_name or func_name in imported_names)
                    
                elif isinstance(node.func, ast.Attribute):
                    # Method call or module.function() call: obj.method() or module.function()
                    attr_name = node.func.attr
                    
                    # Match if the attribute name is the target function name
                    if attr_name == target_function_name:
                        # This could be:
                        # - module.get_metric_period_analytics() (module-qualified)
                        # - obj.get_metric_period_analytics() (method call)
                        # We include it - the user can determine if it's correct
                        is_match = True
                    elif attr_name in imported_names:
                        # Imported with a different name but called as attribute
                        is_match = True
                
                if is_match:
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
    
    # Store the relative path for import matching
    target_file_rel_path = path_part
    
    all_call_sites = []
    
    # Walk through all Python files in the repo
    for root, dirs, files in os.walk(repo_root):
        # Skip common directories that shouldn't be searched
        dirs[:] = [d for d in dirs if d not in {'.git', '__pycache__', '.venv', 'venv', 'env', 'node_modules'}]
        
        for file in files:
            if not file.endswith('.py'):
                continue
            
            file_path = os.path.join(root, file)
            # Skip the file containing the function itself (no point finding calls within itself)
            if os.path.abspath(file_path) == target_file_abs:
                continue
                
            call_sites = find_function_calls_in_file(file_path, func_name, repo_root, target_file_rel_path)
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

