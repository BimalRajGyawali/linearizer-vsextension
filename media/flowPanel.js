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
  const INSPECTOR_BOUNDARY_PADDING = 32;
  const INSPECTOR_TREE_ENTRY_LIMIT = 50;
  const INSPECTOR_TREE_DEPTH_LIMIT = 6;

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
    inlinePopover: null, // { functionId, line }
    inspectorViewMode: 'compact',
    inspectorCollapsed: false,
    pinnedVariables: new Map(), // lineKey -> Map(varKey -> entry)
    lineVariableSnapshots: new Map(), // lineKey -> Array of inline vars for popover/copy actions
    inspectorPosition: null, // { top, left } when user undocks the inspector
    lastTracerLocation: null, // { line, filename, functionId } for most recent executed line
  };
  let pendingTraceTimer = null;
  let inspectorDragState = null;

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

  function clampValue(value, minimum, maximum) {
    const min = Number.isFinite(minimum) ? minimum : 0;
    const max = Number.isFinite(maximum) ? maximum : min;
    if (!Number.isFinite(value)) {
      return min;
    }
    if (max <= min) {
      return min;
    }
    return Math.min(Math.max(value, min), max);
  }

  function formatStructuredValue(value) {
    if (value === null || value === undefined) {
      return 'None';
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed === 'object') {
          return JSON.stringify(parsed, null, 2);
        }
      } catch {
        return value;
      }
      return value;
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return '[object]';
      }
    }
    return String(value);
  }

  function formatRawValue(value) {
    if (value === null || value === undefined) {
      return 'None';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return '[object]';
      }
    }
    return String(value);
  }

  function formatInspectorValue(value, mode) {
    const viewMode = mode || 'compact';
    if (viewMode === 'structured') {
      return formatStructuredValue(value);
    }
    if (viewMode === 'expanded') {
      return formatRawValue(value);
    }
    // Compact/default (slightly longer clip in relaxed modes)
    const inlineLimit = viewMode === 'compact' ? 140 : 240;
    return formatInlineValue(value, inlineLimit);
  }

  function getFoldableStructureSource(value) {
    if (value && typeof value === 'object') {
      return value;
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  function renderInspectorValueContent(value, mode) {
    if (mode === 'structured') {
      const foldable = getFoldableStructureSource(value);
      if (foldable) {
        const parsedNote = typeof value === 'string' ? 'Parsed from string' : null;
        return renderStructuredTree(foldable, 0, parsedNote);
      }
    }
    const formatted = formatInspectorValue(value, mode);
    const modeClass = 'inspector-value-mode-' + (mode || 'compact');
    return '<pre class="inspector-value ' + modeClass + ' tracer-var-value-' + getValueType(value) + '">' + escapeHtml(formatted) + '</pre>';
  }

  function renderStructuredTree(value, depth, note) {
    if (!value || typeof value !== 'object' || depth >= INSPECTOR_TREE_DEPTH_LIMIT) {
      return '<pre class="inspector-value">' + escapeHtml(formatStructuredValue(value)) + '</pre>';
    }
    const isArray = Array.isArray(value);
    const entries = isArray ? value.map(function(entry, index) { return [index, entry]; }) : Object.entries(value);
    const openAttr = depth < 2 ? ' open' : '';
    const summaryLabel = (isArray ? 'Array' : 'Object') + ' (' + entries.length + ')';
    const noteHtml = note && depth === 0 ? '<span class="inspector-tree-note">' + escapeHtml(note) + '</span>' : '';
    const rows = entries.slice(0, INSPECTOR_TREE_ENTRY_LIMIT).map(function(entry) {
      const key = String(entry[0]);
      const child = entry[1];
      const childHasStructure = child && typeof child === 'object';
      const childHtml = childHasStructure
        ? renderStructuredTree(child, depth + 1)
        : '<code class="inspector-leaf tracer-var-value-' + getValueType(child) + '">' + escapeHtml(formatInlineValue(child, 160)) + '</code>';
      return '<li class="inspector-tree-item">' +
        '<span class="inspector-tree-key">' + escapeHtml(key) + '</span>' +
        '<span class="inspector-tree-sep">:</span>' +
        '<div class="inspector-tree-value">' + childHtml + '</div>' +
      '</li>';
    }).join('');
    const overflow = entries.length > INSPECTOR_TREE_ENTRY_LIMIT
      ? '<li class="inspector-tree-more">+' + (entries.length - INSPECTOR_TREE_ENTRY_LIMIT) + ' more</li>'
      : '';
    return '<details class="inspector-tree"' + openAttr + '>' +
      '<summary><span class="inspector-tree-summary">' + escapeHtml(summaryLabel) + '</span>' + noteHtml + '</summary>' +
      '<ul class="inspector-tree-list">' + rows + overflow + '</ul>' +
    '</details>';
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

  function makeLineKey(functionId, lineNumber) {
    if (!functionId || !Number.isFinite(lineNumber)) {
      return '';
    }
    return functionId + '::' + lineNumber;
  }

  function makeVariableKey(functionId, lineNumber, scope, name) {
    const lineKey = makeLineKey(functionId, lineNumber);
    if (!lineKey || !name) {
      return '';
    }
    const scopeLabel = scope || '';
    return lineKey + '::' + scopeLabel + '::' + name;
  }

  function getPinnedLineMap(functionId, lineNumber, create) {
    const lineKey = makeLineKey(functionId, lineNumber);
    if (!lineKey) {
      return null;
    }
    if (!state.pinnedVariables.has(lineKey) && create) {
      state.pinnedVariables.set(lineKey, new Map());
    }
    return state.pinnedVariables.get(lineKey) || null;
  }

  function isVariablePinned(functionId, lineNumber, scope, name) {
    const lineMap = getPinnedLineMap(functionId, lineNumber, false);
    if (!lineMap) {
      return false;
    }
    const key = makeVariableKey(functionId, lineNumber, scope, name);
    return lineMap.has(key);
  }

  function rememberLineSnapshot(functionId, lineNumber, vars) {
    const lineKey = makeLineKey(functionId, lineNumber);
    if (!lineKey) {
      return;
    }
    if (Array.isArray(vars) && vars.length > 0) {
      state.lineVariableSnapshots.set(lineKey, vars);
    } else {
      state.lineVariableSnapshots.delete(lineKey);
    }
  }

  function findSnapshotEntry(functionId, lineNumber, name) {
    const lineKey = makeLineKey(functionId, lineNumber);
    if (!lineKey) {
      return null;
    }
    const vars = state.lineVariableSnapshots.get(lineKey);
    if (!vars) {
      return null;
    }
    const match = vars.find(function(entry) {
      return entry && entry.key === name;
    });
    if (!match) {
      return null;
    }
    return {
      scope: match.isGlobal ? 'Global' : 'Local',
      name: match.key,
      value: match.value,
      displayValue: formatValue(match.value),
      type: getValueType(match.value),
    };
  }

  function makeSafeDomId(value) {
    if (!value) {
      return 'var-peek';
    }
    return value.replace(/[^_A-Za-z0-9-]/g, '_');
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

  function updateLastTracerLocation(eventData) {
    if (!eventData || typeof eventData.line !== 'number') {
      return;
    }
    const fileName = eventData.filename || eventData.file || '';
    const functionId = findFunctionIdForEvent(eventData);
    state.lastTracerLocation = {
      line: eventData.line,
      filename: normalisePath(fileName),
      functionId: functionId || null,
    };
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
          message: message.statusMessage || 'Arguments captured from call site',
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
        const hasFlowSlice = Array.isArray(eventData.events) && eventData.events.length > 0;
        let lastEventFromSlice = null;

        if (hasFlowSlice) {
          const normalisedEvents = eventData.events
            .map(normaliseFlowEventPayload)
            .filter(Boolean);
          if (normalisedEvents.length > 0) {
            normalisedEvents.forEach(function(flowEvt) {
              upsertTracerEvent(flowEvt);
            });
            lastEventFromSlice = normalisedEvents[normalisedEvents.length - 1];
          }
        }

        upsertTracerEvent(eventData);
        updateLastTracerLocation(lastEventFromSlice || eventData);

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
        updateLastTracerLocation(errorEvent);
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
          updateCallSiteSelectionDom(parentId, index);
          
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
            state.lastTracerLocation = null;
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
    } else if (action === 'toggle-inline-vars') {
      const functionId = target.getAttribute('data-function');
      const lineValue = target.getAttribute('data-line');
      if (functionId && lineValue) {
        const lineNumber = parseInt(lineValue, 10);
        if (!Number.isFinite(lineNumber)) {
          return;
        }
        let filePath = target.getAttribute('data-file') || '';
        let codeSnippet = target.getAttribute('data-code') || '';
        const codeLineNode = typeof target.closest === 'function' ? target.closest('.code-line') : null;
        if (!filePath && codeLineNode) {
          filePath = codeLineNode.getAttribute('data-file') || '';
        }
        if (!codeSnippet && codeLineNode) {
          const snippetNode = codeLineNode.querySelector('.code-snippet');
          codeSnippet = snippetNode ? (snippetNode.textContent || '') : '';
        }
        toggleProjection(functionId, filePath, lineNumber, (codeSnippet || '').trim());
      }
    } else if (action === 'set-inspector-mode') {
      const mode = target.getAttribute('data-mode');
      if (mode && mode !== state.inspectorViewMode) {
        state.inspectorViewMode = mode;
        render();
      }
    } else if (action === 'toggle-inspector-collapse') {
      state.inspectorCollapsed = !state.inspectorCollapsed;
      render();
    } else if (action === 'copy-variable') {
      const functionId = target.getAttribute('data-function');
      const lineValue = target.getAttribute('data-line');
      const varName = target.getAttribute('data-var-name');
      const scope = target.getAttribute('data-var-scope');
      const source = target.getAttribute('data-source');
      if (functionId && lineValue && varName) {
        const lineNumber = parseInt(lineValue, 10);
        const entry = resolveVariableEntry(functionId, lineNumber, varName, scope, source);
        copyVariableEntry(entry);
      }
    } else if (action === 'pin-variable') {
      const functionId = target.getAttribute('data-function');
      const lineValue = target.getAttribute('data-line');
      const varName = target.getAttribute('data-var-name');
      const scope = target.getAttribute('data-var-scope');
      const source = target.getAttribute('data-source');
      if (functionId && lineValue && varName) {
        const lineNumber = parseInt(lineValue, 10);
        const entry = resolveVariableEntry(functionId, lineNumber, varName, scope, source);
        togglePinnedEntry(functionId, lineNumber, entry);
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
    } else if (action === 'reset-inspector-position') {
      state.inspectorPosition = null;
      render();
    } else if (action === 'trace-line') {
      executeTraceLineFromTarget(target);
    }
  });

  document.addEventListener('click', (event) => {
    const trigger = findActionTarget(event.target);
    if (trigger && trigger.getAttribute('data-action') === 'scroll-parent') {
      const targetParent = trigger.getAttribute('data-target');
      if (targetParent) {
        expandParent(targetParent);
        const node = root.querySelector('[data-parent-id="' + escapeCss(targetParent) + '"]');
        if (node) {
          node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }

    const clickTarget = event.target instanceof Element ? event.target : null;
    const insidePopover = clickTarget ? clickTarget.closest('.var-peek') : null;
    if (!insidePopover && state.inlinePopover) {
      const open = state.inlinePopover;
      state.inlinePopover = null;
      refreshInlineVarPeekFor(open.functionId, open.line);
    }
  });

  root.addEventListener('pointerdown', (event) => {
    if (!state.projectionView || event.button !== 0) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }
    const header = target.closest('.projection-header');
    if (!header) {
      return;
    }
    if (target.closest('.projection-controls')) {
      return;
    }
    beginInspectorDrag(event);
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
    if (event.key !== 'Escape') {
      return;
    }
    if (state.inlinePopover) {
      const open = state.inlinePopover;
      state.inlinePopover = null;
      refreshInlineVarPeekFor(open.functionId, open.line);
      return;
    }
    if (state.projectionView) {
      closeProjection();
    }
  });

  window.addEventListener('resize', handleInspectorViewportResize);

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

  state.inlinePopover = null;
  state.inspectorCollapsed = false;
    cancelInspectorDrag();
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
    cancelInspectorDrag();
    state.projectionView = null;
    render();
  }

  function resolveVariableEntry(functionId, lineNumber, varName, scope, source) {
    if (!functionId || !Number.isFinite(lineNumber) || !varName) {
      return null;
    }
    if (
      source === 'inspector' &&
      state.projectionView &&
      state.projectionView.functionId === functionId &&
      state.projectionView.line === lineNumber &&
      Array.isArray(state.projectionView.variables)
    ) {
      return state.projectionView.variables.find(function(entry) {
        if (!entry) {
          return false;
        }
        if (entry.name !== varName) {
          return false;
        }
        if (scope && entry.scope !== scope) {
          return false;
        }
        return true;
      }) || null;
    }
    return findSnapshotEntry(functionId, lineNumber, varName);
  }

  function togglePinnedEntry(functionId, lineNumber, variableEntry) {
    if (!variableEntry) {
      return;
    }
    const lineKey = makeLineKey(functionId, lineNumber);
    if (!lineKey) {
      return;
    }
    const map = getPinnedLineMap(functionId, lineNumber, true);
    const varKey = makeVariableKey(functionId, lineNumber, variableEntry.scope, variableEntry.name);
    if (!varKey || !map) {
      return;
    }
    if (map.has(varKey)) {
      map.delete(varKey);
      if (map.size === 0) {
        state.pinnedVariables.delete(lineKey);
      }
    } else {
      map.set(varKey, {
        scope: variableEntry.scope,
        name: variableEntry.name,
        value: variableEntry.value,
        type: variableEntry.type || getValueType(variableEntry.value),
      });
    }
    render();
  }

  function copyVariableEntry(variableEntry) {
    if (!variableEntry) {
      return;
    }
    const text = formatRawValue(variableEntry.value);
    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).catch(function(err) {
        console.warn('[flowPanel] Clipboard copy failed:', err);
      });
      return;
    }
    const temp = document.createElement('textarea');
    temp.value = text;
    temp.style.position = 'fixed';
    temp.style.opacity = '0';
    document.body.appendChild(temp);
    temp.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      console.warn('[flowPanel] execCommand copy failed:', err);
    }
    document.body.removeChild(temp);
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
    if (state.projectionView && state.inspectorPosition) {
      handleInspectorViewportResize();
    }
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

  function renderInlineVarPeek(options) {
    const functionId = options.functionId;
    const lineNumber = options.lineNumber;
    const vars = Array.isArray(options.vars) ? options.vars : [];
    const file = options.file || '';
    const inspectorActive = Boolean(
      state.projectionView &&
      state.projectionView.functionId === functionId &&
      state.projectionView.line === lineNumber
    );
    const lineKey = makeLineKey(functionId, lineNumber);
    const lineMap = getPinnedLineMap(functionId, lineNumber, false);
    const pinnedCount = lineMap ? lineMap.size : 0;
    const codeSnippet = typeof options.lineText === 'string' ? options.lineText.trim() : '';

    let html = '<div class="var-peek" data-line-key="' + escapeAttribute(lineKey) + '">';
    html += '<button type="button" class="var-peek-trigger' + (inspectorActive ? ' is-active' : '') + '" data-action="toggle-inline-vars" data-function="' + escapeAttribute(functionId) + '" data-line="' + lineNumber + '" data-file="' + escapeAttribute(file) + '" data-code="' + escapeAttribute(codeSnippet) + '" aria-label="View captured values" aria-pressed="' + (inspectorActive ? 'true' : 'false') + '">';
    html += '<span class="var-peek-dot"></span>';
    html += '</button>';
    if (pinnedCount > 0) {
      html += '<span class="var-peek-pin-count" title="Pinned values for this line">' + pinnedCount + '</span>';
    }
    html += '</div>';
    return html;
  }

  function renderInlinePopover(options) {
    const vars = Array.isArray(options.vars) ? options.vars : [];
    const displayVars = vars.slice(0, INLINE_VAR_DISPLAY_LIMIT);
    const functionId = options.functionId;
    const lineNumber = options.lineNumber;
    const moreCount = vars.length - displayVars.length;
    const file = options.file || '';
    const code = options.code || '';

    const rows = displayVars.map(function(entry) {
      const valueType = getValueType(entry.value);
      const preview = formatInlineValue(entry.value, 48);
      const scope = entry.isGlobal ? 'Global' : 'Local';
      const pinned = isVariablePinned(functionId, lineNumber, scope, entry.key);
      const varAttrs = ' data-function="' + escapeAttribute(functionId) + '" data-line="' + lineNumber + '" data-var-name="' + escapeAttribute(entry.key) + '" data-var-scope="' + scope + '"';
      return '<li class="var-popover-row">' +
        '<div class="var-popover-label">' +
          '<span class="var-popover-name">' + escapeHtml(entry.key) + '</span>' +
          (entry.isGlobal ? '<span class="var-popover-scope" title="Global">G</span>' : '') +
        '</div>' +
        '<code class="var-popover-value tracer-var-value-' + valueType + '">' + escapeHtml(preview) + '</code>' +
        '<div class="var-popover-actions">' +
          '<button type="button" class="var-popover-btn" data-action="copy-variable" data-source="popover"' + varAttrs + ' aria-label="Copy ' + escapeAttribute(entry.key) + '">Copy</button>' +
          '<button type="button" class="var-popover-btn" data-action="pin-variable" data-source="popover" data-pin-state="' + (pinned ? 'pinned' : 'unpinned') + '"' + varAttrs + '>' + (pinned ? 'Unpin' : 'Pin') + '</button>' +
        '</div>' +
      '</li>';
    }).join('');

    const moreHtml = moreCount > 0
      ? '<div class="var-popover-more">+' + moreCount + ' more captured for this line</div>'
      : '';

    return '<div class="var-popover" id="' + escapeAttribute(options.controlId) + '" role="dialog" aria-label="Line variables">' +
      '<ul class="var-popover-list">' + rows + '</ul>' +
      moreHtml +
      '<div class="var-popover-footer">' +
        '<button type="button" class="var-popover-inspect" data-action="open-projection" data-function="' + escapeAttribute(functionId) + '" data-file="' + escapeAttribute(file) + '" data-line="' + lineNumber + '" data-code="' + escapeAttribute(code.trim()) + '">Open inspector</button>' +
      '</div>' +
    '</div>';
  }

  function refreshInlineVarPeekFor(functionId, lineNumber) {
    if (!functionId || !Number.isFinite(lineNumber)) {
      return;
    }
    const selector = '.code-line[data-function="' + escapeCss(functionId) + '"][data-line="' + lineNumber + '"]';
    const lineNode = root.querySelector(selector);
    if (!lineNode) {
      return;
    }
    const existing = lineNode.querySelector('.var-peek');
    if (existing) {
      existing.remove();
    }
    const lineKey = makeLineKey(functionId, lineNumber);
    const vars = state.lineVariableSnapshots.get(lineKey);
    if (!Array.isArray(vars) || !vars.length) {
      return;
    }
    const filePath = lineNode.getAttribute('data-file') || '';
    const codeSnippet = lineNode.querySelector('.code-snippet');
    const lineText = codeSnippet ? (codeSnippet.textContent || '') : '';
    const html = renderInlineVarPeek({
      functionId,
      lineNumber,
      vars,
      file: filePath,
      lineText,
    });
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const node = temp.firstElementChild;
    if (node) {
      lineNode.insertBefore(node, lineNode.firstChild);
    }
  }

  function updateInspectorDockPositionDom() {
    const dock = root.querySelector('.projection-dock');
    if (!dock) {
      return;
    }
    const hasPosition = Boolean(
      state.inspectorPosition &&
      Number.isFinite(state.inspectorPosition.top) &&
      Number.isFinite(state.inspectorPosition.left)
    );
    if (hasPosition) {
      dock.style.top = state.inspectorPosition.top + 'px';
      dock.style.left = state.inspectorPosition.left + 'px';
      dock.style.right = 'auto';
      dock.style.bottom = 'auto';
      dock.classList.add('is-floating');
    } else {
      dock.style.top = '';
      dock.style.left = '';
      dock.style.right = '';
      dock.style.bottom = '';
      dock.classList.remove('is-floating');
    }
  }

  function beginInspectorDrag(event) {
    if (!state.projectionView) {
      return;
    }
    const dock = root.querySelector('.projection-dock');
    if (!dock) {
      return;
    }
    const rect = dock.getBoundingClientRect();
    inspectorDragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    };
    state.inspectorPosition = {
      top: rect.top,
      left: rect.left,
    };
    updateInspectorDockPositionDom();
    dock.classList.add('is-dragging');
    if (typeof dock.setPointerCapture === 'function') {
      try {
        dock.setPointerCapture(event.pointerId);
      } catch (err) {
        console.warn('[flowPanel] Failed to capture inspector pointer', err);
      }
    }
    document.body.classList.add('is-dragging-inspector');
    window.addEventListener('pointermove', handleInspectorDragMove);
    window.addEventListener('pointerup', endInspectorDrag);
    window.addEventListener('pointercancel', endInspectorDrag);
    event.preventDefault();
  }

  function handleInspectorDragMove(event) {
    if (!inspectorDragState || event.pointerId !== inspectorDragState.pointerId) {
      return;
    }
    const margin = INSPECTOR_BOUNDARY_PADDING;
    const maxLeft = Math.max(margin, window.innerWidth - inspectorDragState.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - inspectorDragState.height - margin);
    const left = clampValue(event.clientX - inspectorDragState.offsetX, margin, maxLeft);
    const top = clampValue(event.clientY - inspectorDragState.offsetY, margin, maxTop);
    state.inspectorPosition = { top, left };
    updateInspectorDockPositionDom();
  }

  function endInspectorDrag(event) {
    if (!inspectorDragState) {
      return;
    }
    if (event && event.pointerId !== inspectorDragState.pointerId) {
      return;
    }
    const dock = root.querySelector('.projection-dock');
    if (dock) {
      dock.classList.remove('is-dragging');
      if (typeof dock.releasePointerCapture === 'function') {
        try {
          dock.releasePointerCapture(inspectorDragState.pointerId);
        } catch (err) {
          // ignore
        }
      }
    }
    inspectorDragState = null;
    document.body.classList.remove('is-dragging-inspector');
    window.removeEventListener('pointermove', handleInspectorDragMove);
    window.removeEventListener('pointerup', endInspectorDrag);
    window.removeEventListener('pointercancel', endInspectorDrag);
  }

  function cancelInspectorDrag() {
    if (!inspectorDragState) {
      return;
    }
    endInspectorDrag({ pointerId: inspectorDragState.pointerId });
  }

  function handleInspectorViewportResize() {
    if (!state.inspectorPosition) {
      return;
    }
    const dock = root.querySelector('.projection-dock');
    if (!dock) {
      return;
    }
    const previousWidth = inspectorDragState && inspectorDragState.width ? inspectorDragState.width : 0;
    const previousHeight = inspectorDragState && inspectorDragState.height ? inspectorDragState.height : 0;
    const width = dock.offsetWidth || previousWidth;
    const height = dock.offsetHeight || previousHeight;
    if (!width || !height) {
      return;
    }
    const margin = INSPECTOR_BOUNDARY_PADDING;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    const left = clampValue(state.inspectorPosition.left, margin, maxLeft);
    const top = clampValue(state.inspectorPosition.top, margin, maxTop);
    if (left !== state.inspectorPosition.left || top !== state.inspectorPosition.top) {
      state.inspectorPosition = { top, left };
      updateInspectorDockPositionDom();
    }
  }

  function updateCallSiteSelectionDom(parentId, selectedIndex) {
    if (!parentId) {
      return;
    }
  const section = root.querySelector('.call-sites-section[data-call-sites-parent="' + escapeCss(parentId) + '"]');
    if (!section) {
      return;
    }
    const items = section.querySelectorAll('.call-site-item');
    items.forEach(function(item, idx) {
      if (!(item instanceof HTMLElement)) {
        return;
      }
      item.classList.toggle('selected', idx === selectedIndex);
    });
  }

  function renderProjectionPanel() {
    const projection = state.projectionView;
    if (!projection) {
      return '';
    }

    const mode = state.inspectorViewMode || 'compact';
    const collapsed = Boolean(state.inspectorCollapsed);
    const lineKey = makeLineKey(projection.functionId, projection.line);
    const pinnedValues = (() => {
      const map = lineKey ? state.pinnedVariables.get(lineKey) : null;
      return map ? Array.from(map.values()) : [];
    })();

    const rows = projection.variables.length
      ? projection.variables.map(function(entry) {
          const varAttrs = ' data-function="' + escapeAttribute(projection.functionId) + '" data-line="' + projection.line + '" data-var-name="' + escapeAttribute(entry.name) + '" data-var-scope="' + escapeAttribute(entry.scope) + '" data-source="inspector"';
          const isPinned = isVariablePinned(projection.functionId, projection.line, entry.scope, entry.name);
          const valueHtml = renderInspectorValueContent(entry.value, mode);
          return '<div class="inspector-row' + (isPinned ? ' is-pinned' : '') + '">' +
            '<div class="inspector-row-head">' +
              '<div class="inspector-row-label">' +
                '<span class="projection-scope">' + escapeHtml(entry.scope) + '</span>' +
                '<span class="projection-name">' + escapeHtml(entry.name) + '</span>' +
              '</div>' +
              '<div class="inspector-row-actions">' +
                '<button type="button" class="inspector-action-btn" data-action="pin-variable"' + varAttrs + ' aria-pressed="' + (isPinned ? 'true' : 'false') + '">' + (isPinned ? 'Unpin' : 'Pin') + '</button>' +
                '<button type="button" class="inspector-action-btn" data-action="copy-variable"' + varAttrs + ' aria-label="Copy ' + escapeAttribute(entry.name) + '">Copy</button>' +
              '</div>' +
            '</div>' +
            '<div class="inspector-row-body">' + valueHtml + '</div>' +
          '</div>';
        }).join('')
      : '<div class="projection-empty">No variables captured for this line.</div>';

    const pinnedSection = pinnedValues.length
      ? '<div class="inspector-pinned">' +
          '<div class="inspector-section-title">Pinned</div>' +
          pinnedValues.map(function(entry) {
            return '<div class="inspector-pinned-pill">' +
              '<span class="inspector-pinned-name">' + escapeHtml(entry.name) + '</span>' +
              '<span class="inspector-pinned-equals">=</span>' +
              '<code class="inspector-pinned-value">' + escapeHtml(formatInlineValue(entry.value, 60)) + '</code>' +
            '</div>';
          }).join('') +
        '</div>'
      : '';

    const viewModes = [
      { key: 'compact', label: 'Compact view', icon: '≡' },
      { key: 'expanded', label: 'Expanded view', icon: '↕' },
      { key: 'structured', label: 'Structured view', icon: '{}' },
    ];

    const viewToggles = viewModes.map(function(modeEntry) {
      const isActive = mode === modeEntry.key;
      const ariaLabel = escapeAttribute(modeEntry.label + (isActive ? ' (selected)' : ''));
      return '' +
        '<button type="button" class="inspector-view-btn' + (isActive ? ' is-active' : '') + '" data-action="set-inspector-mode" data-mode="' + modeEntry.key + '" aria-label="' + ariaLabel + '" title="' + escapeAttribute(modeEntry.label) + '">' +
          '<span class="inspector-view-icon" aria-hidden="true">' + escapeHtml(modeEntry.icon) + '</span>' +
        '</button>';
    }).join('');

    const hasFloatingPosition = Boolean(
      state.inspectorPosition &&
      Number.isFinite(state.inspectorPosition.top) &&
      Number.isFinite(state.inspectorPosition.left)
    );
    const dockClasses = ['projection-dock'];
    if (collapsed) {
      dockClasses.push('is-collapsed');
    }
    if (hasFloatingPosition) {
      dockClasses.push('is-floating');
    }
    dockClasses.push('mode-' + mode);
    const dockStyle = hasFloatingPosition
      ? ' style="top: ' + state.inspectorPosition.top + 'px; left: ' + state.inspectorPosition.left + 'px; right: auto; bottom: auto;"'
      : '';

    return '<section class="' + dockClasses.join(' ') + '" role="region" aria-label="Line inspector"' + dockStyle + '>' +
      '<header class="projection-header" title="Drag to move the inspector">' +
        '<div class="projection-info">' +
          '<div class="projection-title">' + escapeHtml(extractDisplayName(projection.functionId)) + '</div>' +
          '<div class="projection-subtitle">Line ' + projection.line + ' · ' + escapeHtml(projection.file || '') + '</div>' +
        '</div>' +
        '<div class="projection-controls">' +
          '<button type="button" class="projection-collapse" data-action="toggle-inspector-collapse" aria-expanded="' + (!collapsed) + '">' + (collapsed ? 'Expand' : 'Collapse') + '</button>' +
          '<button type="button" class="projection-reset" data-action="reset-inspector-position"' + (hasFloatingPosition ? '' : ' disabled') + '>Dock</button>' +
          '<div class="inspector-view-group" role="group" aria-label="Inspector view mode">' + viewToggles + '</div>' +
          '<button type="button" class="projection-close" data-action="close-projection" aria-label="Close">×</button>' +
        '</div>' +
      '</header>' +
      '<div class="projection-body">' +
        '<pre class="projection-code"><code>' + escapeHtml(projection.code || '') + '</code></pre>' +
        pinnedSection +
        '<div class="projection-grid">' + rows + '</div>' +
      '</div>' +
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

    const userParamCount = Array.isArray(params)
      ? params.filter(function(paramName) {
          return paramName !== 'self' && paramName !== 'cls';
        }).length
      : null;
    const requiresArgs = userParamCount === null ? true : userParamCount > 0;

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
    } else if (requiresArgs === false && Array.isArray(params)) {
      html += '<span class="section-title">Arguments <span class="section-badge success">No inputs required</span></span>';
    } else if (params && params.length > 0) {
      html += '<span class="section-title">Arguments <span class="section-badge empty">Not set</span></span>';
    } else {
      html += '<span class="section-title">Arguments <span class="section-badge">Loading...</span></span>';
    }
    html += '</button>';
    
    if (isExpanded) {
      if (requiresArgs === false && Array.isArray(params)) {
        html += '<div class="section-content no-args-required">';
        html += '<div class="placeholder mini">This function takes no arguments.</div>';
        html += '</div>';
      } else {
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
    }
    html += '</div>';
    
    return html;
  }

  function renderCallSitesSection(parentId) {
    const callSites = state.callSitesByFunction.get(parentId);
    const loading = state.loadingCallSites.has(parentId);
    const selected = state.selectedCallSite.get(parentId);
    const isExpanded = state.expandedCallSites.has(parentId);

  let html = '<div class="call-sites-section" data-call-sites-parent="' + escapeAttribute(parentId) + '">';
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
    const normalisedFnFile = normalisePath(fn.file || '');
    const lastTracerLocation = state.lastTracerLocation;
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
        if (e.filename && normalisedFnFile) {
          const eFile = e.filename.replace(/\\/g, '/');
          // Match if files are the same or one ends with the other (for relative paths)
          if (!filesRoughlyMatch(eFile, normalisedFnFile)) {
            return false;
          }
        }
        return true;
      }) : [];
      
      const hasError = lineEvents.some(function(e) { return e.event === 'error'; });
      const regularEvents = lineEvents.filter(function(e) { return e.event !== 'error'; });
      const errorEvents = lineEvents.filter(function(e) { return e.event === 'error'; });
      
  const matchesByFunction = Boolean(lastTracerLocation && lastTracerLocation.functionId && lastTracerLocation.functionId === functionId);
  const matchesByFile = Boolean(lastTracerLocation && !lastTracerLocation.functionId && lastTracerLocation.filename && normalisedFnFile && filesRoughlyMatch(lastTracerLocation.filename, normalisedFnFile));
  const isLatestTracerLine = Boolean(lastTracerLocation) && lastTracerLocation.line === lineNumber && (matchesByFunction || matchesByFile);
  const lineClass = isLatestTracerLine ? 'code-line tracer-active' : 'code-line';
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
        'data-line="' + lineNumber + '"',
        'data-file="' + escapeAttribute(fn.file || '') + '"'
      ];
      if (callTargetValue) {
        wrapperAttrList.push('data-call-target="' + escapeAttribute(callTargetValue) + '"');
      }
      const allLineAttrs = wrapperAttrList.concat(parentAttrList);
      const wrapperAttrs = allLineAttrs.length ? ' ' + allLineAttrs.join(' ') : '';
      
      // Inline variable indicator & popover
      let inlineVarsHtml = '';
      let hasInlineIndicator = false;
      if (regularEvents.length > 0 && !hasError) {
        const latestEvent = regularEvents[regularEvents.length - 1];
        const vars = pickVarsForLine(line, latestEvent.locals, latestEvent.globals);
        rememberLineSnapshot(functionId, lineNumber, vars);
        if (vars && vars.length > 0) {
          inlineVarsHtml = renderInlineVarPeek({
            functionId,
            lineNumber,
            vars,
            file: fn.file || '',
            lineText: line,
          });
          hasInlineIndicator = true;
        }
      } else {
        rememberLineSnapshot(functionId, lineNumber, null);
      }
      
      const traceDisabled = hasInlineIndicator || isLatestTracerLine;
      const lineNumberDisabled = traceDisabled ? ' disabled aria-disabled="true"' : '';
      const lineNumberTitle = traceDisabled ? 'Already executed' : 'Click to execute up to this line';

      const inlineIndicatorHtml = inlineVarsHtml || '<span class="var-peek var-peek-empty" aria-hidden="true"></span>';

      html += '<div class="' + lineClass + '"' + wrapperAttrs + '>' +
        inlineIndicatorHtml +
        '<button type="button" class="line-number" data-action="trace-line" data-function="' + escapeAttribute(functionId) + '" data-line="' + lineNumber + '"' + callTargetAttr + parentAttrs + lineNumberDisabled + ' title="' + lineNumberTitle + '">' + lineNumber + '</button>' +
        '<div class="code-snippet-wrapper">' +
        '<span class="code-snippet">' + codeHtml + '</span>' +
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

