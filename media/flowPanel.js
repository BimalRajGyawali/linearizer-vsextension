(function () {
  const vscode = acquireVsCodeApi();
  const data = window.__INITIAL_DATA__ || {};
  const functions = data.functionBodies || {};
  const flows = Array.isArray(data.flows) ? data.flows : [];
  const changed = Array.isArray(data.changedFunctions) ? data.changedFunctions : [];

  const DEFAULT_PARENT_ARGS = {
    args: [],
    kwargs: { metric_name: 'test', period: 'last_7_days' },
  };

  const state = {
    expandedParents: new Set(),
    expandedCalls: new Set(),
    tracerEvents: [], // Array of trace events: { event, line, filename, function, locals, globals, error, traceback }
    callArgsByFunction: new Map(), // functionId -> { args: [], kwargs: {} }
    pendingCallTargets: new Map(), // key (functionId:line) -> callee functionId
  };
  
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
    return {
      args: Array.isArray(args && args.args) ? [].concat(args.args) : [],
      kwargs: args && args.kwargs && typeof args.kwargs === 'object' && args.kwargs !== null
        ? Object.assign({}, args.kwargs)
        : {},
    };
  }

  function normalisePath(value) {
    if (typeof value !== 'string' || !value.length) {
      return '';
    }
    return value.replace(/\\/g, '/');
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

  function setCallArgsForFunction(functionId, args) {
    if (!functionId || !args) {
      return;
    }
    state.callArgsByFunction.set(functionId, cloneArgs(args));
  }

  function makePendingKey(functionId, line) {
    return functionId + '::' + line;
  }

  const flowMap = buildFlowMap(flows);
  const parents = computeParents(flows, functions, changed);
  const nameIndex = buildNameIndex(functions);
  const BACKTICK_REGEX = new RegExp(String.fromCharCode(96), 'g');
  const root = document.getElementById('flow-root');

  parents.forEach(function(parentId) {
    if (!state.callArgsByFunction.has(parentId)) {
      state.callArgsByFunction.set(parentId, cloneArgs(DEFAULT_PARENT_ARGS));
    }
  });

  if (!root) {
    return;
  }

  render();

  // Listen for messages from extension
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'tracer-event') {
      if (message.event) {
        // Add or update event in the array
        const eventData = message.event;
        
        // Remove only events for the EXACT same line and file to prevent duplicates
        // Keep events for other lines so previously clicked lines remain visible
        if (state.tracerEvents && eventData.filename && eventData.line !== undefined) {
          const eventFile = eventData.filename.replace(/\\/g, '/');
          const eventLine = eventData.line;
          console.log('[flowPanel] Received event - line:', eventLine, 'file:', eventFile);
          state.tracerEvents = state.tracerEvents.filter(function(e) {
            if (!e.filename || e.line === undefined) return true; // Keep events without filename or line
            const eFile = e.filename.replace(/\\/g, '/');
            // Only remove events for the same file AND EXACT same line
            // This allows multiple lines to have events simultaneously
            if (eFile === eventFile || eventFile.endsWith(eFile) || eFile.endsWith(eventFile)) {
              // Remove only if it's the EXACT same line (not adjacent)
              if (e.line === eventLine) {
                console.log('[flowPanel] Removing event at line:', e.line, 'for file:', eFile, '(exact match with', eventLine, ')');
                return false;
              }
            }
            return true; // Keep events for other lines or other files
          });
        }
        
        // Check if event already exists for this exact line and file
        const eventKey = `${eventData.line}:${eventData.filename || ''}`;
        const duplicateExists = state.tracerEvents.some(function(e) {
          const eKey = `${e.line}:${e.filename || ''}`;
          return eKey === eventKey;
        });
        
        if (!duplicateExists) {
          // Add the new event
          console.log('[flowPanel] Adding event at line:', eventData.line, 'for file:', eventData.filename);
          state.tracerEvents.push(eventData);
        } else {
          // Update existing event instead of adding duplicate
          const existingIndex = state.tracerEvents.findIndex(function(e) {
            const eKey = `${e.line}:${e.filename || ''}`;
            return eKey === eventKey;
          });
          if (existingIndex >= 0) {
            state.tracerEvents[existingIndex] = eventData;
            console.log('[flowPanel] Updated existing event at line:', eventData.line);
          }
        }

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
    } else if (message.type === 'tracer-error') {
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
        state.tracerEvents.push(errorEvent);
        render();
      }
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
    } else if (action === 'toggle-call') {
      const call = target.getAttribute('data-call');
      if (call) {
        toggleCall(call);
      }
    } else if (action === 'open-source') {
      const identifier = target.getAttribute('data-target');
      if (identifier) {
        vscode.postMessage({ type: 'open-source', identifier });
      }
    } else if (action === 'trace-line') {
      const functionId = target.getAttribute('data-function');
      const line = target.getAttribute('data-line');
      const callTarget = target.getAttribute('data-call-target');
      const parentFunctionId = target.getAttribute('data-parent-function');
      const parentLine = target.getAttribute('data-parent-line');
      const callLine = target.getAttribute('data-call-line');
      
      console.log('[flowPanel] Trace-line clicked, functionId:', functionId, 'line:', line, 'parent:', parentFunctionId, 'parentLine:', parentLine);
      if (functionId && line) {
        const lineNumber = parseInt(line, 10);
        
        // Don't clear events when clicking - allow multiple lines to show values simultaneously
        // The event handler will manage duplicates for the same line
        
        const payload = { 
          type: 'trace-line', 
          functionId, 
          line: lineNumber, 
          stopLine: lineNumber + 1 
        };

        // If this is a nested function, include parent context
        if (parentFunctionId && parentLine && callLine) {
          payload.parentFunctionId = parentFunctionId;
          payload.parentLine = parseInt(parentLine, 10);
          payload.callLine = parseInt(callLine, 10);
          payload.isNested = true;
        }

        if (callTarget) {
          const pendingKey = makePendingKey(functionId, lineNumber);
          state.pendingCallTargets.set(pendingKey, callTarget);
        }

        const storedArgs = getCallArgsForFunction(functionId);
        if (storedArgs) {
          payload.callArgs = storedArgs;
        } else if (parents.indexOf(functionId) >= 0) {
          payload.callArgs = cloneArgs(DEFAULT_PARENT_ARGS);
        }

        console.log('[flowPanel] Sending trace-line message', payload);
        vscode.postMessage(payload);
      } else {
        console.error('[flowPanel] Missing functionId or line:', { functionId, line });
      }
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
    }
    render();
  }

  function toggleCall(callKey) {
    if (state.expandedCalls.has(callKey)) {
      state.expandedCalls.delete(callKey);
    } else {
      state.expandedCalls.add(callKey);
    }
    render();
  }

  function render() {
    if (!parents.length) {
      root.innerHTML = '<p class="placeholder">No call flows available.</p>';
      return;
    }
    root.innerHTML = parents.map((parentId) => renderParentBlock(parentId)).join('');
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
    const body = isExpanded
      ? fn
        ? '<div class="function-container">' + renderFunctionBody(parentId, new Set([parentId]), null) + '</div>'
        : '<div class="placeholder mini">No function body captured for ' + escapeHtml(title) + '.</div>'
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
      const callTargetAttr = formatted.calls.length === 1 ? ' data-call-target="' + escapeAttribute(formatted.calls[0].targetId) + '"' : '';
      
      // Add parent context attributes if this is a nested function
      const parentAttrs = parentContext 
        ? ' data-parent-function="' + escapeAttribute(parentContext.parentFunctionId) + '" data-parent-line="' + parentContext.parentLineNumber + '" data-call-line="' + parentContext.callLineInParent + '"'
        : '';
      
      // Inline variable display (code-like execution view)
      let inlineVarsHtml = '';
      if (regularEvents.length > 0 && !hasError) {
        const latestEvent = regularEvents[regularEvents.length - 1];
        const vars = pickVarsForLine(line, latestEvent.locals, latestEvent.globals);
        if (vars && vars.length > 0) {
          inlineVarsHtml = '<div class="tracer-inline-vars">';
          vars.forEach(function(v, idx) {
            const valueStr = formatValue(v.value);
            const valueType = getValueType(v.value);
            inlineVarsHtml += '<span class="tracer-var-item">' +
              (v.isGlobal ? '<span class="tracer-var-global">global </span>' : '') +
              '<span class="tracer-var-name">' + escapeHtml(v.key) + '</span>' +
              '<span class="tracer-var-equals"> = </span>' +
              '<span class="tracer-var-value tracer-var-value-' + valueType + '">' + escapeHtml(valueStr) + '</span>' +
              (idx < vars.length - 1 ? '<span class="tracer-var-separator"> </span>' : '') +
              '</span>';
          });
          inlineVarsHtml += '</div>';
        }
      }
      
      html += '<div class="' + lineClass + '">' +
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
            htmlParts.push('<button type="button" class="call-link ' + (isOpen ? 'is-open' : '') + '" data-action="toggle-call" data-call="' + escapeAttribute(callKey) + '" title="' + tooltip + '">' +
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

