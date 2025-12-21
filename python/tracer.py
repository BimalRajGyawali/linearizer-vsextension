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
from datetime import datetime

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
            default_index = i - (len(target_func.args.args) - len(target_func.args.defaults))
            if default_index >= 0 and default_index < len(target_func.args.defaults):
                default_node = target_func.args.defaults[default_index]
                default_value = unparse_default(default_node)
                param_defaults.append(default_value)
            else:
                param_defaults.append(None)
        
        log(f"Function signature (via AST): params={params}, param_types={param_types}, param_count={len(params)}")
        
        return {
            "params": params,
            "param_count": len(params),
            "param_types": param_types,
            "param_defaults": param_defaults
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

# --------------------------
# Persistent Debugger
# --------------------------
class PersistentDebugger(bdb.Bdb):
    def __init__(self):
        super().__init__()
        self.step_event = threading.Event()  # allows debugger thread to proceed
        self.ready_event = threading.Event()  # signals main that last_event is ready
        self.target_line = None
        self.target_function = None  # Target function name to stop in
        self.last_event = None
        self.running_thread = None
        self.target_file = None
        self.thread_exception = None  # Store exceptions from the debugger thread

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
                # If we're in the target function but in a different file, update target_file
                # to allow stepping through this nested function
                if in_target_function and self.target_function is not None:
                    log(f"Switching target_file from {self.target_file} to {fname} (target function {self.target_function} in different file)")
                    self.target_file = fname
                else:
                    log(f"Skipping line {lineno} (not in target file {self.target_file}, not in target function {self.target_function})")
                    return
            locals_snapshot = {k: safe_json(v) for k, v in frame.f_locals.items()}
            
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
            self.last_event = {
                "event": "line",
                "filename": fname,
                "function": funcname,
                "line": lineno,
                "locals": locals_snapshot,
                "globals": globals_snapshot
            }
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
        default="/home/bimal/Documents/ucsd/research/code/trap"
    )
    parser.add_argument(
        "--entry_full_id",
        required=False,
        default="backend/services/analytics.py::get_metric_period_analytics"
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
        log("Extracting call arguments")
        result = extract_call_arguments(args.repo_root, args.entry_full_id, args.call_line, locals_dict, globals_dict, args.parent_file)
        log(f"Extraction result: {result}")
        print(json.dumps(result), flush=True)
        sys.exit(0)
    
    # Otherwise, require stop_line
    if args.stop_line is None:
        log("ERROR: --stop_line is required", "ERROR")
        parser.error("--stop_line is required when not using --get_signature")
    repo_root = args.repo_root
    entry_full_id = args.entry_full_id
    args_json = args.args_json
    stop_line = args.stop_line
    
    log(f"Tracing configuration:")
    log(f"  repo_root: {repo_root}")
    log(f"  entry_full_id: {entry_full_id}")
    log(f"  stop_line: {stop_line}")
    log(f"  args_json: {args_json}")
    with open("debugger_input.log", "a") as f:
        f.write(f"{stop_line}\n")
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
    abs_path = os.path.join(repo_root, rel_path.lstrip("/"))
    log(f"Parsed entry_full_id: rel_path={rel_path}, fn_name={fn_name}, abs_path={abs_path}")
    if not os.path.isfile(abs_path):
        error_msg = {"error": "file not found", "file": abs_path}
        log(f"ERROR: {error_msg}", "ERROR")
        print(json.dumps(error_msg))
        sys.exit(1)
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
    if not hasattr(mod, fn_name):
        error_msg = {"error": "function not found", "function": fn_name}
        log(f"ERROR: {error_msg}", "ERROR")
        print(json.dumps(error_msg))
        sys.exit(1)
    fn = getattr(mod, fn_name)
    log(f"Found function: {fn_name}, callable={callable(fn)}")
    
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
    
    dbg = PersistentDebugger()
    dbg.target_file = abs_path  # Only this file counts for stop_line
    dbg.target_function = fn_name  # Only stop in the target function
    dbg.repo_root = repo_root
    log(f"Created PersistentDebugger, target_file={abs_path}, target_function={fn_name}")
    log(f"Configuring initial stop_line={stop_line} for function {fn_name}")
    dbg.continue_until(stop_line, fn_name)
    log(f"Starting function execution with args={args_list}, kwargs={kwargs_dict}")
    dbg.run_function_once(fn, args_list, kwargs_dict)
    # Run until initial stop_line in the target function
    
    # Wait for event with timeout to detect if thread died
    log("Waiting for event (timeout=30.0s)")
    if not dbg.wait_for_event(timeout=30.0):
        log("wait_for_event timed out after 30 seconds", "WARNING")
        # Check if thread is still alive
        thread_alive = dbg.running_thread.is_alive()
        log(f"Thread alive status: {thread_alive}")
        if not thread_alive:
            # Thread died, check if there's an exception stored
            log("Thread died, checking for exception", "ERROR")
            if dbg.thread_exception:
                log_exception(dbg.thread_exception, "thread execution")
                error_event = {
                    "event": "error",
                    "error": str(dbg.thread_exception),
                    "traceback": traceback.format_exc()
                }
            else:
                error_event = {
                    "event": "error",
                    "error": "Function execution thread died before reaching target line",
                    "traceback": "The function may have raised an exception or exited unexpectedly."
                }
            log(f"Sending error event: {error_event['error']}", "ERROR")
            send_event(error_event)
            sys.exit(1)
        else:
            # Thread alive but no event - timeout
            log("Thread alive but no event received - timeout", "ERROR")
            error_event = {
                "event": "error",
                "error": f"Timeout waiting for function to reach line {stop_line}",
                "traceback": "The function may be stuck in an infinite loop or waiting for input."
            }
            send_event(error_event)
            sys.exit(1)
    
    log("Event received, checking for exception or event")
    # Check if there's a stored exception
    if dbg.thread_exception:
        log_exception(dbg.thread_exception, "function execution")
        error_event = {
            "event": "error",
            "error": str(dbg.thread_exception),
            "traceback": traceback.format_exc()
        }
        log("Sending error event from thread_exception", "ERROR")
        send_event(error_event)
    elif dbg.last_event:
        # Send the event (could be regular event or error event from exception handler)
        log(f"Sending last_event: {dbg.last_event.get('event', 'unknown')} at line {dbg.last_event.get('line', 'unknown')}")
        send_event(dbg.last_event)
    else:
        # No event was set - this shouldn't happen but send an error
        log("WARNING: No event was generated", "WARNING")
        error_event = {
            "event": "error",
            "error": f"No event was generated when reaching line {stop_line}",
            "traceback": "The debugger may not have stopped at the expected line. The function may have completed before reaching the target line."
        }
        send_event(error_event)
    # Interactive stepping
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
            line = int(user_input)
            log(f"Parsed line number: {line}")
            dbg.continue_until(line)
            log("Waiting for event after continue_until")
            dbg.wait_for_event()
            log(f"Sending event: {dbg.last_event.get('event', 'unknown') if dbg.last_event else 'None'}")
            send_event(dbg.last_event)
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

