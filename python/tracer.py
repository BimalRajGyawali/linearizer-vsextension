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
    """Get the function signature (parameter names) for a given function."""
    try:
        log(f"get_function_signature called: repo_root={repo_root}, entry_full_id={entry_full_id}")
        if "::" not in entry_full_id:
            log("ERROR: Invalid entry_full_id format in get_function_signature", "ERROR")
            return {"error": "invalid entry id"}
        
        rel_path, fn_name = entry_full_id.split("::", 1)
        log(f"Parsing entry_full_id: rel_path={rel_path}, fn_name={fn_name}")
        
        module = import_module_from_path(repo_root, rel_path)
        log(f"Module imported: {module}")
        
        func = getattr(module, fn_name, None)
        log(f"Function lookup: fn_name={fn_name}, found={func is not None}, callable={callable(func) if func else False}")
        
        if func is None or not callable(func):
            log(f"ERROR: Function {fn_name} not found or not callable", "ERROR")
            return {"error": f"function {fn_name} not found"}
        
        sig = inspect.signature(func)
        params = list(sig.parameters.keys())
        log(f"Function signature: params={params}, param_count={len(params)}")
        
        return {
            "params": params,
            "param_count": len(params)
        }
    except Exception as e:
        log_exception(e, "get_function_signature")
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
        lineno = frame.f_lineno
        fname = os.path.abspath(frame.f_code.co_filename)
        log(f"user_line called: line {lineno} in {fname}")
        # Only stop for the main target file
        if fname != self.target_file:
            log(f"Skipping line {lineno} (not in target file {self.target_file})")
            return
        funcname = frame.f_code.co_name
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
        in_target_function = self.target_function is None or funcname == self.target_function
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
        default='{"kwargs": {"metric_name": "test", "period": "last_7_days"}}'
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
    args = parser.parse_args()
    
    log(f"Command line arguments: repo_root={args.repo_root}, entry_full_id={args.entry_full_id}, stop_line={args.stop_line}, get_signature={args.get_signature}")
    
    # If --get_signature is set, return signature and exit
    if args.get_signature:
        log("Getting function signature")
        result = get_function_signature(args.repo_root, args.entry_full_id)
        log(f"Signature result: {result}")
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
    dbg = PersistentDebugger()
    dbg.target_file = abs_path  # Only this file counts for stop_line
    dbg.target_function = fn_name  # Only stop in the target function
    dbg.repo_root = repo_root
    log(f"Created PersistentDebugger, target_file={abs_path}, target_function={fn_name}")
    log(f"Starting function execution with args={args_list}, kwargs={kwargs_dict}")
    dbg.run_function_once(fn, args_list, kwargs_dict)
    # Run until initial stop_line in the target function
    log(f"Continuing until stop_line={stop_line} in function {fn_name}")
    dbg.continue_until(stop_line, fn_name)
    
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

