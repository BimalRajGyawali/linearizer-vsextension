import argparse
import sys
import os
import json
import importlib.util
import types
import traceback
import threading
import bdb
import inspect
import ast
import copy
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Tuple

# --------------------------
# Logging Setup
# --------------------------
# Create logs directory if it doesn't exist
LOG_DIR = os.path.join(os.path.dirname(__file__), "..", "logs")
os.makedirs(LOG_DIR, exist_ok=True)

# Log file path with timestamp
LOG_FILE = os.path.join(LOG_DIR, f"tracer_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")

# Global log file handle
_log_file = None

def init_logging():
    """Initialize logging to file."""
    global _log_file
    _log_file = open(LOG_FILE, "a", encoding="utf-8")
    log("=" * 80)
    log(f"Tracer started at {datetime.now().isoformat()}")
    log(f"Log file: {LOG_FILE}")
    log("=" * 80)

def log(message, level="INFO"):
    """Write log message to file with timestamp."""
    if _log_file:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        _log_file.write(f"[{timestamp}] [{level}] {message}\n")
        _log_file.flush()  # Ensure immediate write

def log_exception(e, context=""):
    """Log an exception with traceback."""
    log(f"Exception in {context}: {str(e)}", "ERROR")
    log(f"Traceback:\n{traceback.format_exc()}", "ERROR")

# --------------------------
# Helpers
# --------------------------
def send_event(event_json):
    # Only send_event writes to stderr (for Rust communication)
    # All other output goes to log file
    print(json.dumps(event_json, separators=(",", ":")), flush=True, file=sys.stderr)
    log(f"Sent event: {json.dumps(event_json, separators=(',', ':'))[:200]}...")  # Log first 200 chars

def import_module_from_path(repo_root: str, rel_path: str):
    rel_path = rel_path.lstrip("/")
    abs_path = os.path.join(repo_root, rel_path)
    mod_name = rel_path[:-3].replace("/", ".")
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)
    spec = importlib.util.spec_from_file_location(mod_name, abs_path)
    module = importlib.util.module_from_spec(spec)
    pkg_name = ".".join(mod_name.split(".")[:-1])
    if pkg_name:
        module.__package__ = pkg_name
    spec.loader.exec_module(module)  # type: ignore
    return module

def safe_json(value):
    try:
        if isinstance(value, (str, int, float, bool, type(None))):
            return value
        if isinstance(value, (list, tuple, set)):
            return [safe_json(v) for v in value]
        if isinstance(value, dict):
            return {str(k): safe_json(v) for k, v in value.items()}
        if isinstance(value, (types.FunctionType, types.ModuleType, type, types.FrameType, types.TracebackType)):
            return f"<{type(value).__name__}>"
        return str(value)
    except Exception:
        return f"<unserializable {type(value).__name__}>"

TOP_LEVEL_SENTINELS = {"<top-level>", "<module>"}


def is_top_level_entry_name(name: Optional[str]) -> bool:
    if not name:
        return False
    return name.strip().lower() in TOP_LEVEL_SENTINELS


def derive_module_name(rel_path: str) -> str:
    trimmed = rel_path.lstrip("/")
    if trimmed.endswith(".py"):
        trimmed = trimmed[:-3]
    return trimmed.replace("/", ".") or "__main__"


def build_module_entry_callable(abs_path: str, module_name: str, repo_root: Optional[str] = None) -> Callable[[], None]:
    with open(abs_path, 'r', encoding='utf-8') as f:
        source = f.read()
    code_obj = compile(source, abs_path, 'exec')
    package_name = '.'.join(module_name.split('.')[:-1]) or None

    def module_entry():
        if repo_root and repo_root not in sys.path:
            sys.path.insert(0, repo_root)
        module_globals = {
            "__name__": module_name,
            "__file__": abs_path,
            "__package__": package_name,
            "__cached__": None,
            "__spec__": None,
            "__doc__": None,
            "__builtins__": __builtins__,
        }
        exec(code_obj, module_globals, module_globals)

    module_entry.__name__ = "<module>"
    module_entry.__qualname__ = "<module>"
    return module_entry

def get_function_signature(repo_root: str, entry_full_id: str):
    """Get the function signature (parameter names) for a given function using AST parsing."""
    try:
        log(f"get_function_signature called: repo_root={repo_root}, entry_full_id={entry_full_id}")
        if "::" not in entry_full_id:
            log("ERROR: Invalid entry_full_id format in get_function_signature", "ERROR")
            return {"error": "invalid entry id"}
        
        # Split the entry_full_id - it can be:
        # - path/to/file.py::function_name (top-level function)
        # - path/to/file.py::ClassName::method_name (class method)
        # - path/to/file.py::outer_function::inner_function (nested function)
        parts = entry_full_id.split("::")
        rel_path = parts[0]
        fn_path = parts[1:]  # Can be [function_name] or [ClassName, method_name] or [outer, inner]
        
        log(f"Parsing entry_full_id: rel_path={rel_path}, fn_path={fn_path}")

        if len(fn_path) == 1 and is_top_level_entry_name(fn_path[0]):
            return {
                "params": [],
                "param_count": 0,
                "param_types": [],
                "param_defaults": [],
                "param_required": [],
            }
        
        # Get absolute path to the file
        rel_path = rel_path.lstrip("/")
        abs_path = os.path.join(repo_root, rel_path)
        
        if not os.path.exists(abs_path):
            log(f"ERROR: File not found: {abs_path}", "ERROR")
            return {"error": f"file not found: {rel_path}"}
        
        # Parse the file with AST
        try:
            with open(abs_path, 'r', encoding='utf-8') as f:
                source = f.read()
            tree = ast.parse(source, filename=abs_path)
        except SyntaxError as e:
            log(f"ERROR: Syntax error parsing file: {e}", "ERROR")
            return {"error": f"syntax error in file: {str(e)}"}
        except Exception as e:
            log(f"ERROR: Error reading file: {e}", "ERROR")
            return {"error": f"error reading file: {str(e)}"}
        
        # Find the function in the AST
        target_func = None
        
        if len(fn_path) == 1:
            # Simple function: path/to/file.py::function_name
            for node in tree.body:
                if isinstance(node, ast.FunctionDef) and node.name == fn_path[0]:
                    target_func = node
                    break
        elif len(fn_path) == 2:
            # Could be class method or nested function
            # First try class method: path/to/file.py::ClassName::method_name
            for node in tree.body:
                if isinstance(node, ast.ClassDef) and node.name == fn_path[0]:
                    for item in node.body:
                        if isinstance(item, ast.FunctionDef) and item.name == fn_path[1]:
                            target_func = item
                            break
                    if target_func:
                        break
                    break
            
            # If not found as class method, try nested function
            if target_func is None:
                for node in tree.body:
                    if isinstance(node, ast.FunctionDef) and node.name == fn_path[0]:
                        # Look for nested function
                        for item in node.body:
                            if isinstance(item, ast.FunctionDef) and item.name == fn_path[1]:
                                target_func = item
                                break
                        if target_func:
                            break
                        break
        else:
            # More complex nesting - traverse step by step
            current_nodes = tree.body
            for i, part in enumerate(fn_path):
                found = False
                for node in current_nodes:
                    if isinstance(node, ast.FunctionDef) and node.name == part:
                        if i == len(fn_path) - 1:
                            # This is the target function
                            target_func = node
                            found = True
                            break
                        else:
                            # Continue searching inside this function
                            current_nodes = [n for n in node.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))]
                            found = True
                            break
                    elif isinstance(node, ast.ClassDef) and node.name == part:
                        if i == len(fn_path) - 1:
                            # Shouldn't happen, but handle it
                            break
                        else:
                            # Continue searching inside this class
                            current_nodes = node.body
                            found = True
                            break
                if not found:
                    break
        
        if target_func is None:
            # Fallback: try importing and using inspect (for cases AST can't handle)
            log(f"Function not found in AST, trying import fallback")
            try:
                module = import_module_from_path(repo_root, rel_path)
                # Try to get the function by traversing the path
                obj = module
                for part in fn_path:
                    obj = getattr(obj, part, None)
                    if obj is None:
                        break
                
                if obj is not None and callable(obj):
                    sig = inspect.signature(obj)
                    params = list(sig.parameters.keys())
                    log(f"Function signature (via import): params={params}, param_count={len(params)}")
                    return {
                        "params": params,
                        "param_count": len(params)
                    }
            except Exception as import_error:
                log(f"Import fallback also failed: {import_error}")
        
        if target_func is None:
            log(f"ERROR: Function {'::'.join(fn_path)} not found in {rel_path}", "ERROR")
            return {"error": f"function {'::'.join(fn_path)} not found"}
        
        # Extract parameters from the AST function node
        params = []
        param_types = []
        param_defaults = []
        param_required = []
        total_args = len(target_func.args.args)
        defaults_count = len(target_func.args.defaults)
        is_method = len(fn_path) == 2  # Class method if path has 2 parts (ClassName::method_name)
        
        def unparse_annotation(annotation):
            """Convert AST annotation node to string representation."""
            if annotation is None:
                return None
            try:
                # Try using ast.unparse if available (Python 3.9+)
                if hasattr(ast, 'unparse'):
                    return ast.unparse(annotation)
                else:
                    # Fallback: manual unparsing for common cases
                    if isinstance(annotation, ast.Name):
                        return annotation.id
                    elif isinstance(annotation, ast.Attribute):
                        # Handle qualified names like typing.Dict, db.Connection
                        parts = []
                        node = annotation
                        while isinstance(node, ast.Attribute):
                            parts.insert(0, node.attr)
                            node = node.value
                        if isinstance(node, ast.Name):
                            parts.insert(0, node.id)
                        return '.'.join(parts)
                    elif isinstance(annotation, ast.Constant):
                        return str(annotation.value)
                    elif isinstance(annotation, ast.Subscript):
                        # Handle generic types like List[str], Dict[str, int]
                        if isinstance(annotation.value, ast.Name):
                            base = annotation.value.id
                        elif isinstance(annotation.value, ast.Attribute):
                            base = unparse_annotation(annotation.value)
                        else:
                            base = 'Unknown'
                        return base
                    else:
                        # Fallback to string representation
                        return str(annotation)
            except Exception as e:
                log(f"Error unparsing annotation: {e}", "WARNING")
                return None
        
        def unparse_default(default):
            """Convert AST default value node to Python literal."""
            if default is None:
                return None
            try:
                if hasattr(ast, 'unparse'):
                    return ast.unparse(default)
                elif isinstance(default, ast.Constant):
                    return default.value
                elif isinstance(default, (ast.Str, ast.Num)):
                    # Python < 3.8 compatibility
                    if isinstance(default, ast.Str):
                        return default.s
                    elif isinstance(default, ast.Num):
                        return default.n
                elif isinstance(default, ast.NameConstant):
                    # Python < 3.8: True, False, None
                    return default.value
                elif isinstance(default, (ast.List, ast.Dict, ast.Tuple)):
                    # Complex literals - try to evaluate safely
                    return None  # Don't try to unparse complex defaults
                else:
                    return None
            except Exception as e:
                log(f"Error unparsing default: {e}", "WARNING")
                return None
        
        for i, arg in enumerate(target_func.args.args):
            # Skip 'self' and 'cls' parameters only for class methods
            if is_method and arg.arg in ('self', 'cls'):
                continue
            
            params.append(arg.arg)
            
            # Extract type annotation
            type_str = unparse_annotation(arg.annotation)
            param_types.append(type_str)
            
            # Extract default value
            default_index = i - (total_args - defaults_count)
            if default_index >= 0 and default_index < defaults_count:
                default_node = target_func.args.defaults[default_index]
                default_value = unparse_default(default_node)
                param_defaults.append(default_value)
                param_required.append(False)
            else:
                param_defaults.append(None)
                param_required.append(True)
        
        log(f"Function signature (via AST): params={params}, param_types={param_types}, param_count={len(params)}")
        
        return {
            "params": params,
            "param_count": len(params),
            "param_types": param_types,
            "param_defaults": param_defaults,
            "param_required": param_required,
        }
    except Exception as e:
        log_exception(e, "get_function_signature")
        return {"error": str(e)}

def extract_call_arguments(repo_root: str, entry_full_id: str, call_line: int, locals_dict: dict, globals_dict: dict, parent_file: str = None):
    """Extract function call arguments from a specific line using parent's locals/globals."""
    try:
        log(f"extract_call_arguments called: entry_full_id={entry_full_id}, call_line={call_line}, parent_file={parent_file}")
        if "::" not in entry_full_id:
            return {"error": "invalid entry id"}
        
        rel_path, fn_name = entry_full_id.split("::", 1)
        
        # Use parent_file if provided, otherwise use the nested function's file
        if parent_file:
            # parent_file is relative to repo_root
            if os.path.isabs(parent_file):
                abs_path = parent_file
            else:
                abs_path = os.path.join(repo_root, parent_file.lstrip("/"))
        else:
            abs_path = os.path.join(repo_root, rel_path.lstrip("/"))
        
        if not os.path.isfile(abs_path):
            return {"error": f"file not found: {abs_path}"}
        
        # Read the file and get the line
        with open(abs_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        if call_line < 1 or call_line > len(lines):
            return {"error": f"line {call_line} out of range"}
        
        call_line_text = lines[call_line - 1].strip()
        log(f"Extracting call from line {call_line}: {call_line_text}")
        
        # Parse the line to find function calls
        try:
            tree = ast.parse(call_line_text, mode='eval')
        except SyntaxError:
            # Try parsing as a statement instead
            try:
                tree = ast.parse(call_line_text, mode='exec')
            except SyntaxError as e:
                return {"error": f"cannot parse line: {str(e)}"}
        
        # Find the function call
        call_node = None
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                # Check if this call matches the function name
                if isinstance(node.func, ast.Name) and node.func.id == fn_name:
                    call_node = node
                    break
                elif isinstance(node.func, ast.Attribute):
                    # Handle method calls like obj.method()
                    if node.func.attr == fn_name:
                        call_node = node
                        break
        
        if not call_node:
            return {"error": f"function call to {fn_name} not found on line {call_line}"}
        
        # Evaluate arguments using parent's locals/globals
        args_list = []
        kwargs_dict = {}
        
        # Create evaluation context from parent's locals and globals
        eval_globals = dict(globals_dict)
        eval_locals = dict(locals_dict)
        
        # Get the function signature first to know which parameters are required
        sig_result = get_function_signature(repo_root, entry_full_id)
        accepted_params = []
        param_defaults = []
        if "error" not in sig_result:
            accepted_params = sig_result.get("params", [])
            param_defaults = sig_result.get("param_defaults", [])
            log(f"Function accepts parameters: {accepted_params}")
        
        # Track which parameters have defaults (are optional)
        params_with_defaults = set()
        if accepted_params and param_defaults:
            for i, default_val in enumerate(param_defaults):
                if i < len(accepted_params) and default_val is not None:
                    params_with_defaults.add(accepted_params[i])
        
        # Track missing required arguments
        missing_required = []
        
        # Evaluate positional arguments
        positional_arg_index = 0
        for arg in call_node.args:
            try:
                # Convert AST node to code and evaluate
                code = compile(ast.Expression(arg), '<string>', 'eval')
                value = eval(code, eval_globals, eval_locals)
                # Always add the value, even if None - let the function validate it
                # (We used to skip None values, but that causes required params to be missing)
                args_list.append(safe_json(value))
                positional_arg_index += 1
            except Exception as e:
                log(f"Error evaluating positional argument at index {positional_arg_index}: {e}", "WARNING")
                # Check if this is a required parameter
                if accepted_params and positional_arg_index < len(accepted_params):
                    param_name = accepted_params[positional_arg_index]
                    if param_name not in params_with_defaults:
                        missing_required.append(param_name)
                        log(f"Required parameter {param_name} failed to evaluate: {e}", "ERROR")
                # Don't add anything to args_list for this argument - it will be missing
                positional_arg_index += 1
        
        # Evaluate keyword arguments
        for kw in call_node.keywords:
            key = kw.arg if kw.arg else None
            if key:
                try:
                    code = compile(ast.Expression(kw.value), '<string>', 'eval')
                    value = eval(code, eval_globals, eval_locals)
                    # Always add the value, even if None - let the function validate it
                    kwargs_dict[key] = safe_json(value)
                except Exception as e:
                    log(f"Error evaluating keyword argument {key}: {e}", "WARNING")
                    # Check if this is a required parameter
                    if key in accepted_params and key not in params_with_defaults:
                        missing_required.append(key)
                        log(f"Required parameter {key} failed to evaluate: {e}", "ERROR")
                    # Don't add anything to kwargs_dict for this argument - it will be missing
        
        # Check if we're missing any required parameters
        if missing_required:
            log(f"WARNING: Missing required parameters after evaluation: {missing_required}", "WARNING")
            # Note: We continue anyway - the function call will fail with a better error message
        
        # Filter arguments to only those the function accepts
        if accepted_params:
            accepted_params_set = set(accepted_params)
            
            # Filter keyword arguments to only include those the function accepts
            original_kwargs_keys = set(kwargs_dict.keys())
            filtered_kwargs = {k: v for k, v in kwargs_dict.items() if k in accepted_params_set}
            filtered_out_kwargs = original_kwargs_keys - set(filtered_kwargs.keys())
            if filtered_out_kwargs:
                log(f"Filtered out keyword arguments not accepted by function: {filtered_out_kwargs}")
            
            # For positional arguments, limit to the number of parameters the function has
            # Count how many positional params are NOT already in kwargs
            positional_params_not_in_kwargs = [p for p in accepted_params if p not in filtered_kwargs]
            max_positional = len(positional_params_not_in_kwargs)
            
            # Limit positional arguments to what the function can accept
            if len(args_list) > max_positional:
                log(f"Limiting positional arguments from {len(args_list)} to {max_positional} (function has {len(accepted_params)} params, {len(filtered_kwargs)} provided as kwargs)")
                filtered_args = args_list[:max_positional]
            else:
                filtered_args = args_list
            
            args_list = filtered_args
            kwargs_dict = filtered_kwargs
            
            # Check again for missing required parameters after filtering
            provided_params = set(filtered_kwargs.keys())
            provided_positional_count = len(filtered_args)
            for i, param_name in enumerate(accepted_params):
                if param_name not in params_with_defaults:  # Required parameter
                    if param_name not in provided_params and i >= provided_positional_count:
                        if param_name not in missing_required:  # Avoid duplicates
                            missing_required.append(param_name)
            
            if missing_required:
                missing_params_str = ', '.join(missing_required)
                error_msg = f"Required parameters could not be extracted and will be missing: {missing_params_str}"
                log(error_msg, "ERROR")
                # Return an error so the caller knows arguments are incomplete
                return {"error": error_msg}
            
            log(f"Filtered arguments to match function signature: args={args_list}, kwargs={kwargs_dict}")
        else:
            # If we can't get the signature, we can't safely filter arguments
            # Return an error rather than using unfiltered arguments
            error_msg = sig_result.get('error', 'unknown error')
            log(f"ERROR: Could not get function signature to filter arguments: {error_msg}", "ERROR")
            return {"error": f"Could not get function signature to filter arguments: {error_msg}"}
        
        result = {
            "args": {"args": args_list, "kwargs": kwargs_dict}
        }
        log(f"Extracted arguments: args={args_list}, kwargs={kwargs_dict}")
        return result
    except Exception as e:
        log_exception(e, "extract_call_arguments")
        return {"error": str(e)}


def extract_call_arguments_runtime(
    repo_root: str,
    callee_entry_full_id: str,
    calling_entry_full_id: str,
    call_line: int,
    parent_file: Optional[str],
    calling_args_json: Optional[str],
):
    try:
        normalized_calling_entry = calling_entry_full_id.lstrip("/")
        if "::" not in normalized_calling_entry:
            return {"error": "invalid calling entry id"}
        rel_path, fn_name = normalized_calling_entry.split("::", 1)
        abs_path = os.path.join(repo_root, rel_path.lstrip("/"))
        if not os.path.isfile(abs_path):
            return {"error": f"file not found: {abs_path}"}

        args_list, kwargs_dict = parse_args_json(calling_args_json)
        top_level_entry = is_top_level_entry_name(fn_name)
        module_name = derive_module_name(rel_path)

        if top_level_entry:
            fn = build_module_entry_callable(abs_path, module_name, repo_root)
            effective_fn_name = "<module>"
        else:
            mod = import_module_from_path(repo_root, rel_path)
            if not hasattr(mod, fn_name):
                return {"error": f"function not found: {fn_name}"}
            fn = getattr(mod, fn_name)
            effective_fn_name = fn_name

        dbg = PersistentDebugger()
        stop_file = ensure_abs_path(repo_root, parent_file) or abs_path
        dbg.target_file = stop_file
        dbg.pinned_target_file = True
        dbg.run_function_once(fn, args_list, kwargs_dict)
        dbg.continue_until(call_line, effective_fn_name)
        if not dbg.wait_for_event(timeout=30.0):
            return {"error": f"Timed out executing {calling_entry_full_id} to line {call_line}"}
        raw_locals = dbg.last_raw_locals or {}
        raw_globals = dbg.last_raw_globals or {}
        dbg.step_event.set()
        return extract_call_arguments(repo_root, callee_entry_full_id, call_line, raw_locals, raw_globals, parent_file)
    except Exception as e:
        log_exception(e, "extract_call_arguments_runtime")
        return {"error": str(e)}

# --------------------------
# Linear Flow Cache Helpers
# --------------------------

def normalize_args_key(args_json: str) -> str:
    """Return a stable string representation of args_json for cache keys."""
    if not args_json:
        return "{}"
    try:
        parsed = json.loads(args_json)
        return json.dumps(parsed, sort_keys=True)
    except Exception:
        return args_json


def parse_location_spec(value: str, default_function: Optional[str]) -> Tuple[str, int]:
    """Parse strings like 'function_name:42' into (function, line)."""
    if not value:
        raise ValueError("location must be non-empty")
    if ":" in value:
        func, line_text = value.rsplit(":", 1)
        func = func or default_function
    else:
        if default_function is None:
            raise ValueError("function name is required when location has no ':'")
        func = default_function
        line_text = value
    if func is None:
        raise ValueError("function name could not be determined for location")
    try:
        line = int(line_text)
    except ValueError as exc:
        raise ValueError(f"invalid line number in location '{value}'") from exc
    return func, line


def ensure_abs_path(repo_root: str, file_value: Optional[str]) -> Optional[str]:
    if not file_value:
        return None
    if os.path.isabs(file_value):
        return os.path.abspath(file_value)
    normalized = file_value.lstrip("/")
    return os.path.abspath(os.path.join(repo_root, normalized))


def parse_args_json(args_json: Optional[str]) -> Tuple[List[Any], Dict[str, Any]]:
    args_list: List[Any] = []
    kwargs_dict: Dict[str, Any] = {}
    if not args_json:
        return args_list, kwargs_dict
    try:
        parsed = json.loads(args_json)
        args_list = parsed.get("args", []) or []
        kwargs_dict = parsed.get("kwargs", {}) or {}
    except Exception as e:
        log(f"WARNING: Failed to parse args_json: {e}", "WARNING")
    return args_list, kwargs_dict


@dataclass
class FlowTarget:
    function: str
    line: int
    raw_location: str
    file: Optional[str] = None

    @property
    def label(self) -> str:
        return self.raw_location or f"{self.function}:{self.line}"


class LinearFlowRecorder:
    """Maintain a linearized list of execution events for a flow."""

    def __init__(self, flow_name: str, entry_full_id: str, args_key: str):
        self.flow_name = flow_name
        self.entry_full_id = entry_full_id
        self.args_key = args_key
        self._events: List[Dict[str, Any]] = []
        self._lock = threading.Lock()
        self._last_served_index = -1

    def record(self, raw_event: Dict[str, Any]):
        if not raw_event:
            return
        with self._lock:
            linear_index = len(self._events)
            function_name = raw_event.get("function")
            line_no = raw_event.get("line")
            flow_event = {
                "flow": self.flow_name,
                "entry_full_id": self.entry_full_id,
                "args_key": self.args_key,
                "linear_index": linear_index,
                "function": function_name,
                "line": line_no,
                "file": raw_event.get("filename"),
                "location": f"{function_name}:{line_no}",
                "locals": copy.deepcopy(raw_event.get("locals", {})),
                "globals": copy.deepcopy(raw_event.get("globals", {})),
                "event": raw_event.get("event"),
            }
            self._events.append(flow_event)

    def _match_event(self, event: Dict[str, Any], function_name: str, line: int, file_path: Optional[str]) -> bool:
        if function_name and event.get("function") != function_name:
            return False
        if file_path and event.get("file") != file_path:
            return False
        if line is not None and event.get("line") is not None and event.get("line") < line:
            return False
        return True

    def find_index(self, function_name: str, line: int, *, after_index: Optional[int] = None, file_path: Optional[str] = None, allow_wrap: bool = False) -> Optional[int]:
        with self._lock:
            if not self._events:
                return None
            start = after_index + 1 if after_index is not None else 0
            if start < 0:
                start = 0
            search_order = list(range(start, len(self._events)))
            if allow_wrap and start > 0:
                search_order.extend(range(0, start))
            for idx in search_order:
                event = self._events[idx]
                if self._match_event(event, function_name, line, file_path):
                    return idx
            return None

    def slice_to_index(self, index: int) -> List[Dict[str, Any]]:
        with self._lock:
            if index < 0 or index >= len(self._events):
                return []
            return [copy.deepcopy(evt) for evt in self._events[: index + 1]]

    def mark_served(self, index: int):
        with self._lock:
            if index > self._last_served_index:
                self._last_served_index = index

    @property
    def last_served_index(self) -> int:
        with self._lock:
            return self._last_served_index

    def latest_index(self) -> Optional[int]:
        with self._lock:
            if not self._events:
                return None
            return len(self._events) - 1


def build_flow_payload(flow_state: LinearFlowRecorder, target_index: int, target: FlowTarget) -> Dict[str, Any]:
    events_slice = flow_state.slice_to_index(target_index)
    if not events_slice:
        return {}
    last_event = events_slice[-1]
    payload = {
        "event": "line",
        "flow": flow_state.flow_name,
        "entry_full_id": flow_state.entry_full_id,
        "args_key": flow_state.args_key,
        "target_location": target.label,
        "requested_line": target.line,
        "requested_function": target.function,
        "linear_index": target_index,
        "line": last_event.get("line"),
        "filename": last_event.get("file"),
        "function": last_event.get("function"),
        "locals": last_event.get("locals"),
        "globals": last_event.get("globals"),
        "events": events_slice,
        "last_served_index": flow_state.last_served_index,
    }
    return payload

# --------------------------
# Persistent Debugger
# --------------------------
class PersistentDebugger(bdb.Bdb):
    def __init__(self, event_callback: Optional[Callable[[Dict[str, Any]], None]] = None):
        super().__init__()
        self.step_event = threading.Event()  # allows debugger thread to proceed
        self.ready_event = threading.Event()  # signals main that last_event is ready
        self.target_line = None
        self.target_function = None  # Target function name to stop in
        self.last_event = None
        self.running_thread = None
        self.target_file = None
        self.pinned_target_file = False
        self.thread_exception = None  # Store exceptions from the debugger thread
        self.event_callback = event_callback
        self.last_raw_locals: Optional[Dict[str, Any]] = None
        self.last_raw_globals: Optional[Dict[str, Any]] = None

    def user_line(self, frame):
        try:
            lineno = frame.f_lineno
            fname = os.path.abspath(frame.f_code.co_filename)
            log(f"user_line called: line {lineno} in {fname}")
            funcname = frame.f_code.co_name
            
            # Check if we're in the target function
            in_target_function = self.target_function is None or funcname == self.target_function
            
            # Handle case where target_file might be None (shouldn't happen, but be safe)
            if self.target_file is None:
                log(f"WARNING: target_file is None, accepting line {lineno} in {fname}")
                # Accept the line and set target_file (this should only happen in edge cases)
                self.target_file = fname
            # Only accept lines from the target file, OR if we're in the target function
            # (this allows stepping through nested functions in different files)
            elif fname != self.target_file:
                if self.pinned_target_file:
                    log(f"Skipping line {lineno} in {fname} (pinned to {self.target_file})")
                    return
                # If we're in the target function but in a different file, update target_file
                # to allow stepping through this nested function
                if in_target_function and self.target_function is not None:
                    log(f"Switching target_file from {self.target_file} to {fname} (target function {self.target_function} in different file)")
                    self.target_file = fname
                else:
                    log(f"Skipping line {lineno} (not in target file {self.target_file}, not in target function {self.target_function})")
                    return
            locals_snapshot = {k: safe_json(v) for k, v in frame.f_locals.items()}
            self.last_raw_locals = dict(frame.f_locals)
            
            # Capture only user-declared globals from the current file
            globals_snapshot = {}
            builtin_names = {'__builtins__', '__file__', '__name__', '__doc__', '__package__', 
                            '__loader__', '__spec__', '__cached__', '__annotations__'}
            
            for k, v in frame.f_globals.items():
                # Skip built-in names and system variables
                if k in builtin_names or (k.startswith('__') and k.endswith('__')):
                    continue
                
                # Skip imported modules
                if isinstance(v, types.ModuleType):
                    continue
                
                # Skip functions (only want variables)
                if isinstance(v, types.FunctionType):
                    continue
                
                # Skip classes (only want variables)
                if isinstance(v, type):
                    continue
                
                # Skip typing constructs (Dict, List, Optional, etc. from typing module)
                if hasattr(v, '__module__') and v.__module__ == 'typing':
                    continue
                
                # Skip typing._GenericAlias and similar typing constructs
                if type(v).__module__ == 'typing':
                    continue
                
                # Only include simple variable types: int, str, float, bool, None, list, dict, tuple, set
                # These are the actual variable values the user declared
                globals_snapshot[k] = safe_json(v)
            self.last_raw_globals = dict(frame.f_globals)
            self.last_event = {
                "event": "line",
                "filename": fname,
                "function": funcname,
                "line": lineno,
                "locals": locals_snapshot,
                "globals": globals_snapshot
            }
            if self.event_callback:
                try:
                    self.event_callback(copy.deepcopy(self.last_event))
                except Exception as callback_error:
                    log_exception(callback_error, "event_callback")
            log(f"Created line event: {funcname}:{lineno}, target_line={self.target_line}, target_function={self.target_function}")
            # Stop if we've reached the target line AND we're in the target function
            # This ensures we stop in the correct function, not in nested function calls
            if self.target_line is not None and lineno >= self.target_line and in_target_function:
                log(f"Reached target line {self.target_line} in target function {self.target_function} (current: {funcname}:{lineno}), stopping and waiting")
                self.set_step()
                # Notify main thread that we have a fresh event ready
                self.ready_event.set()
                log("Set ready_event, waiting for step_event")
                # Wait until the main thread asks us to continue
                self.step_event.clear()
                self.step_event.wait()
                log("Received step_event, continuing")
        except Exception as e:
            log_exception(e, "user_line")
            # Don't crash, just skip this line
            return

    def continue_until(self, line, function_name=None):
        log(f"continue_until called with line={line}, function_name={function_name}")
        self.target_line = line
        self.target_function = function_name
        self.ready_event.clear()
        self.step_event.set()
        log(f"Set target_line={line}, target_function={function_name}, step_event to continue execution")

    def wait_for_event(self, timeout=None):
        return self.ready_event.wait(timeout=timeout)

    def user_return(self, frame, return_value):
        """Called when a function returns."""
        # If function completes before reaching target line, create an event
        if self.target_line is not None and self.last_event is None:
            # Function completed before we could capture an event
            # Create a completion event
            fname = os.path.abspath(frame.f_code.co_filename)
            if fname == self.target_file:
                self.last_event = {
                    "event": "return",
                    "filename": fname,
                    "function": frame.f_code.co_name,
                    "line": frame.f_lineno,
                    "locals": {k: safe_json(v) for k, v in frame.f_locals.items()},
                    "return_value": safe_json(return_value)
                }
                self.last_raw_locals = dict(frame.f_locals)
                self.last_raw_globals = dict(frame.f_globals)
                self.ready_event.set()

    def run_function_once(self, fn, args=None, kwargs=None):
        args = args or []
        kwargs = kwargs or {}
        log(f"run_function_once called: fn={fn.__name__ if hasattr(fn, '__name__') else str(fn)}, args={args}, kwargs={kwargs}")
        
        def run_with_error_handling():
            try:
                log("Starting function execution in debugger thread")
                self.runctx(
                    "fn(*args, **kwargs)",
                    globals={"fn": fn, "args": args, "kwargs": kwargs},
                    locals={}
                )
                log("Function execution completed normally")
                # If we get here, function completed normally
                # Check if we need to set ready_event (in case function completed before target line)
                if not self.ready_event.is_set() and self.target_line is not None:
                    # Function completed but we never reached target line
                    log("Function completed before reaching target line, setting ready_event")
                    self.ready_event.set()
            except Exception as e:
                # Store the exception
                log_exception(e, "run_with_error_handling")
                self.thread_exception = e
                # Set ready_event so wait_for_event doesn't hang
                self.ready_event.set()
                log("Exception occurred, set ready_event and thread_exception")
                # Do not send event here - let main thread handle it
                # Do not re-raise here, let the main thread handle it via wait_for_event
        
        self.running_thread = threading.Thread(target=run_with_error_handling)
        self.running_thread.start()
        log("Started debugger thread")
        # let the debugger start paused until the first continue_until
        self.step_event.clear()
        log("Cleared step_event (debugger paused)")
        self.last_raw_locals = None
        self.last_raw_globals = None

    def set_event_callback(self, callback: Optional[Callable[[Dict[str, Any]], None]]):
        self.event_callback = callback

# --------------------------
# Main CLI
# --------------------------
def main():
    # Initialize logging first
    init_logging()
    
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--repo_root",
        required=False,
        default="/home/bimal/Documents/ucsd/research/code/git-visualizer"
    )
    parser.add_argument(
        "--entry_full_id",
        required=False,
        default="/analyzer.py::analyze_git_repo"
    )
    parser.add_argument(
        "--args_json",
        required=False,
        # No default business-specific kwargs; start with empty args/kwargs
        default='{"args": [], "kwargs": {}}'
    )
    parser.add_argument(
        "--stop_line",
        required=False,
        type=int
    )
    parser.add_argument(
        "--stop_location",
        required=False,
        help="Stop target in the format function_name:line_number"
    )
    parser.add_argument(
        "--stop_file",
        required=False,
        help="Restrict the initial stop target to a specific file path"
    )
    parser.add_argument(
        "--flow_name",
        required=False,
        help="Name of the logical flow being traced"
    )
    parser.add_argument(
        "--get_signature",
        action="store_true",
        help="Get function signature instead of tracing"
    )
    parser.add_argument(
        "--extract-call-args",
        action="store_true",
        help="Extract call arguments from a line"
    )
    parser.add_argument(
        "--call-line",
        type=int,
        help="Line number where function is called (for --extract-call-args)"
    )
    parser.add_argument(
        "--locals",
        help="JSON string of parent function's locals (for --extract-call-args)"
    )
    parser.add_argument(
        "--globals",
        help="JSON string of parent function's globals (for --extract-call-args)"
    )
    parser.add_argument(
        "--parent-file",
        help="File path where the call happens (for --extract-call-args)"
    )
    parser.add_argument(
        "--calling-entry-full-id",
        help="Entry full id of the calling function when extracting call args"
    )
    parser.add_argument(
        "--calling-args-json",
        help="JSON string of arguments for the calling function when extracting call args"
    )
    args = parser.parse_args()
    
    log(f"Command line arguments: repo_root={args.repo_root}, entry_full_id={args.entry_full_id}, stop_line={args.stop_line}, get_signature={args.get_signature}")
    
    # If --get_signature is set, return signature and exit
    if args.get_signature:
        log("Getting function signature")
        result = get_function_signature(args.repo_root, args.entry_full_id)
        log(f"Signature result: {result}")
        print(json.dumps(result), flush=True)
        sys.exit(0)
    
    # If --extract-call-args is set, extract arguments and exit
    if args.extract_call_args:
        if args.call_line is None:
            parser.error("--call-line is required when using --extract-call-args")
        calling_entry = getattr(args, "calling_entry_full_id", None)
        if calling_entry:
            log("Extracting call arguments via runtime execution")
            result = extract_call_arguments_runtime(
                args.repo_root,
                args.entry_full_id,
                calling_entry,
                args.call_line,
                args.parent_file,
                getattr(args, "calling_args_json", None),
            )
        else:
            locals_dict = {}
            globals_dict = {}
            if args.locals:
                try:
                    locals_dict = json.loads(args.locals)
                except Exception as e:
                    log(f"Error parsing --locals: {e}", "WARNING")
            if args.globals:
                try:
                    globals_dict = json.loads(args.globals)
                except Exception as e:
                    log(f"Error parsing --globals: {e}", "WARNING")
            log("Extracting call arguments from provided context")
            result = extract_call_arguments(args.repo_root, args.entry_full_id, args.call_line, locals_dict, globals_dict, args.parent_file)
        log(f"Extraction result: {result}")
        print(json.dumps(result), flush=True)
        sys.exit(0)
    
    # Otherwise, require a stop target
    if args.stop_line is None and not args.stop_location:
        log("ERROR: --stop_line or --stop_location is required", "ERROR")
        parser.error("--stop_line or --stop_location is required when not using --get_signature")
    repo_root = args.repo_root
    entry_full_id = args.entry_full_id
    args_json = args.args_json
    stop_line_arg = args.stop_line
    stop_location = args.stop_location
    stop_file = ensure_abs_path(repo_root, args.stop_file)
    flow_name = args.flow_name if hasattr(args, "flow_name") and args.flow_name else None
    
    log(f"Tracing configuration:")
    log(f"  repo_root: {repo_root}")
    log(f"  entry_full_id: {entry_full_id}")
    log(f"  stop_line: {stop_line_arg}")
    log(f"  stop_location: {stop_location}")
    log(f"  stop_file: {stop_file}")
    log(f"  args_json: {args_json}")
    normalized_args_key = normalize_args_key(args_json)
    args_list = []
    kwargs_dict = {}
    if args_json:
        try:
            parsed = json.loads(args_json)
            args_list = parsed.get("args", [])
            kwargs_dict = parsed.get("kwargs", {})
        except Exception:
            pass
    if "::" not in entry_full_id:
        log("ERROR: Invalid entry_full_id format (missing '::')", "ERROR")
        sys.exit(1)
    rel_path, fn_name = entry_full_id.split("::", 1)
    top_level_entry = is_top_level_entry_name(fn_name)
    abs_path = os.path.join(repo_root, rel_path.lstrip("/"))
    log(f"Parsed entry_full_id: rel_path={rel_path}, fn_name={fn_name}, abs_path={abs_path}")
    if not os.path.isfile(abs_path):
        error_msg = {"error": "file not found", "file": abs_path}
        log(f"ERROR: {error_msg}", "ERROR")
        print(json.dumps(error_msg))
        sys.exit(1)
    mod = None
    if not top_level_entry:
        try:
            log(f"Importing module from path: {rel_path}")
            mod = import_module_from_path(repo_root, rel_path)
            log(f"Module imported successfully: {mod}")
        except Exception as e:
            error_msg = {
                "error": "module import failed",
                "exception": str(e),
                "traceback": traceback.format_exc()
            }
            log_exception(e, "import_module_from_path")
            print(json.dumps(error_msg))
            sys.exit(1)

    module_name = derive_module_name(rel_path)
    if top_level_entry:
        log("Top-level entry detected; executing module scope via synthetic entry point")
        fn = build_module_entry_callable(abs_path, module_name, repo_root)
        effective_fn_name = "<module>"
    else:
        if not hasattr(mod, fn_name):
            error_msg = {"error": "function not found", "function": fn_name}
            log(f"ERROR: {error_msg}", "ERROR")
            print(json.dumps(error_msg))
            sys.exit(1)
        fn = getattr(mod, fn_name)
        log(f"Found function: {fn_name}, callable={callable(fn)}")
        effective_fn_name = fn_name
    
    # Filter arguments to match function signature - this ensures we don't pass
    # arguments that the function doesn't accept (fixes issues like passing 'metric_name'
    # to functions that don't accept it)
    sig_result = get_function_signature(repo_root, entry_full_id)
    if "error" not in sig_result:
        accepted_params = set(sig_result.get("params", []))
        log(f"Function accepts parameters: {accepted_params}")
        
        # Filter keyword arguments to only include those the function accepts
        original_kwargs_keys = set(kwargs_dict.keys())
        filtered_kwargs = {k: v for k, v in kwargs_dict.items() if k in accepted_params}
        filtered_out_kwargs = original_kwargs_keys - set(filtered_kwargs.keys())
        if filtered_out_kwargs:
            log(f"Filtered out keyword arguments not accepted by function: {filtered_out_kwargs}")
        
        # For positional arguments, limit to what the function can accept
        num_total_params = len(accepted_params)
        positional_params_not_in_kwargs = [p for p in sig_result.get("params", []) if p not in filtered_kwargs]
        max_positional = len(positional_params_not_in_kwargs)
        
        if len(args_list) > max_positional:
            log(f"Limiting positional arguments from {len(args_list)} to {max_positional} (function has {num_total_params} params, {len(filtered_kwargs)} provided as kwargs)")
            args_list = args_list[:max_positional]
        
        kwargs_dict = filtered_kwargs
        log(f"Filtered arguments to match function signature: args={args_list}, kwargs={kwargs_dict}")
    else:
        # If we can't get the signature, we can't safely filter arguments
        error_msg = sig_result.get('error', 'unknown error')
        log(f"WARNING: Could not get function signature to filter arguments: {error_msg}, using unfiltered arguments", "WARNING")
        # Note: We continue with unfiltered arguments here because this is the main entry point
        # The user-provided args_json should already be correct, but nested calls will be filtered
    
    if flow_name is None:
        flow_name = effective_fn_name

    if stop_location and top_level_entry:
        stop_location = stop_location.replace("<top-level>", effective_fn_name)

    if stop_location:
        initial_function, initial_line = parse_location_spec(stop_location, effective_fn_name)
        initial_location_label = stop_location
    else:
        initial_function = effective_fn_name
        initial_line = stop_line_arg
        initial_location_label = f"{initial_function}:{initial_line}"

    if initial_line is None:
        log("ERROR: Initial line could not be determined", "ERROR")
        sys.exit(1)

    flow_state = LinearFlowRecorder(flow_name, entry_full_id, normalized_args_key)

    dbg = PersistentDebugger(event_callback=flow_state.record)
    dbg.target_file = abs_path  # Start within entry file
    dbg.pinned_target_file = False
    dbg.target_function = None
    dbg.repo_root = repo_root
    log(f"Created PersistentDebugger, target_file={abs_path}, flow={flow_name}")
    log(f"Starting function execution with args={args_list}, kwargs={kwargs_dict}")
    dbg.run_function_once(fn, args_list, kwargs_dict)

    def emit_error(message: str, trace: Optional[str] = None, target_label: Optional[str] = None):
        error_event = {
            "event": "error",
            "error": message,
            "traceback": trace,
            "flow": flow_name,
            "target_location": target_label,
            "entry_full_id": entry_full_id,
        }
        log(f"Sending error event: {message}", "ERROR")
        send_event(error_event)

    def wait_for_debugger(target: FlowTarget) -> bool:
        log(f"Waiting for debugger event for {target.label} (timeout=30.0s)")
        if not dbg.wait_for_event(timeout=30.0):
            log("wait_for_event timed out after 30 seconds", "WARNING")
            thread_alive = dbg.running_thread.is_alive() if dbg.running_thread else False
            log(f"Thread alive status: {thread_alive}")
            if not thread_alive:
                if dbg.thread_exception:
                    log_exception(dbg.thread_exception, "thread execution")
                    emit_error(str(dbg.thread_exception), traceback.format_exc(), target.label)
                else:
                    emit_error("Function execution thread died before reaching target location", target_label=target.label)
            else:
                emit_error(f"Timeout waiting for {target.label}", target_label=target.label)
            return False
        if dbg.thread_exception:
            log_exception(dbg.thread_exception, "function execution")
            emit_error(str(dbg.thread_exception), traceback.format_exc(), target.label)
            return False
        return True

    current_target: Optional[FlowTarget] = None

    def trace_to_target(target: FlowTarget) -> bool:
        nonlocal current_target
        current_target = target
        log(f"trace_to_target requested: {target.label}, file_override={target.file}")
        next_index = flow_state.find_index(target.function, target.line, after_index=flow_state.last_served_index, file_path=target.file, allow_wrap=False)
        if next_index is None:
            log(f"Target {target.label} not found after last index {flow_state.last_served_index}, searching earlier events")
            earlier_index = flow_state.find_index(target.function, target.line, file_path=target.file, allow_wrap=True)
            if earlier_index is not None and earlier_index <= flow_state.last_served_index:
                next_index = earlier_index
        if next_index is None:
            log(f"Continuing debugger to reach new target {target.label}")
            if target.file:
                dbg.target_file = target.file
            dbg.pinned_target_file = target.file is not None
            dbg.continue_until(target.line, target.function)
            if not wait_for_debugger(target):
                return False
            next_index = flow_state.find_index(target.function, target.line, after_index=flow_state.last_served_index, file_path=target.file, allow_wrap=False)
            if next_index is None:
                log("Target still not found after execution; using latest available index", "WARNING")
                latest_index = flow_state.latest_index()
                if latest_index is None:
                    emit_error(f"No events recorded for target {target.label}", target_label=target.label)
                    return False
                next_index = latest_index
        flow_state.mark_served(next_index)
        payload = build_flow_payload(flow_state, next_index, target)
        if not payload:
            emit_error(f"Failed to build payload for {target.label}", target_label=target.label)
            return False
        send_event(payload)
        return True

    def parse_flow_target_from_input(raw_input: str) -> FlowTarget:
        stripped = raw_input.strip()
        command_data = None
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                command_data = json.loads(stripped)
                log(f"Parsed JSON command: {command_data}")
            except json.JSONDecodeError as decode_error:
                log(f"Failed to decode JSON command: {decode_error}", "ERROR")
                raise
        if command_data is not None:
            flow_value = command_data.get("flow")
            if flow_value and flow_value != flow_name:
                log(f"WARNING: Command targeted flow '{flow_value}' but tracer flow is '{flow_name}'", "WARNING")
            location_value = command_data.get("location")
            function_override = command_data.get("function") or effective_fn_name
            file_override = ensure_abs_path(repo_root, command_data.get("file"))
            if location_value:
                function_name, requested_line = parse_location_spec(location_value, function_override)
                location_label = location_value
            else:
                line_value = command_data.get("line")
                if line_value is None:
                    raise ValueError("command missing 'line' or 'location'")
                requested_line = int(line_value)
                function_name = function_override
                location_label = f"{function_name}:{requested_line}"
            return FlowTarget(function=function_name, line=requested_line, raw_location=location_label, file=file_override)
        else:
            requested_line = int(stripped)
            return FlowTarget(function=effective_fn_name, line=requested_line, raw_location=f"{effective_fn_name}:{requested_line}")

    initial_target = FlowTarget(
        function=initial_function,
        line=initial_line,
        raw_location=initial_location_label,
        file=stop_file,
    )
    with open("debugger_input.log", "a") as f:
        f.write(f"{initial_target.label}\n")
    if not trace_to_target(initial_target):
        sys.exit(1)

    # Interactive stepping using flow-aware targets
    log("Entering interactive stepping loop")
    while True:
        try:
            log("Waiting for user input (stdin)")
            user_input = input().strip()
            log(f"Received user input: '{user_input}'")
            with open("debugger_input.log", "a") as f:
                f.write(f"Received input: {user_input}\n")

            if not user_input or user_input == "0":
                log("User input is empty or '0', breaking loop")
                break

            try:
                target = parse_flow_target_from_input(user_input)
            except Exception as parse_error:
                log(f"Failed to parse target from input '{user_input}': {parse_error}", "ERROR")
                continue

            with open("debugger_input.log", "a") as f:
                f.write(f"Target: {target.label}\n")

            if not trace_to_target(target):
                break
        except Exception as e:
            log_exception(e, "interactive stepping loop")
            # Don't print to stderr, just log it

    log("Tracer exiting")
    if _log_file:
        _log_file.close()

if __name__ == "__main__":
    try:
        main()
    finally:
        if _log_file:
            _log_file.close()

