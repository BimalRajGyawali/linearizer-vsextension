(function () {
  const vscode = acquireVsCodeApi();
  const data = window.__INITIAL_DATA__ || {};
  const functions = data.functionBodies || {};
  const flows = Array.isArray(data.flows) ? data.flows : [];
  const changed = Array.isArray(data.changedFunctions) ? data.changedFunctions : [];

  // Baseline empty arguments for parents – real values come from user input or extracted call context
  const DEFAULT_PARENT_ARGS = {
    args: [],
    kwargs: {},
  };

  const INLINE_VAR_DISPLAY_LIMIT = 5;

  const MESSAGE_TYPES = Object.freeze({
    CALL_SITES_FOUND: 'call-sites-found',
    CALL_SITES_ERROR: 'call-sites-error',
    CALL_SITE_ARGS_EXTRACTED: 'call-site-args-extracted',
    CALL_SITE_ARGS_ERROR: 'call-site-args-error',
    TRACER_EVENT: 'tracer-event',
    TRACER_ERROR: 'tracer-error',
    FUNCTION_SIGNATURE: 'function-signature',
    SHOW_ARGS_FORM: 'show-args-form',
    TRACING_PARENT: 'tracing-parent',
    TRACING_CHILD: 'tracing-child',
    STORE_CALL_ARGS: 'store-call-args',
    EXECUTE_FROM_CALL_SITE: 'execute-from-call-site',
    RESET_TRACER: 'reset-tracer',
    FIND_CALL_SITES: 'find-call-sites',
    REQUEST_FUNCTION_SIGNATURE: 'request-function-signature',
    OPEN_SOURCE: 'open-source',
    REVEAL_FUNCTION_FILE: 'reveal-function-file',
    TRACE_LINE: 'trace-line',
  });

  const state = {
    expandedParents: new Set(),
    expandedCalls: new Set(),
    tracerEvents: [], // Array of trace events: { event, line, filename, function, locals, globals, error, traceback }
    callArgsByFunction: new Map(), // functionId -> { args: [], kwargs: {} }
    pendingCallTargets: new Map(), // key (functionId:line) -> callee functionId
    callSitesByFunction: new Map(), // functionId -> Array of call sites
    loadingCallSites: new Set(), // Set of functionIds for which we're loading call sites
    selectedCallSite: new Map(), // functionId -> selected call site
    functionSignatures: new Map(), // functionId -> Array of parameter names
    functionParamTypes: new Map(), // functionId -> Array of parameter types
    functionParamDefaults: new Map(), // functionId -> Array of parameter default values
    loadingSignatures: new Set(), // Set of functionIds for which we're loading signatures
    lastClickedLine: new Map(), // functionId -> { line, stopLine } - track last clicked line for execution
    expandedCallSites: new Set(), // Set of parentIds with expanded call sites
    expandedArgs: new Set(), // Set of parentIds with expanded args section
    tracingParent: new Set(), // Set of parent functionIds currently being traced
    tracingChild: new Set(), // Set of child functionIds currently being traced
    projectionView: null, // { functionId, line, file, code, variables: [{scope,name,value,type}]} or null
    pendingTraceRequest: null, // { functionId, line }
    callSiteStatuses: new Map(), // functionId -> Map(callSiteKey -> { state: 'success' | 'error', message?: string })
    flowTimelines: new Map(), // flowKey -> { flow, entryFullId, argsKey, events, targetLocation, requestedLine }
    activeFlowKey: null,
  };
  let pendingTraceTimer = null;

  function makeCallSiteKey(callSite) {
    if (!callSite || typeof callSite !== 'object') {
      return '';
    }
    const file = typeof callSite.file === 'string' ? normalisePath(callSite.file) : '';
    const line = typeof callSite.line === 'number' ? callSite.line : '';
    const caller = callSite.calling_function_id || callSite.calling_function || '';
    const callText = callSite.call_line || '';
    return [file, line, caller, callText].join('::');
  }

  function setCallSiteStatus(functionId, callSite, status) {
    if (!functionId || !callSite) {
      return;
    }
    const key = makeCallSiteKey(callSite);
    if (!key) {
      return;
    }
    if (!state.callSiteStatuses.has(functionId)) {
      state.callSiteStatuses.set(functionId, new Map());
    }
    state.callSiteStatuses.get(functionId).set(key, status);
  }

  function getCallSiteStatus(functionId, callSite) {
    if (!functionId || !callSite) {
      return null;
    }
    const key = makeCallSiteKey(callSite);
    if (!key) {
      return null;
    }
    const map = state.callSiteStatuses.get(functionId);
    if (!map) {
      return null;
    }
    return map.get(key) || null;
  }

  function clearPendingTraceLock(options) {
    if (pendingTraceTimer) {
      clearTimeout(pendingTraceTimer);
      pendingTraceTimer = null;
    }
    if (state.pendingTraceRequest) {
      state.pendingTraceRequest = null;
      if (options && options.render !== false) {
        render();
      }
    }
  }

  function markPendingTrace(functionId, lineNumber) {
    if (pendingTraceTimer) {
      clearTimeout(pendingTraceTimer);
    }
    state.pendingTraceRequest = { functionId, line: lineNumber };
    pendingTraceTimer = setTimeout(function() {
      console.warn('[flowPanel] Trace request auto-cleared after timeout');
      pendingTraceTimer = null;
      state.pendingTraceRequest = null;
      render();
    }, 35000);
  }
  
  // Helper function to format values for display
  function formatValue(value) {
    if (value === null || value === undefined) return 'None';
    if (typeof value === 'string') {
      // Compress repr-like values such as <_io.TextIOWrapper ...>
      const reprMatch = value.match(/^<([^>\s]+)[^>]*>$/);
      if (reprMatch) {
        const typeName = reprMatch[1].split('.').pop();
        return '[' + typeName + ']';
      }
      // Add quotes for strings
      if (value.length > 80) {
        return '"' + value.slice(0, 77) + '…"';
      }
      return '"' + value + '"';
    }
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'True' : 'False';
    try {
      const json = JSON.stringify(value);
      if (json.length > 80) {
        return json.slice(0, 77) + '…';
      }
      return json;
    } catch {
      return '[object]';
    }
  }

  function formatInlineValue(value, maxLength) {
    const limit = typeof maxLength === 'number' && maxLength > 5 ? maxLength : 60;
    const formatted = formatValue(value);
    if (formatted.length <= limit) {
      return formatted;
    }
    return formatted.slice(0, limit - 1) + '…';
  }

  function buildProjectionRows(event) {
    if (!event) {
      return [];
    }
    const rows = [];
    const seen = new Set();
    const locals = event.locals && typeof event.locals === 'object' ? event.locals : {};
    Object.entries(locals).forEach(function(entry) {
      const name = String(entry[0]);
      seen.add(name);
      rows.push({
        scope: 'Local',
        name,
        value: entry[1],
        displayValue: formatValue(entry[1]),
        type: getValueType(entry[1]),
      });
    });

    const globals = event.globals && typeof event.globals === 'object' ? event.globals : {};
    Object.entries(globals).forEach(function(entry) {
      const name = String(entry[0]);
      if (seen.has(name)) {
        return;
      }
      rows.push({
        scope: 'Global',
        name,
        value: entry[1],
        displayValue: formatValue(entry[1]),
        type: getValueType(entry[1]),
      });
    });

    rows.sort(function(a, b) {
      if (a.scope === b.scope) {
        return a.name.localeCompare(b.name);
      }
      return a.scope === 'Local' ? -1 : 1;
    });

    return rows;
  }
  
  // Helper function to get value type for styling
  function getValueType(value) {
    if (value === null || value === undefined) return 'none';
    if (typeof value === 'string') {
      const reprMatch = value.match(/^<([^>\s]+)[^>]*>$/);
      if (reprMatch) return 'object';
      return 'string';
    }
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return 'object';
    return 'unknown';
  }
  
  // Helper function to pick variables mentioned in a line
  function pickVarsForLine(lineText, locals, globals) {
    if (!lineText) {
      // If no line text, return all vars
      const result = [];
      if (locals) {
        Object.entries(locals).forEach(function(entry) {
          result.push({ key: entry[0], value: entry[1], isGlobal: false });
        });
      }
      if (globals) {
        Object.entries(globals).forEach(function(entry) {
          result.push({ key: entry[0], value: entry[1], isGlobal: true });
        });
      }
      return result.length > 0 ? result : undefined;
    }
    
    const result = [];
    const remaining = [];
    
    // Separate vars into those mentioned in the line and those not
    if (locals) {
      Object.entries(locals).forEach(function(entry) {
        if (lineText.includes(entry[0])) {
          result.push({ key: entry[0], value: entry[1], isGlobal: false });
        } else {
          remaining.push({ key: entry[0], value: entry[1], isGlobal: false });
        }
      });
    }
    
    if (globals) {
      Object.entries(globals).forEach(function(entry) {
        if (lineText.includes(entry[0])) {
          result.push({ key: entry[0], value: entry[1], isGlobal: true });
        } else {
          remaining.push({ key: entry[0], value: entry[1], isGlobal: true });
        }
      });
    }
    
    // Include all vars (mentioned first, then others)
    const allVars = result.concat(remaining);
    return allVars.length > 0 ? allVars : undefined;
  }

  function cloneArgs(args) {
    const cloned = {
      args: [],
      kwargs: {}
    };
    
    // Deep clone args array, preserving Python expressions
    if (Array.isArray(args && args.args)) {
      cloned.args = args.args.map(function(arg) {
        if (typeof arg === 'object' && arg !== null && arg.__python_expr__) {
          // Preserve Python expression format
          return { __python_expr__: true, __value__: arg.__value__ };
        }
        try {
          return JSON.parse(JSON.stringify(arg));
        } catch {
          return arg;
        }
      });
    }
    
    // Deep clone kwargs object, preserving Python expressions
    if (args && args.kwargs && typeof args.kwargs === 'object' && args.kwargs !== null) {
      for (const key in args.kwargs) {
        if (args.kwargs.hasOwnProperty(key)) {
          const val = args.kwargs[key];
          if (typeof val === 'object' && val !== null && val.__python_expr__) {
            cloned.kwargs[key] = { __python_expr__: true, __value__: val.__value__ };
          } else {
            try {
              cloned.kwargs[key] = JSON.parse(JSON.stringify(val));
            } catch {
              cloned.kwargs[key] = val;
            }
          }
        }
      }
    }
    
    return cloned;
  }

  function normalisePath(value) {
    if (typeof value !== 'string' || !value.length) {
      return '';
    }
    return value.replace(/\\/g, '/');
  }

  function filesRoughlyMatch(candidate, target) {
    if (!target) {
      return true;
    }
    if (!candidate) {
      return false;
    }
    return candidate === target || candidate.endsWith(target) || target.endsWith(candidate);
  }

  function findFunctionIdForEvent(event) {
    if (!event) {
      return null;
    }
    const eventFile = normalisePath(event.filename || '');
    const eventFunction = event.function || '';

    for (const [functionId, fn] of Object.entries(functions)) {
      const fnFile = normalisePath(fn && fn.file ? fn.file : '');
      if (!fnFile) {
        continue;
      }
      if (eventFile && !(eventFile === fnFile || eventFile.endsWith(fnFile) || fnFile.endsWith(eventFile))) {
        continue;
      }
      const displayName = extractDisplayName(functionId);
      if (!eventFunction || eventFunction === displayName) {
        return functionId;
      }
    }

    return null;
  }

  function buildArgsFromEvent(event) {
    if (!event) {
      return null;
    }
    const locals = event.locals && typeof event.locals === 'object' ? event.locals : {};
    const globals = event.globals && typeof event.globals === 'object' ? event.globals : {};
    return {
      args: [],
      kwargs: Object.assign({}, globals, locals),
    };
  }

  function getCallArgsForFunction(functionId) {
    if (!functionId) {
      return null;
    }
    const stored = state.callArgsByFunction.get(functionId);
    return stored ? cloneArgs(stored) : null;
  }

  function setCallArgsForFunction(functionId, args, options) {
    if (!functionId || !args) {
      return;
    }
    const settings = options || {};
    const shouldSync = settings.sync !== false;
    const cloned = cloneArgs(args);
    state.callArgsByFunction.set(functionId, cloned);
    if (shouldSync && typeof vscode !== 'undefined') {
      vscode.postMessage({
        type: MESSAGE_TYPES.STORE_CALL_ARGS,
        functionId,
        args: cloned,
      });
    }
  }

  function makePendingKey(functionId, line) {
    return functionId + '::' + line;
  }

  function hasValues(record) {
    if (!record) {
      return false;
    }
    const locals = record.locals && typeof record.locals === 'object' ? record.locals : null;
    const globals = record.globals && typeof record.globals === 'object' ? record.globals : null;
    const hasLocals = locals ? Object.keys(locals).length > 0 : false;
    const hasGlobals = globals ? Object.keys(globals).length > 0 : false;
    return hasLocals || hasGlobals;
  }

  function mergeTraceEvents(existing, incoming) {
    if (!existing) {
      return incoming;
    }

    const merged = Object.assign({}, existing, incoming);

    if (!incoming || !incoming.locals || Object.keys(incoming.locals || {}).length === 0) {
      if (existing.locals) {
        merged.locals = existing.locals;
      }
    }

    if (!incoming || !incoming.globals || Object.keys(incoming.globals || {}).length === 0) {
      if (existing.globals) {
        merged.globals = existing.globals;
      }
    }

    if ((!incoming || !incoming.filename) && existing.filename) {
      merged.filename = existing.filename;
    }

    if ((!incoming || !incoming.function) && existing.function) {
      merged.function = existing.function;
    }

    if ((!incoming || !incoming.event) && existing.event) {
      merged.event = existing.event;
    }

    if (!hasValues(incoming) && hasValues(existing)) {
      merged.locals = existing.locals;
      merged.globals = existing.globals;
    }

    return merged;
  }

  function buildFlowKeyFromEvent(event) {
    if (!event || typeof event !== 'object') {
      return null;
    }
    const flowName = typeof event.flow === 'string' && event.flow.length > 0
      ? event.flow
      : (typeof event.entry_full_id === 'string' ? event.entry_full_id : '');
    const argsKey = typeof event.args_key === 'string' && event.args_key.length > 0 ? event.args_key : '';
    if (!flowName && !argsKey) {
      return null;
    }
    return flowName + '::' + argsKey;
  }

  function normaliseFlowEventPayload(flowEvent) {
    if (!flowEvent || typeof flowEvent !== 'object') {
      return null;
    }
    return {
      event: 'line',
      line: typeof flowEvent.line === 'number' ? flowEvent.line : undefined,
      filename: flowEvent.file || flowEvent.filename,
      function: flowEvent.function,
      locals: flowEvent.locals,
      globals: flowEvent.globals,
      flow: flowEvent.flow,
      entry_full_id: flowEvent.entry_full_id,
      args_key: flowEvent.args_key,
      target_location: flowEvent.location,
      linear_index: flowEvent.linear_index,
    };
  }

  function upsertTracerEvent(eventData) {
    if (!eventData) {
      return;
    }
    const eventLine = typeof eventData.line === 'number' ? eventData.line : undefined;
    const eventFile = eventData.filename ? normalisePath(eventData.filename) : '';
    let mergedIntoExisting = false;

    if (eventLine !== undefined) {
      for (let i = 0; i < state.tracerEvents.length; i += 1) {
        const existing = state.tracerEvents[i];
        const existingLine = typeof existing.line === 'number' ? existing.line : undefined;
        if (existingLine !== eventLine) {
          continue;
        }

        const existingFile = existing.filename ? normalisePath(existing.filename) : '';
        const filesMatch = (!eventFile || !existingFile)
          ? true
          : (existingFile === eventFile || existingFile.endsWith(eventFile) || eventFile.endsWith(existingFile));

        if (!filesMatch) {
          continue;
        }

        const merged = mergeTraceEvents(existing, eventData);
        state.tracerEvents[i] = merged;
        mergedIntoExisting = true;
        break;
      }
    }

    if (!mergedIntoExisting) {
      state.tracerEvents.push(eventData);
    }
  }

  const flowMap = buildFlowMap(flows);
  const parents = computeParents(flows, functions, changed);
  const nameIndex = buildNameIndex(functions);
  const BACKTICK_REGEX = new RegExp(String.fromCharCode(96), 'g');
  const root = document.getElementById('flow-root');

  parents.forEach(function(parentId) {
    if (!state.callArgsByFunction.has(parentId)) {
      setCallArgsForFunction(parentId, DEFAULT_PARENT_ARGS, { sync: false });
    }
  });

  if (!root) {
    return;
  }

  render();

  // Listen for messages from extension
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === MESSAGE_TYPES.CALL_SITES_FOUND && typeof message.functionId === 'string' && Array.isArray(message.callSites)) {
      state.loadingCallSites.delete(message.functionId);
      state.callSitesByFunction.set(message.functionId, message.callSites);
      console.log('[flowPanel] Received call sites for', message.functionId, ':', message.callSites.length, 'sites');
      render();
    } else if (message.type === MESSAGE_TYPES.CALL_SITES_ERROR && typeof message.functionId === 'string') {
      state.loadingCallSites.delete(message.functionId);
      console.error('[flowPanel] Error finding call sites:', message.error);
      // Still render to show error state
      render();
    } else if (message.type === MESSAGE_TYPES.CALL_SITE_ARGS_EXTRACTED && typeof message.functionId === 'string' && message.args) {
      // Arguments extracted from call site - store them and update UI
      console.log('[flowPanel] Received extracted args for', message.functionId, ':', message.args);
      setCallArgsForFunction(message.functionId, message.args);
      if (message.callSite) {
        setCallSiteStatus(message.functionId, message.callSite, {
          state: 'success',
          message: 'Arguments captured from call site',
        });
      }
      render();
    } else if (message.type === MESSAGE_TYPES.CALL_SITE_ARGS_ERROR && typeof message.functionId === 'string') {
      console.error('[flowPanel] Error extracting args from call site:', message.error);
      if (message.callSite) {
        setCallSiteStatus(message.functionId, message.callSite, {
          state: 'error',
          message: message.error || 'Failed to extract arguments',
        });
      }
      // Show error but don't prevent rendering
      render();
    } else if (message.type === MESSAGE_TYPES.TRACER_EVENT) {
      if (message.event) {
        // Add or update event in the array
        const eventData = message.event;
        const flowKey = buildFlowKeyFromEvent(eventData);
        const hasFlowSlice = Array.isArray(eventData.events) && eventData.events.length > 0;

        if (hasFlowSlice) {
          const normalisedEvents = eventData.events
            .map(normaliseFlowEventPayload)
            .filter(Boolean);
          if (normalisedEvents.length > 0) {
            normalisedEvents.forEach(function(flowEvt) {
              upsertTracerEvent(flowEvt);
            });
            if (flowKey) {
              state.flowTimelines.set(flowKey, {
                flow: eventData.flow || eventData.entry_full_id || 'flow',
                entryFullId: eventData.entry_full_id,
                argsKey: eventData.args_key || '',
                events: normalisedEvents,
                targetLocation: eventData.target_location,
                requestedLine: eventData.requested_line,
                lastServedIndex: eventData.last_served_index,
              });
              state.activeFlowKey = flowKey;
            }
          }
        }

        upsertTracerEvent(eventData);

			clearPendingTraceLock({ render: false });

        const functionIdForEvent = findFunctionIdForEvent(eventData);
        if (functionIdForEvent) {
          const derivedArgs = buildArgsFromEvent(eventData);

          const pendingKey = makePendingKey(functionIdForEvent, eventData.line);
          const pendingTarget = state.pendingCallTargets.get(pendingKey);
          if (pendingTarget) {
            state.pendingCallTargets.delete(pendingKey);
            if (derivedArgs) {
              setCallArgsForFunction(pendingTarget, derivedArgs);
            }
          }
        }
        render();
      }
    } else if (message.type === MESSAGE_TYPES.TRACER_ERROR) {
      // Add error event
      const errorEvent = {
        event: 'error',
        error: message.error || 'Unknown error',
        traceback: message.traceback,
        line: message.line,
        filename: message.filename,
      };
      
      // Check if error already exists
      const existingIndex = state.tracerEvents.findIndex(function(e) {
        return e.event === 'error' &&
               e.line === errorEvent.line &&
               e.error === errorEvent.error &&
               e.filename === errorEvent.filename;
      });
      
      if (existingIndex < 0) {
        clearPendingTraceLock({ render: false });
        state.tracerEvents.push(errorEvent);
        render();
      }
    } else if (message.type === MESSAGE_TYPES.FUNCTION_SIGNATURE && typeof message.functionId === 'string' && Array.isArray(message.params)) {
      // Store function signature
      state.loadingSignatures.delete(message.functionId);
      state.functionSignatures.set(message.functionId, message.params);
      if (Array.isArray(message.paramTypes)) {
        state.functionParamTypes.set(message.functionId, message.paramTypes);
      }
      if (Array.isArray(message.paramDefaults)) {
        state.functionParamDefaults.set(message.functionId, message.paramDefaults);
      }
      render();
    } else if (message.type === MESSAGE_TYPES.SHOW_ARGS_FORM && typeof message.functionId === 'string') {
      // Store function signature (we use inline args section instead of modal)
      if (Array.isArray(message.params)) {
        state.functionSignatures.set(message.functionId, message.params);
        if (Array.isArray(message.paramTypes)) {
          state.functionParamTypes.set(message.functionId, message.paramTypes);
        }
        if (Array.isArray(message.paramDefaults)) {
          state.functionParamDefaults.set(message.functionId, message.paramDefaults);
        }
        render();
      }
      
      // Focus first input field
      setTimeout(function() {
        const firstInput = root.querySelector('.form-input');
        if (firstInput) {
          firstInput.focus();
        }
      }, 100);
    } else if (message.type === MESSAGE_TYPES.TRACING_PARENT && typeof message.parentId === 'string') {
      // Update loading state for parent tracing
      if (message.show) {
        state.tracingParent.add(message.parentId);
      } else {
        state.tracingParent.delete(message.parentId);
      }
      render();
    } else if (message.type === MESSAGE_TYPES.TRACING_CHILD && typeof message.childId === 'string') {
      // Update loading state for child tracing
      if (message.show) {
        state.tracingChild.add(message.childId);
      } else {
        state.tracingChild.delete(message.childId);
      }
      render();
    }
  });



  root.addEventListener('click', (event) => {
    const target = findActionTarget(event.target);
    if (!target) {
      return;
    }
    const action = target.getAttribute('data-action');
    console.log('[flowPanel] Click detected, action:', action);
    
    // Stop propagation for button clicks
    if (target.tagName === 'BUTTON') {
      event.stopPropagation();
      event.preventDefault();
    }
    
    if (action === 'toggle-parent') {
      const parent = target.getAttribute('data-parent');
      if (parent) {
        toggleParent(parent);
      }
    } else if (action === 'toggle-call-sites') {
      const parentId = target.getAttribute('data-parent-id');
      if (parentId) {
        const wasExpanded = state.expandedCallSites.has(parentId);
        if (wasExpanded) {
          state.expandedCallSites.delete(parentId);
        } else {
          state.expandedCallSites.add(parentId);
        }
        render();
      }
    } else if (action === 'toggle-args') {
      const parentId = target.getAttribute('data-parent-id');
      if (parentId) {
        const wasExpanded = state.expandedArgs.has(parentId);
        if (wasExpanded) {
          state.expandedArgs.delete(parentId);
        } else {
          state.expandedArgs.add(parentId);
        }
        render();
      }
    } else if (action === 'toggle-call') {
      const call = target.getAttribute('data-call');
      const targetId = target.getAttribute('data-target-id');
      if (call) {
        toggleCall(call, targetId);
      }
    } else if (action === 'select-call-site') {
      const parentId = target.getAttribute('data-parent-id');
      const callSiteIndex = target.getAttribute('data-call-site-index');
      if (parentId && callSiteIndex !== null) {
        const index = parseInt(callSiteIndex, 10);
        const callSites = state.callSitesByFunction.get(parentId);
        if (callSites && callSites[index]) {
          const callSite = callSites[index];
          state.selectedCallSite.set(parentId, callSite);
          render();
          
          // Extract arguments from this call site (don't execute immediately)
          vscode.postMessage({
            type: MESSAGE_TYPES.EXECUTE_FROM_CALL_SITE,
            functionId: parentId,
            callSite: callSite,
          });
        }
      }
    } else if (action === 'save-parent-args') {
      const parentId = target.getAttribute('data-parent-id');
      if (parentId) {
        // Collect all argument inputs
        const argsSection = target.closest('.parent-args-section');
        if (argsSection) {
          const argInputs = argsSection.querySelectorAll('.arg-input');
          const args = [];
          const kwargs = {};
          
          // Helper function to parse argument value (supports JSON and Python expressions)
          function parseArgumentValue(value) {
            const trimmed = value.trim();
            if (!trimmed) {
              return null;
            }
            
            // Try JSON first (for simple values)
            try {
              const parsed = JSON.parse(trimmed);
              // Check if it's a simple JSON value (not a string that looks like code)
              if (typeof parsed === 'string' && (trimmed.startsWith('get_') || trimmed.includes('()') || trimmed.includes('(') && trimmed.includes(')'))) {
                // Looks like a function call - treat as Python expression
                return {
                  __python_expr__: true,
                  __value__: trimmed
                };
              }
              return parsed;
            } catch {
              // Not valid JSON - check if it looks like Python code
              // If it contains function calls, class instantiation, etc., treat as Python expression
              if (trimmed.includes('(') || trimmed.includes('[') || trimmed.includes('.') || 
                  trimmed.match(/^[A-Z][a-zA-Z0-9_]*\(/) || trimmed.startsWith('get_') || trimmed.startsWith('create_')) {
                return {
                  __python_expr__: true,
                  __value__: trimmed
                };
              }
              // Otherwise treat as plain string (fallback)
              return trimmed;
            }
          }
          
          // Collect all args and kwargs from inputs
          // Use arrays to maintain order for positional args
          const argsByIndex = [];
          argInputs.forEach(function(input) {
            const argType = input.getAttribute('data-arg-type');
            const value = input.value.trim();
            const parsed = parseArgumentValue(value);
            
            if (parsed === null) {
              // Empty value - skip this argument
              return;
            }
            
            if (argType === 'args') {
              const index = parseInt(input.getAttribute('data-arg-index'), 10);
              argsByIndex[index] = parsed;
            } else if (argType === 'kwargs') {
              const key = input.getAttribute('data-arg-key');
              kwargs[key] = parsed;
            }
          });
          
          // Convert argsByIndex to array, skipping undefined values but maintaining order
          for (let i = 0; i < argsByIndex.length; i++) {
            if (argsByIndex[i] !== undefined) {
              args.push(argsByIndex[i]);
            }
          }
          
          // Store the updated arguments (create new object to ensure reference is updated)
          const newArgs = cloneArgs({ args: args, kwargs: kwargs });
          setCallArgsForFunction(parentId, newArgs);
          console.log('[flowPanel] Saved arguments for', parentId, ':', newArgs);
          // Force a verification read to ensure it's stored
          const verifyStored = state.callArgsByFunction.get(parentId);
          console.log('[flowPanel] Verified stored args after save:', verifyStored);
          
          // Stop/reset the tracer so a new one will be created with the new arguments
          vscode.postMessage({
            type: MESSAGE_TYPES.RESET_TRACER,
            functionId: parentId,
          });
          
          // Clear any previous execution state for this function so next click is fresh
          // Remove tracer events for this function to start fresh
          const fn = functions[parentId];
          if (fn && fn.file) {
            const fnFile = fn.file.replace(/\\/g, '/');
            state.tracerEvents = state.tracerEvents.filter(function(e) {
              // Keep events that are not for this function
              if (!e.filename) return true;
              const eFile = e.filename.replace(/\\/g, '/');
              return eFile !== fnFile && !fnFile.endsWith(eFile) && !eFile.endsWith(fnFile);
            });
          }
          
          render();
        }
      }
    } else if (action === 'execute-with-args') {
      const parentId = target.getAttribute('data-parent-id');
      console.log('[flowPanel] Execute with args clicked for parent:', parentId);
      if (parentId) {
        // Expand the parent if not already expanded to show the args section
        if (!state.expandedParents.has(parentId)) {
          state.expandedParents.add(parentId);
          // Request call sites when expanding
          if (!state.callSitesByFunction.has(parentId) && !state.loadingCallSites.has(parentId)) {
            state.loadingCallSites.add(parentId);
            console.log('[flowPanel] Requesting call sites for parent:', parentId);
            vscode.postMessage({ type: MESSAGE_TYPES.FIND_CALL_SITES, functionId: parentId });
          }
        }
        // Expand the args section
        state.expandedArgs.add(parentId);
        // Request function signature if not already loaded
        if (!state.functionSignatures.has(parentId) && !state.loadingSignatures.has(parentId)) {
          console.log('[flowPanel] Requesting function signature for parent:', parentId, state.functionSignatures);
          state.loadingSignatures.add(parentId);
          vscode.postMessage({
            type: MESSAGE_TYPES.REQUEST_FUNCTION_SIGNATURE,
            functionId: parentId,
          });
        }
        render();
      }
    } else if (action === 'insert-template') {
      const template = target.getAttribute('data-template');
      const argType = target.getAttribute('data-arg-type');
      const inputIndex = target.getAttribute('data-input-index');
      const argKey = target.getAttribute('data-arg-key');
      
      if (template) {
        // Find the corresponding input
        let input = null;
        if (argType === 'args' && inputIndex !== null) {
          input = root.querySelector('.arg-input[data-arg-type="args"][data-arg-index="' + escapeCss(inputIndex) + '"]');
        } else if (argType === 'kwargs' && argKey) {
          input = root.querySelector('.arg-input[data-arg-type="kwargs"][data-arg-key="' + escapeCss(argKey) + '"]');
        }
        
        if (input) {
          input.value = template;
          input.focus();
          // Trigger input event to update any listeners
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    } else if (action === 'show-help') {
      const helpText = target.getAttribute('data-help');
      if (helpText) {
        // Show help in a simple alert for now (could be enhanced with a tooltip)
        alert(helpText);
      }
    } else if (action === 'open-source') {
      const identifier = target.getAttribute('data-target');
      if (identifier) {
  vscode.postMessage({ type: MESSAGE_TYPES.OPEN_SOURCE, identifier });
      }
    } else if (action === 'open-projection') {
      const functionId = target.getAttribute('data-function');
      const lineValue = target.getAttribute('data-line');
      const filePath = target.getAttribute('data-file');
      const codeSnippet = target.getAttribute('data-code') || '';
      const lineNumber = lineValue ? parseInt(lineValue, 10) : NaN;
      if (functionId && Number.isFinite(lineNumber)) {
        toggleProjection(functionId, filePath, lineNumber, codeSnippet);
      }
    } else if (action === 'close-projection') {
      closeProjection();
    } else if (action === 'clear-flow-history') {
      state.flowTimelines.clear();
      state.activeFlowKey = null;
      render();
    } else if (action === 'trace-line') {
      executeTraceLineFromTarget(target);
    }
  });

  document.addEventListener('click', (event) => {
    const trigger = findActionTarget(event.target);
    if (!trigger) {
      return;
    }
    if (trigger.getAttribute('data-action') === 'scroll-parent') {
      const targetParent = trigger.getAttribute('data-target');
      if (targetParent) {
        expandParent(targetParent);
        const node = root.querySelector('[data-parent-id="' + escapeCss(targetParent) + '"]');
        if (node) {
          node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }
  });

  root.addEventListener('dblclick', (event) => {
    const codeLine = event.target.closest('.code-line');
    if (!codeLine) {
      return;
    }
    event.preventDefault();
    executeTraceLineFromTarget(codeLine);
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.projectionView) {
      closeProjection();
    }
  });

  function expandParent(parentId) {
    if (!state.expandedParents.has(parentId)) {
      state.expandedParents.add(parentId);
      render();
    }
  }

  function toggleParent(parentId) {
    if (state.expandedParents.has(parentId)) {
      state.expandedParents.delete(parentId);
    } else {
      state.expandedParents.add(parentId);
      // Request call sites when expanding a parent function
      if (!state.loadingCallSites.has(parentId)) {
        state.loadingCallSites.add(parentId);
        console.log('[flowPanel] Requesting call sites for parent:', parentId);
  vscode.postMessage({ type: MESSAGE_TYPES.FIND_CALL_SITES, functionId: parentId });
      }
    }
    render();
  }

  function toggleCall(callKey, targetFunctionId) {
    const wasExpanded = state.expandedCalls.has(callKey);
    if (wasExpanded) {
      state.expandedCalls.delete(callKey);
    } else {
      state.expandedCalls.add(callKey);
      // Use the targetFunctionId passed as parameter instead of parsing callKey
      // (callKey contains :: which conflicts with function IDs that also contain ::)
      if (targetFunctionId) {
        console.log('[flowPanel] Expanding call, targetFunctionId:', targetFunctionId);
        // Send message to extension to reveal file in explorer
        vscode.postMessage({ type: MESSAGE_TYPES.REVEAL_FUNCTION_FILE, functionId: targetFunctionId });
      }
    }
    render();
  }

  function toggleProjection(functionId, filePath, lineNumber, codeSnippet) {
    const targetLine = Number(lineNumber);
    if (!functionId || !Number.isFinite(targetLine)) {
      return;
    }

    if (
      state.projectionView &&
      state.projectionView.functionId === functionId &&
      state.projectionView.line === targetLine
    ) {
      closeProjection();
      return;
    }

    const targetFile = normalisePath(filePath || (functions[functionId]?.file || ''));
    const match = state.tracerEvents.find(function(event) {
      if (!event || event.line !== targetLine) {
        return false;
      }
      const eventFile = normalisePath(event.filename || '');
      return filesRoughlyMatch(eventFile, targetFile);
    });

    if (!match) {
      console.warn('[flowPanel] No tracer event found for projection at line', targetLine, 'in', targetFile);
      return;
    }

    state.projectionView = {
      functionId,
      file: targetFile,
      line: targetLine,
      code: codeSnippet || '',
      variables: buildProjectionRows(match),
    };
    render();
  }

  function closeProjection() {
    if (!state.projectionView) {
      return;
    }
    state.projectionView = null;
    render();
  }

  function executeTraceLineFromTarget(target) {
    if (!target) {
      return;
    }
    const functionId = target.getAttribute('data-function');
    const line = target.getAttribute('data-line');
    const stopLine = target.getAttribute('data-stop-line');
    const callTarget = target.getAttribute('data-call-target');
    const parentFunctionId = target.getAttribute('data-parent-function');
    const parentLine = target.getAttribute('data-parent-line');
    const callLine = target.getAttribute('data-call-line');

    if (!functionId || !line) {
      console.error('[flowPanel] Missing functionId or line:', { functionId, line });
      return;
    }

    const lineNumber = parseInt(line, 10);
    const stopLineCandidate = stopLine ? parseInt(stopLine, 10) : lineNumber + 1;
    const stopLineNum = Number.isFinite(stopLineCandidate) ? stopLineCandidate : lineNumber + 1;

    if (state.pendingTraceRequest) {
      const pending = state.pendingTraceRequest;
      if (pending.functionId === functionId && pending.line === lineNumber) {
        console.log('[flowPanel] Trace already in flight for function', functionId, 'line', lineNumber);
        return;
      }
      console.warn('[flowPanel] Trace request skipped because another line is still executing:', pending);
      return;
    }

    state.lastClickedLine.set(functionId, { line: lineNumber, stopLine: stopLineNum });

    const payload = {
      type: MESSAGE_TYPES.TRACE_LINE,
      functionId,
      line: lineNumber,
      stopLine: stopLineNum,
    };

    if (parentFunctionId && parentLine && callLine) {
      payload.parentFunctionId = parentFunctionId;
      payload.parentLine = parseInt(parentLine, 10);
      payload.callLine = parseInt(callLine, 10);
      payload.isNested = true;

      const parentStoredArgs = getCallArgsForFunction(parentFunctionId);
      if (!parentStoredArgs) {
        console.warn('[flowPanel] Nested function clicked but parent has no stored args:', parentFunctionId);
      } else {
        payload.parentCallArgs = parentStoredArgs;
      }
    }

    if (callTarget) {
      const pendingKey = makePendingKey(functionId, lineNumber);
      state.pendingCallTargets.set(pendingKey, callTarget);
    }

    const storedArgs = getCallArgsForFunction(functionId);
    if (storedArgs) {
      console.log('[flowPanel] Using stored args for', functionId, ':', storedArgs);
      payload.callArgs = storedArgs;
    } else if (parents.indexOf(functionId) >= 0) {
      const callSites = state.callSitesByFunction.get(functionId);
      if (!callSites || callSites.length === 0) {
        console.log('[flowPanel] No stored args and no call sites - user should use "Provide Arguments" button');
        return;
      } else {
        console.log('[flowPanel] No stored args but call sites exist - user should select a call site or use "Provide Arguments" button');
        return;
      }
    }

    console.log('[flowPanel] Sending trace-line message', payload);
    markPendingTrace(functionId, lineNumber);
    vscode.postMessage(payload);
  }

  function render() {
    let content = '';
    const timelinePanel = renderFlowTimelinePanel();
    if (timelinePanel) {
      content += timelinePanel;
    }
    if (!parents.length) {
      content += '<p class="placeholder">No call flows available.</p>';
    } else {
      content += parents.map((parentId) => renderParentBlock(parentId)).join('');
    }
    content += renderLoadingOverlay();
    content += renderProjectionPanel();
    root.innerHTML = content;

    const tracingActive = state.tracingParent.size > 0 || state.tracingChild.size > 0;
    root.classList.toggle('is-tracing', tracingActive);
  }

  function renderLoadingOverlay() {
    const isTracingParent = state.tracingParent.size > 0;
    const isTracingChild = state.tracingChild.size > 0;
    
    if (!isTracingParent && !isTracingChild) {
      return '';
    }

    let message = '';
    if (isTracingParent && isTracingChild) {
      message = 'Preparing execution context...';
    } else if (isTracingParent) {
      message = 'Tracing parent function...';
    } else if (isTracingChild) {
      message = 'Preparing to execute...';
    }

    return '<div class="loading-overlay">' +
      '<div class="loading-spinner"></div>' +
      '<div class="loading-message">' + escapeHtml(message) + '</div>' +
      '</div>';
  }

  function summariseFlowVariables(flowEvent) {
    if (!flowEvent || !flowEvent.locals || typeof flowEvent.locals !== 'object') {
      return '<span class="flow-vars-empty">No locals captured</span>';
    }
    const entries = Object.entries(flowEvent.locals);
    if (!entries.length) {
      return '<span class="flow-vars-empty">No locals captured</span>';
    }
    const previewEntries = entries.slice(0, 3);
    const previewHtml = previewEntries.map(function(entry) {
      const [name, value] = entry;
      const formatted = formatInlineValue(value, 40);
      return '<span class="flow-var-pill">' +
        '<span class="flow-var-name">' + escapeHtml(name) + '</span>' +
        '<span class="flow-var-equals">=</span>' +
        '<code class="flow-var-value">' + escapeHtml(formatted) + '</code>' +
      '</span>';
    }).join('');
    const extraCount = entries.length - previewEntries.length;
    const extraLabel = extraCount > 0
      ? '<span class="flow-var-more">+' + extraCount + ' more</span>'
      : '';
    return previewHtml + extraLabel;
  }

  function renderFlowTimelinePanel() {
    if (!state.activeFlowKey) {
      return '';
    }
    const timeline = state.flowTimelines.get(state.activeFlowKey);
    if (!timeline || !Array.isArray(timeline.events) || timeline.events.length === 0) {
      return '';
    }
    const title = timeline.flow || extractDisplayName(timeline.entryFullId || timeline.flow || 'Flow');
    const subtitle = timeline.targetLocation
      ? 'Target: ' + timeline.targetLocation
      : 'Steps: ' + timeline.events.length;

    let html = '<section class="flow-timeline-panel" role="region" aria-label="Flow timeline">';
    html += '<header class="flow-timeline-header">';
    html += '<div class="flow-timeline-meta">';
    html += '<div class="flow-timeline-title">' + escapeHtml(title) + '</div>';
    html += '<div class="flow-timeline-subtitle">' + escapeHtml(subtitle) + '</div>';
    html += '</div>';
    html += '<div class="flow-timeline-actions">';
    html += '<button type="button" class="flow-action-btn" data-action="clear-flow-history">Clear</button>';
    html += '</div>';
    html += '</header>';

    html += '<ol class="flow-timeline-list">';
    timeline.events.forEach(function(flowEvent, index) {
      const locationLabel = flowEvent.target_location || flowEvent.location || ((flowEvent.function || '?') + ':' + (flowEvent.line ?? '?'));
      const isTarget = timeline.targetLocation && locationLabel === timeline.targetLocation;
      html += '<li class="flow-timeline-row' + (isTarget ? ' is-target' : '') + '">';
      html += '<span class="flow-step-index">' + (index + 1) + '</span>';
      html += '<div class="flow-step-details">';
      html += '<div class="flow-step-head">';
      html += '<span class="flow-step-function">' + escapeHtml(flowEvent.function || 'anonymous') + '</span>';
      html += '<span class="flow-step-location">' + escapeHtml(locationLabel) + '</span>';
      html += '</div>';
      html += '<div class="flow-step-vars">' + summariseFlowVariables(flowEvent) + '</div>';
      html += '</div>';
      html += '</li>';
    });
    html += '</ol>';
    html += '</section>';
    return html;
  }

  function renderProjectionPanel() {
    const projection = state.projectionView;
    if (!projection) {
      return '';
    }

    const rows = projection.variables.length
      ? projection.variables.map(function(entry) {
          return '<div class="projection-row">' +
            '<span class="projection-cell projection-scope">' + escapeHtml(entry.scope) + '</span>' +
            '<span class="projection-cell projection-name">' + escapeHtml(entry.name) + '</span>' +
            '<code class="projection-cell projection-value tracer-var-value-' + entry.type + '">' + escapeHtml(entry.displayValue) + '</code>' +
            '</div>';
        }).join('')
      : '<div class="projection-empty">No variables captured for this line.</div>';

    return '<section class="projection-dock" role="region" aria-label="Line values">' +
      '<header class="projection-header">' +
        '<div>' +
          '<div class="projection-title">' + escapeHtml(extractDisplayName(projection.functionId)) + '</div>' +
          '<div class="projection-subtitle">Line ' + projection.line + ' · ' + escapeHtml(projection.file || '') + '</div>' +
        '</div>' +
        '<button type="button" class="projection-close" data-action="close-projection" aria-label="Close">×</button>' +
      '</header>' +
      '<pre class="projection-code"><code>' + escapeHtml(projection.code || '') + '</code></pre>' +
      '<div class="projection-grid">' + rows + '</div>' +
    '</section>';
  }


  // Helper function to get type-aware placeholder and template based on parameter name and type
  function getTypeHelper(paramName, paramType) {
    const nameLower = paramName.toLowerCase();
    
    // Common patterns based on parameter name
    if (nameLower.includes('db') || nameLower.includes('connection') || nameLower.includes('conn')) {
      return {
        placeholder: 'Python: get_db() or create_connection()',
        template: 'get_db()',
        helpText: 'Database connections are typically singletons. Use the function that provides the connection.'
      };
    }
    
    if (nameLower.includes('session')) {
      return {
        placeholder: 'Python: get_session() or Session()',
        template: 'get_session()',
        helpText: 'Session objects usually come from a factory or singleton.'
      };
    }
    
    if (nameLower.includes('cache') || nameLower.includes('redis')) {
      return {
        placeholder: 'Python: get_cache() or Cache()',
        template: 'get_cache()',
        helpText: 'Cache instances are typically shared singletons.'
      };
    }
    
    if (nameLower.includes('config') || nameLower.includes('settings')) {
      return {
        placeholder: 'Python: get_config() or Settings()',
        template: 'get_config()',
        helpText: 'Configuration is usually loaded from environment or config files.'
      };
    }
    
    if (nameLower.includes('client') || nameLower.includes('api')) {
      return {
        placeholder: 'Python: get_client() or Client()',
        template: 'get_client()',
        helpText: 'API clients are often singletons or factory-created instances.'
      };
    }
    
    // Type-based patterns
    if (paramType) {
      const typeLower = paramType.toLowerCase();
      if (typeLower.includes('dict') || typeLower.includes('mapping') || typeLower.includes('dict[')) {
        return {
          placeholder: 'JSON: {"key": "value"} or Python: dict(...)',
          template: '{}',
          helpText: 'Enter as JSON object or Python dict expression.'
        };
      }
      if (typeLower.includes('list') || typeLower.includes('array') || typeLower.includes('sequence') || typeLower.includes('list[')) {
        return {
          placeholder: 'JSON: [1, 2, 3] or Python: list(...)',
          template: '[]',
          helpText: 'Enter as JSON array or Python list expression.'
        };
      }
      if (typeLower.includes('class') || typeLower.includes('type') || !typeLower.match(/^(str|int|float|bool|none|dict|list|tuple|set|optional|union)/)) {
        return {
          placeholder: 'Python expression: ClassName() or get_instance()',
          template: '',
          helpText: 'Complex objects require Python expressions that evaluate to the expected type.'
        };
      }
    }
    
    // Default
    return {
      placeholder: 'JSON value or Python expression',
      template: '',
      helpText: 'Enter a JSON value (strings, numbers, booleans, arrays, objects) or a Python expression.'
    };
  }

  function renderParentArgsSection(parentId) {
    console.log('[flowPanel] Rendering parent args section for:', parentId);
    // Get function signature to map parameter names
    const params = state.functionSignatures.get(parentId);
    const paramTypes = state.functionParamTypes.get(parentId);
    const paramDefaults = state.functionParamDefaults.get(parentId);
    console.log('[flowPanel] Function signature for', parentId, ':', params, paramTypes, paramDefaults);

    if (!params && !state.loadingSignatures.has(parentId)) {
      console.log('[flowPanel] Requesting function signature for parent (args section):', parentId, state);
      // Request function signature
      state.loadingSignatures.add(parentId);
      vscode.postMessage({
            type: MESSAGE_TYPES.REQUEST_FUNCTION_SIGNATURE,
        functionId: parentId,
      });
    }

    const storedArgs = getCallArgsForFunction(parentId);
    const hasArgs = storedArgs && (storedArgs.args.length > 0 || Object.keys(storedArgs.kwargs || {}).length > 0);
    const isExpanded = state.expandedArgs.has(parentId);

    console.log('[flowPanel] Stored args for', parentId, ':', storedArgs, 'hasArgs:', hasArgs, 'isExpanded:', isExpanded);
    let html = '<div class="parent-args-section">';
    html += '<button type="button" class="section-toggle" data-action="toggle-args" data-parent-id="' + escapeAttribute(parentId) + '">';
    html += '<span class="chevron ' + (isExpanded ? 'open' : '') + '"></span>';
    
    if (hasArgs) {
      const argsCount = (storedArgs.args ? storedArgs.args.length : 0) + (storedArgs.kwargs ? Object.keys(storedArgs.kwargs).length : 0);
      html += '<span class="section-title">Arguments <span class="section-badge">' + argsCount + ' set</span></span>';
    } else if (params && params.length > 0) {
      html += '<span class="section-title">Arguments <span class="section-badge empty">Not set</span></span>';
    } else {
      html += '<span class="section-title">Arguments <span class="section-badge">Loading...</span></span>';
    }
    html += '</button>';
    
    if (isExpanded) {
      html += '<div class="section-content">';
      html += '<div class="parent-args-content">';
      
      // Build a map of param names to indices (excluding self/cls)
      const paramIndexMap = new Map(); // paramName -> displayIndex (for args array)
      let displayIndex = 0;
      if (params) {
        params.forEach(function(paramName, actualIndex) {
          // Skip 'self' and 'cls' parameters (they're not user-provided)
          if (paramName !== 'self' && paramName !== 'cls') {
            paramIndexMap.set(paramName, displayIndex);
            displayIndex++;
          }
        });
      }
      
      // Show inputs for positional arguments based on function signature
      if (params && params.length > 0) {
        html += '<div class="args-group">';
        html += '<div class="args-group-label">Positional Arguments:</div>';
        params.forEach(function(paramName, actualIndex) {
          // Skip 'self' and 'cls' parameters (they're not user-provided)
          if (paramName === 'self' || paramName === 'cls') {
            return;
          }
          const displayIdx = paramIndexMap.get(paramName);
          const argValue = storedArgs && storedArgs.args && storedArgs.args[displayIdx] !== undefined 
            ? storedArgs.args[displayIdx] 
            : '';
          
          // Get type info and helper
          const paramType = paramTypes && paramTypes[actualIndex] ? paramTypes[actualIndex] : null;
          const paramDefault = paramDefaults && paramDefaults[actualIndex] !== undefined ? paramDefaults[actualIndex] : null;
          const typeHelper = getTypeHelper(paramName, paramType);
          
          // Format value for display
          let valueStr = '';
          if (argValue !== '') {
            // Check if it's a Python expression (stored as object with __python_expr__)
            if (typeof argValue === 'object' && argValue !== null && argValue.__python_expr__) {
              valueStr = argValue.__value__ || '';
            } else {
              valueStr = JSON.stringify(argValue);
            }
          } else if (paramDefault !== null && paramDefault !== undefined) {
            // Show default value as placeholder hint
            valueStr = '';
          }
          
          html += '<div class="arg-item">';
          html += '<div class="arg-header">';
          html += '<label class="arg-label">' + escapeHtml(paramName);
          if (paramType) {
            html += ' <span class="arg-type">:' + escapeHtml(paramType) + '</span>';
          }
          if (paramDefault !== null && paramDefault !== undefined && !hasArgs) {
            html += ' <span class="arg-default">= ' + escapeHtml(String(paramDefault)) + '</span>';
          }
          html += '</label>';
          if (typeHelper.helpText) {
            html += '<button type="button" class="help-btn" data-action="show-help" data-help="' + escapeAttribute(typeHelper.helpText) + '" title="Show help">?</button>';
          }
          html += '</div>';
          html += '<div class="arg-input-wrapper">';
          html += '<input type="text" class="arg-input" data-arg-type="args" data-arg-index="' + displayIdx + '" data-param-type="' + escapeAttribute(paramType || '') + '" value="' + escapeAttribute(valueStr) + '" placeholder="' + escapeAttribute(typeHelper.placeholder) + '" />';
          if (typeHelper.template) {
            html += '<button type="button" class="template-btn" data-action="insert-template" data-template="' + escapeAttribute(typeHelper.template) + '" data-input-index="' + displayIdx + '" data-arg-type="args" title="Insert template">📋</button>';
          }
          html += '</div>';
          html += '</div>';
        });
        html += '</div>';
      } else if (hasArgs && storedArgs.args && storedArgs.args.length > 0) {
        // No signature yet, but we have args - show them with indices
        html += '<div class="args-group">';
        html += '<div class="args-group-label">Positional Arguments:</div>';
        storedArgs.args.forEach(function(arg, index) {
          const valueStr = JSON.stringify(arg);
          html += '<div class="arg-item">';
          html += '<label class="arg-label">[' + index + ']:</label>';
          html += '<input type="text" class="arg-input" data-arg-type="args" data-arg-index="' + index + '" value="' + escapeAttribute(valueStr) + '" />';
          html += '</div>';
        });
        html += '</div>';
      }
      
      // Show keyword arguments - include any stored ones, and also allow adding new ones
      const kwargsKeys = storedArgs && storedArgs.kwargs ? Object.keys(storedArgs.kwargs) : [];
      if (kwargsKeys.length > 0 || params) {
        html += '<div class="args-group">';
        html += '<div class="args-group-label">Keyword Arguments:</div>';
        
        // Show stored kwargs
        if (kwargsKeys.length > 0) {
          kwargsKeys.forEach(function(key) {
            const argValue = storedArgs.kwargs[key];
            // Find param index for type info
            const paramIndex = params ? params.indexOf(key) : -1;
            const paramType = paramTypes && paramIndex >= 0 ? paramTypes[paramIndex] : null;
            const typeHelper = getTypeHelper(key, paramType);
            
            // Format value for display
            let valueStr = '';
            if (typeof argValue === 'object' && argValue !== null && argValue.__python_expr__) {
              valueStr = argValue.__value__ || '';
            } else {
              valueStr = JSON.stringify(argValue);
            }
            
            html += '<div class="arg-item">';
            html += '<div class="arg-header">';
            html += '<label class="arg-label">' + escapeHtml(key);
            if (paramType) {
              html += ' <span class="arg-type">:' + escapeHtml(paramType) + '</span>';
            }
            html += '</label>';
            if (typeHelper.helpText) {
              html += '<button type="button" class="help-btn" data-action="show-help" data-help="' + escapeAttribute(typeHelper.helpText) + '" title="Show help">?</button>';
            }
            html += '</div>';
            html += '<div class="arg-input-wrapper">';
            html += '<input type="text" class="arg-input" data-arg-type="kwargs" data-arg-key="' + escapeAttribute(key) + '" data-param-type="' + escapeAttribute(paramType || '') + '" value="' + escapeAttribute(valueStr) + '" placeholder="' + escapeAttribute(typeHelper.placeholder) + '" />';
            if (typeHelper.template) {
              html += '<button type="button" class="template-btn" data-action="insert-template" data-template="' + escapeAttribute(typeHelper.template) + '" data-arg-key="' + escapeAttribute(key) + '" data-arg-type="kwargs" title="Insert template">📋</button>';
            }
            html += '</div>';
            html += '</div>';
          });
        }
        
        // Show inputs for remaining parameters that aren't already in kwargs
        if (params) {
          params.forEach(function(paramName, actualIndex) {
            // Skip if already shown as positional or already in kwargs
            if (paramName === 'self' || paramName === 'cls' || kwargsKeys.indexOf(paramName) >= 0) {
              return;
            }
            // Check if this param was already shown as positional
            if (paramIndexMap.has(paramName)) {
              return; // Already shown as positional
            }
            
            // Get type info and helper
            const paramType = paramTypes && paramTypes[actualIndex] ? paramTypes[actualIndex] : null;
            const paramDefault = paramDefaults && paramDefaults[actualIndex] !== undefined ? paramDefaults[actualIndex] : null;
            const typeHelper = getTypeHelper(paramName, paramType);
            
            // Show as optional keyword argument
            html += '<div class="arg-item">';
            html += '<div class="arg-header">';
            html += '<label class="arg-label">' + escapeHtml(paramName);
            if (paramType) {
              html += ' <span class="arg-type">:' + escapeHtml(paramType) + '</span>';
            }
            if (paramDefault !== null && paramDefault !== undefined) {
              html += ' <span class="arg-default">= ' + escapeHtml(String(paramDefault)) + '</span>';
            }
            html += '</label>';
            if (typeHelper.helpText) {
              html += '<button type="button" class="help-btn" data-action="show-help" data-help="' + escapeAttribute(typeHelper.helpText) + '" title="Show help">?</button>';
            }
            html += '</div>';
            html += '<div class="arg-input-wrapper">';
            html += '<input type="text" class="arg-input" data-arg-type="kwargs" data-arg-key="' + escapeAttribute(paramName) + '" data-param-type="' + escapeAttribute(paramType || '') + '" value="" placeholder="' + escapeAttribute(typeHelper.placeholder) + '" />';
            if (typeHelper.template) {
              html += '<button type="button" class="template-btn" data-action="insert-template" data-template="' + escapeAttribute(typeHelper.template) + '" data-arg-key="' + escapeAttribute(paramName) + '" data-arg-type="kwargs" title="Insert template">📋</button>';
            }
            html += '</div>';
            html += '</div>';
          });
        }
        
        html += '</div>';
      }
      
      if (!hasArgs && (!params || params.length === 0)) {
        html += '<div class="placeholder mini">Loading function signature...</div>';
      }
      
      html += '<button type="button" class="compact-btn save-args-btn" data-action="save-parent-args" data-parent-id="' + escapeAttribute(parentId) + '">Save Arguments</button>';
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
    
    return html;
  }

  function renderCallSitesSection(parentId) {
    const callSites = state.callSitesByFunction.get(parentId);
    const loading = state.loadingCallSites.has(parentId);
    const selected = state.selectedCallSite.get(parentId);
    const isExpanded = state.expandedCallSites.has(parentId);

    let html = '<div class="call-sites-section">';
    html += '<button type="button" class="section-toggle" data-action="toggle-call-sites" data-parent-id="' + escapeAttribute(parentId) + '">';
    html += '<span class="chevron ' + (isExpanded ? 'open' : '') + '"></span>';
    
    if (loading) {
      html += '<span class="section-title">Call Sites <span class="section-badge">Loading...</span></span>';
    } else if (!callSites || callSites.length === 0) {
      html += '<span class="section-title">Call Sites <span class="section-badge empty">None</span></span>';
    } else {
      html += '<span class="section-title">Call Sites <span class="section-badge">' + callSites.length + '</span></span>';
    }
    html += '</button>';
    
    if (isExpanded) {
      html += '<div class="section-content">';
      if (loading) {
        html += '<div class="placeholder mini">Loading call sites...</div>';
      } else if (!callSites || callSites.length === 0) {
        html += '<div class="placeholder mini">No call sites found.</div>';
      } else {
        html += '<div class="call-sites-list">';
        callSites.forEach(function(callSite, index) {
          const isSelected = selected && selected.line === callSite.line && selected.file === callSite.file;
          const callingFunctionName = callSite.calling_function || '<top-level>';
          const fileDisplay = callSite.file.split('/').pop() || callSite.file;
          const status = getCallSiteStatus(parentId, callSite);
          const statusClass = status ? (' ' + (status.state === 'success' ? 'success' : 'error')) : '';
          const statusLabel = status && status.message
            ? escapeHtml(status.message)
            : (status && status.state === 'success'
              ? 'Arguments captured'
              : '');
          
          html += '<div class="call-site-item ' + (isSelected ? 'selected' : '') + statusClass + '" data-call-site-index="' + index + '" data-action="select-call-site" data-parent-id="' + escapeAttribute(parentId) + '">';
          html += '<div class="call-site-header">';
          html += '<span class="call-site-file">' + escapeHtml(fileDisplay) + '</span>';
          html += '<span class="call-site-line">:' + callSite.line + '</span>';
          html += '<span class="call-site-function"> in ' + escapeHtml(callingFunctionName) + '()</span>';
          html += '</div>';
          html += '<div class="call-site-code">' + escapeHtml(callSite.call_line) + '</div>';
          if (statusLabel) {
            html += '<div class="call-site-status call-site-status-' + status.state + '">' + statusLabel + '</div>';
          }
          html += '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    
    return html;
  }

  function renderParentBlock(parentId) {
    const fn = functions[parentId];
    const flow = flowMap.get(parentId);
    const isExpanded = state.expandedParents.has(parentId);
    const title = extractDisplayName(parentId);
    const tooltip = escapeAttribute(parentId);
    const chips = flow && Array.isArray(flow.sequence) && flow.sequence.length
      ? '<div class="sequence-chips">' + flow.sequence
        .map((entry) => '<span class="chip" title="' + escapeAttribute(entry) + '">' + escapeHtml(extractDisplayName(entry)) + '</span>')
        .join('') + '</div>'
      : '';
    
    const callSitesSection = isExpanded ? renderCallSitesSection(parentId) : '';
    const parentArgsSection = isExpanded ? renderParentArgsSection(parentId) : '';
    
    const body = isExpanded
      ? ('<div class="config-sections">' + callSitesSection + parentArgsSection + '</div>' +
        (fn
        ? '<div class="function-container">' + renderFunctionBody(parentId, new Set([parentId]), null) + '</div>'
        : '<div class="placeholder mini">No function body captured for ' + escapeHtml(title) + '.</div>'))
      : '';

    return '<article class="parent-block" data-parent-id="' + escapeAttribute(parentId) + '">' +
      '<header class="parent-header">' +
      '<button type="button" class="parent-toggle" data-action="toggle-parent" data-parent="' + escapeAttribute(parentId) + '" title="' + tooltip + '">' +
      '<span class="chevron ' + (isExpanded ? 'open' : '') + '"></span>' +
      '<span class="parent-title">' + escapeHtml(title) + '</span>' +
      '</button>' +
      chips +
      '</header>' +
      body +
      '</article>';
  }

  function renderFunctionBody(functionId, stack, parentContext) {
    // parentContext: { parentFunctionId, parentLineNumber, callLineInParent } - tracks which parent function called this
    const fn = functions[functionId];
    if (!fn || typeof fn.body !== 'string') {
      return '<div class="placeholder mini">No function body captured.</div>';
    }

    const startLine = typeof fn.line === 'number' ? fn.line : (typeof fn.start_line === 'number' ? fn.start_line : 1);
    const lines = fn.body.split(/\r?\n/);
    let html = '<div class="code-block" data-function="' + escapeAttribute(functionId) + '"' +
      (parentContext ? ' data-parent-function="' + escapeAttribute(parentContext.parentFunctionId) + '" data-parent-line="' + parentContext.parentLineNumber + '" data-call-line="' + parentContext.callLineInParent + '"' : '') +
      '>';

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const formatted = formatLine(line, { functionId, lineIndex: index });
      const lineNumber = startLine + index;
      const codeHtml = formatted.html.length ? formatted.html : '&nbsp;';
      
      // Find events for this line
      // Only match events that EXACTLY match this line number - no tolerance
      const fnFile = fn.file || '';
      const lineEvents = state.tracerEvents ? state.tracerEvents.filter(function(e) {
        // CRITICAL: Line must match EXACTLY - no tolerance for adjacent lines
        // Check line first before doing any other checks
        if (e.line === undefined || e.line === null) {
          return false;
        }
        if (e.line !== lineNumber) {
          return false; // Not this line - reject immediately
        }
        // If filename is specified in event, it must match the function's file
        if (e.filename && fnFile) {
          const eFile = e.filename.replace(/\\/g, '/');
          const targetFile = fnFile.replace(/\\/g, '/');
          // Match if files are the same or one ends with the other (for relative paths)
          if (eFile !== targetFile && !targetFile.endsWith(eFile) && !eFile.endsWith(targetFile)) {
            return false;
          }
        }
        return true;
      }) : [];
      
      const hasError = lineEvents.some(function(e) { return e.event === 'error'; });
      const regularEvents = lineEvents.filter(function(e) { return e.event !== 'error'; });
      const errorEvents = lineEvents.filter(function(e) { return e.event === 'error'; });
      
      const isTracerLine = lineEvents.length > 0;
      const lineClass = isTracerLine ? 'code-line tracer-active' : 'code-line';
      const callTargetValue = formatted.calls.length === 1 ? formatted.calls[0].targetId : '';
      const callTargetAttr = callTargetValue ? ' data-call-target="' + escapeAttribute(callTargetValue) + '"' : '';
      
      // Add parent context attributes if this is a nested function
      const parentAttrList = parentContext
        ? [
            'data-parent-function="' + escapeAttribute(parentContext.parentFunctionId) + '"',
            'data-parent-line="' + parentContext.parentLineNumber + '"',
            'data-call-line="' + parentContext.callLineInParent + '"'
          ]
        : [];
      const parentAttrs = parentAttrList.length ? ' ' + parentAttrList.join(' ') : '';

      const wrapperAttrList = [
        'data-function="' + escapeAttribute(functionId) + '"',
        'data-line="' + lineNumber + '"'
      ];
      if (callTargetValue) {
        wrapperAttrList.push('data-call-target="' + escapeAttribute(callTargetValue) + '"');
      }
      const allLineAttrs = wrapperAttrList.concat(parentAttrList);
      const wrapperAttrs = allLineAttrs.length ? ' ' + allLineAttrs.join(' ') : '';
      
      // Inline variable display (code-like execution view)
      let inlineVarsHtml = '';
      if (regularEvents.length > 0 && !hasError) {
        const latestEvent = regularEvents[regularEvents.length - 1];
        const vars = pickVarsForLine(line, latestEvent.locals, latestEvent.globals);
        if (vars && vars.length > 0) {
          const visibleVars = vars.slice(0, INLINE_VAR_DISPLAY_LIMIT);
          inlineVarsHtml = '<div class="tracer-inline-vars">';
          visibleVars.forEach(function(v) {
            const valueStr = formatInlineValue(v.value, 56);
            const fullValue = formatValue(v.value);
            const valueType = getValueType(v.value);
            const tooltip = `${v.isGlobal ? 'global ' : ''}${v.key} = ${fullValue}`;
            inlineVarsHtml += '<div class="tracer-var-pill" title="' + escapeAttribute(tooltip) + '">' +
              (v.isGlobal ? '<span class="tracer-var-badge" title="Global value">GLOBAL</span>' : '') +
              '<span class="tracer-var-name">' + escapeHtml(v.key) + '</span>' +
              '<span class="tracer-var-equals">=</span>' +
              '<code class="tracer-var-value tracer-var-value-' + valueType + '">' + escapeHtml(valueStr) + '</code>' +
              '</div>';
          });

          if (vars.length > visibleVars.length) {
            const hiddenPreview = vars.slice(visibleVars.length)
              .map(function(v) { return `${v.key} = ${formatValue(v.value)}`; })
              .join('\n');
            inlineVarsHtml += '<span class="tracer-var-more" title="' + escapeAttribute(hiddenPreview) + '">+' + (vars.length - visibleVars.length) + ' more</span>';
          }
          inlineVarsHtml += '<button type="button" class="tracer-project-btn" data-action="open-projection" data-function="' + escapeAttribute(functionId) + '" data-file="' + escapeAttribute(fn.file || '') + '" data-line="' + lineNumber + '" data-code="' + escapeAttribute(line.trim()) + '">Projection view</button>';
          inlineVarsHtml += '</div>';
        }
      }
      
      html += '<div class="' + lineClass + '"' + wrapperAttrs + '>' +
        '<button type="button" class="line-number" data-action="trace-line" data-function="' + escapeAttribute(functionId) + '" data-line="' + lineNumber + '"' + callTargetAttr + parentAttrs + ' title="Click to execute up to this line">' + lineNumber + '</button>' +
        '<div class="code-snippet-wrapper">' +
        '<span class="code-snippet">' + codeHtml + '</span>' +
        inlineVarsHtml +
        '</div>' +
        '</div>';
      
      // Error display (below line)
      if (errorEvents.length > 0) {
        errorEvents.forEach(function(ev) {
          html += '<div class="tracer-error">';
          html += '<div class="tracer-error-message"># ERROR: ' + escapeHtml(ev.error || 'Unknown error') + '</div>';
          if (ev.traceback) {
            html += '<details class="tracer-error-details">' +
              '<summary class="tracer-error-summary"># traceback...</summary>' +
              '<pre class="tracer-error-traceback">' + escapeHtml(ev.traceback) + '</pre>' +
              '</details>';
          }
          html += '</div>';
        });
      }

      if (formatted.calls.length) {
        for (const call of formatted.calls) {
          if (!state.expandedCalls.has(call.callKey)) {
            continue;
          }
          if (!call.targetId) {
            html += '<div class="nested-block missing-body">Unable to resolve function body for ' + escapeHtml(call.displayName) + '.</div>';
            continue;
          }
          if (stack.has(call.targetId)) {
            html += '<div class="nested-block recursion-warning">↪ Recursive call to ' + escapeHtml(call.displayName) + ' skipped.</div>';
            continue;
          }
          const nextStack = new Set(stack);
          nextStack.add(call.targetId);
          // Pass parent context: which function called this, at what line in the parent, and what line in parent has the call
          const parentContext = {
            parentFunctionId: functionId,
            parentLineNumber: lineNumber, // Line in parent where the call happens
            callLineInParent: lineNumber, // Same as parentLineNumber for now
          };
          html += '<div class="nested-block">' + renderFunctionBody(call.targetId, nextStack, parentContext) + '</div>';
        }
      }
    }

    html += '</div>';
    return html;
  }

  function formatLine(line, context) {
    const tokens = tokenize(line);
    const calls = [];
    const htmlParts = [];
    let callIndex = 0;

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.type === 'identifier') {
        const prev = findPreviousSignificant(tokens, i);
        if (prev && prev.type === 'keyword' && (prev.value === 'def' || prev.value === 'class')) {
          htmlParts.push('<span class="tok tok-def-name">' + escapeHtml(token.value) + '</span>');
          continue;
        }

        const next = findNextSignificant(tokens, i);
        if (next && next.value === '(') {
          const targetId = resolveCallTarget(token.value, context.functionId);
          if (targetId) {
            const callKey = context.functionId + '::' + context.lineIndex + '::' + targetId + '::' + callIndex;
            const isOpen = state.expandedCalls.has(callKey);
            const displayName = extractDisplayName(targetId);
            const tooltip = escapeAttribute(targetId);
            calls.push({ callKey, targetId, displayName });
            htmlParts.push('<button type="button" class="call-link ' + (isOpen ? 'is-open' : '') + '" data-action="toggle-call" data-call="' + escapeAttribute(callKey) + '" data-target-id="' + escapeAttribute(targetId) + '" title="' + tooltip + '">' +
              '<span class="tok tok-call">' + escapeHtml(token.value) + '</span>' +
              '</button>');
            callIndex += 1;
            continue;
          }
        }
      }

      htmlParts.push(renderToken(token));
    }

    return {
      html: htmlParts.join(''),
      calls,
    };
  }

  function findNextSignificant(tokens, startIndex) {
    for (let i = startIndex + 1; i < tokens.length; i += 1) {
      const candidate = tokens[i];
      if (candidate.type === 'whitespace') {
        continue;
      }
      return candidate;
    }
    return null;
  }

  function findPreviousSignificant(tokens, startIndex) {
    for (let i = startIndex - 1; i >= 0; i -= 1) {
      const candidate = tokens[i];
      if (candidate.type === 'whitespace') {
        continue;
      }
      return candidate;
    }
    return null;
  }

  function tokenize(line) {
    const pattern = /("""[\s\S]*?"""|'''[\s\S]*?'''|'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|#[^\n]*|\b\d+(?:\.\d+)?\b|\b[_A-Za-z][_A-Za-z0-9]*\b|\s+|.)/g;
    const tokens = [];
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const value = match[0];
      if (/^\s+$/.test(value)) {
        tokens.push({ type: 'whitespace', value });
      } else if (value.startsWith('#')) {
        tokens.push({ type: 'comment', value });
      } else if (value.startsWith('"""') || value.startsWith("'''") || value.startsWith('"') || value.startsWith("'")) {
        tokens.push({ type: 'string', value });
      } else if (/^\d/.test(value)) {
        tokens.push({ type: 'number', value });
      } else if (/^[_A-Za-z]/.test(value)) {
        if (KEYWORDS.has(value)) {
          tokens.push({ type: 'keyword', value });
        } else if (BUILTINS.has(value)) {
          tokens.push({ type: 'builtin', value });
        } else {
          tokens.push({ type: 'identifier', value });
        }
      } else {
        tokens.push({ type: 'operator', value });
      }
    }
    return tokens;
  }

  const KEYWORDS = new Set([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
    'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
    'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
  ]);

  const BUILTINS = new Set([
    'print', 'len', 'range', 'dict', 'list', 'set', 'tuple', 'int', 'float', 'str', 'bool', 'enumerate', 'zip',
    'map', 'filter', 'sum', 'min', 'max', 'open', 'sorted', 'reversed', 'any', 'all', 'type', 'isinstance',
    'super', 'object'
  ]);

  function renderToken(token) {
    const safe = escapeHtml(token.value);
    switch (token.type) {
      case 'keyword':
        return '<span class="tok tok-kw">' + safe + '</span>';
      case 'builtin':
        return '<span class="tok tok-builtin">' + safe + '</span>';
      case 'string':
        return '<span class="tok tok-str">' + safe + '</span>';
      case 'number':
        return '<span class="tok tok-num">' + safe + '</span>';
      case 'comment':
        return '<span class="tok tok-comment">' + safe + '</span>';
      default:
        return safe;
    }
  }

  function buildFlowMap(list) {
    const map = new Map();
    for (const entry of list) {
      if (!entry || typeof entry.entrypoint !== 'string') {
        continue;
      }
      map.set(entry.entrypoint, entry);
    }
    return map;
  }

  function computeParents(list, fnBodies, changedList) {
    const ordered = [];
    const seen = new Set();

    for (const entry of list) {
      if (!entry || typeof entry.entrypoint !== 'string') {
        continue;
      }
      if (!seen.has(entry.entrypoint)) {
        ordered.push(entry.entrypoint);
        seen.add(entry.entrypoint);
      }
    }

    if (!ordered.length) {
      for (const change of changedList) {
        if (!change || typeof change.id !== 'string') {
          continue;
        }
        if (!seen.has(change.id)) {
          ordered.push(change.id);
          seen.add(change.id);
        }
      }
    }

    if (!ordered.length) {
      for (const key of Object.keys(fnBodies)) {
        if (!seen.has(key)) {
          ordered.push(key);
          seen.add(key);
        }
      }
    }

    return ordered;
  }

  function buildNameIndex(fnBodies) {
    const index = new Map();
    for (const [id, fn] of Object.entries(fnBodies)) {
      if (!fn || typeof fn !== 'object') {
        continue;
      }
      const name = extractDisplayName(id);
      if (!index.has(name)) {
        index.set(name, []);
      }
      index.get(name).push(id);
    }
    return index;
  }

  function resolveCallTarget(name, currentId) {
    const candidates = nameIndex.get(name);
    if (!candidates || !candidates.length) {
      return null;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }

    const current = functions[currentId];
    if (!current) {
      return null;
    }
    const currentPath = normalisePath(current.file);
    if (!currentPath) {
      return null;
    }

    const sameFile = candidates.filter((id) => normalisePath(functions[id]?.file) === currentPath);
    if (sameFile.length === 1) {
      return sameFile[0];
    }

    const currentDirEnd = Math.max(currentPath.lastIndexOf('/') + 1, 0);
    const currentDir = currentPath.slice(0, currentDirEnd);
    const sameDir = candidates.filter((id) => normalisePath(functions[id]?.file).startsWith(currentDir));
    if (sameDir.length === 1) {
      return sameDir[0];
    }

    return null;
  }

  function extractDisplayName(identifier) {
    if (typeof identifier !== 'string') {
      return '';
    }
    const trimmed = identifier.trim();
    if (!trimmed) {
      return '';
    }
    const withoutPrefix = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
    const parts = withoutPrefix.split('::');
    if (parts.length > 1) {
      const candidate = parts[parts.length - 1].trim();
      if (candidate.length > 0) {
        return candidate;
      }
    }
    const lastSlash = withoutPrefix.lastIndexOf('/');
    if (lastSlash >= 0 && lastSlash < withoutPrefix.length - 1) {
      return withoutPrefix.slice(lastSlash + 1);
    }
    return withoutPrefix;
  }

  function normalisePath(value) {
    if (typeof value !== 'string') {
      return '';
    }
    return value.replace(/\\+/g, '/');
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(BACKTICK_REGEX, '&#96;');
  }

  function escapeCss(value) {
    return value.replace(/"/g, '\\"').replace(/'/g, "\\'");
  }

  function findActionTarget(origin) {
    let node = origin instanceof Node ? origin : null;
    while (node && node instanceof HTMLElement) {
      if (node.hasAttribute('data-action')) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }
})();

