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

  const state = {
    expandedParents: new Set(),
    expandedCalls: new Set(),
    tracerEvents: [], // Array of trace events: { event, line, filename, function, locals, globals, error, traceback }
    callArgsByFunction: new Map(), // functionId -> { args: [], kwargs: {} }
    pendingCallTargets: new Map(), // key (functionId:line) -> callee functionId
    callSitesByFunction: new Map(), // functionId -> Array of call sites
    loadingCallSites: new Set(), // Set of functionIds for which we're loading call sites
    selectedCallSite: new Map(), // functionId -> selected call site
    argsFormVisible: false, // Whether the arguments form modal is visible
    argsFormData: null, // { functionId, params: [] }
    tracingParent: new Set(), // Set of parent functionIds currently being traced
    tracingChild: new Set(), // Set of child functionIds currently being traced
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
    if (message.type === 'call-sites-found' && typeof message.functionId === 'string' && Array.isArray(message.callSites)) {
      state.loadingCallSites.delete(message.functionId);
      state.callSitesByFunction.set(message.functionId, message.callSites);
      console.log('[flowPanel] Received call sites for', message.functionId, ':', message.callSites.length, 'sites');
      render();
    } else if (message.type === 'call-sites-error' && typeof message.functionId === 'string') {
      state.loadingCallSites.delete(message.functionId);
      console.error('[flowPanel] Error finding call sites:', message.error);
      // Still render to show error state
      render();
    } else if (message.type === 'tracer-event') {
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
    } else if (message.type === 'show-args-form' && typeof message.functionId === 'string') {
      // Show the arguments form modal
      state.argsFormVisible = true;
      state.argsFormData = {
        functionId: message.functionId,
        params: Array.isArray(message.params) ? message.params : [],
        functionName: typeof message.functionName === 'string' ? message.functionName : null,
      };
      render();
      
      // Focus first input field
      setTimeout(function() {
        const firstInput = root.querySelector('.form-input');
        if (firstInput) {
          firstInput.focus();
        }
      }, 100);
    } else if (message.type === 'tracing-parent' && typeof message.parentId === 'string') {
      // Update loading state for parent tracing
      if (message.show) {
        state.tracingParent.add(message.parentId);
      } else {
        state.tracingParent.delete(message.parentId);
      }
      render();
    } else if (message.type === 'tracing-child' && typeof message.childId === 'string') {
      // Update loading state for child tracing
      if (message.show) {
        state.tracingChild.add(message.childId);
      } else {
        state.tracingChild.delete(message.childId);
      }
      render();
    }
  });

  // Handle Escape key to close modal
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape' && state.argsFormVisible) {
      state.argsFormVisible = false;
      state.argsFormData = null;
      render();
    }
  });

  // Handle form submission
  root.addEventListener('submit', (event) => {
    if (event.target instanceof HTMLFormElement && event.target.classList.contains('args-form')) {
      event.preventDefault();
      const form = event.target;
      const functionId = form.getAttribute('data-function-id');
      if (!functionId) return;
      
      const inputs = form.querySelectorAll('.form-input');
      const kwargs = {};
      
      inputs.forEach(function(input) {
        const paramName = input.getAttribute('data-param');
        const value = input.value.trim();
        
        if (value) {
          // Try to parse as JSON first (supports strings, numbers, booleans, null, arrays, objects)
          try {
            kwargs[paramName] = JSON.parse(value);
          } catch {
            // If JSON parsing fails, treat as a plain string
            kwargs[paramName] = value;
          }
        }
      });
      
      // Store arguments locally - execution will happen when user clicks a line
      setCallArgsForFunction(functionId, { args: [], kwargs: kwargs });
      
      // Also notify extension to store the args so recursive tracing can find them
      vscode.postMessage({
        type: 'store-call-args',
        functionId: functionId,
        args: { args: [], kwargs: kwargs },
      });
      
      // Hide form
      state.argsFormVisible = false;
      state.argsFormData = null;
      render();
      return;
    }
  });

  root.addEventListener('click', (event) => {
    // Prevent clicks inside the modal from closing it (except for buttons with actions)
    const modal = root.querySelector('.args-form-modal');
    if (modal && modal.contains(event.target)) {
      const clickedElement = event.target;
      // Allow clicks on buttons with data-action (like Cancel, Close buttons)
      if (clickedElement.tagName !== 'BUTTON' || !clickedElement.hasAttribute('data-action')) {
        // For non-button elements or buttons without actions, stop here to prevent closing
        return;
      }
    }
    
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
          
          // Execute from this call site
          vscode.postMessage({
            type: 'execute-from-call-site',
            functionId: parentId,
            callSite: callSite,
          });
        }
      }
    } else if (action === 'execute-with-args') {
      const parentId = target.getAttribute('data-parent-id');
      if (parentId) {
        // Request function signature first, then show form
        vscode.postMessage({
          type: 'request-args-form',
          functionId: parentId,
        });
      }
    } else if (action === 'close-args-form') {
      // Only close if clicking directly on the overlay, not on the modal content
      const clickedElement = event.target;
      const modal = root.querySelector('.args-form-modal');
      if (modal && (clickedElement === target || !modal.contains(clickedElement))) {
        state.argsFormVisible = false;
        state.argsFormData = null;
        render();
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
          
          // Always include parent's stored arguments so extension can execute parent function
          // If parent doesn't have stored args, we need to prevent execution
          const parentStoredArgs = getCallArgsForFunction(parentFunctionId);
          if (!parentStoredArgs) {
            console.warn('[flowPanel] Nested function clicked but parent has no stored args:', parentFunctionId);
            // Show message to user (can't use vscode.window in webview, so we'll let extension handle it)
            // But we should still send the message so extension can show proper error
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
          payload.callArgs = storedArgs;
        } else if (parents.indexOf(functionId) >= 0) {
          // For parent functions without stored args, don't execute automatically
          // User must either select a call site (which auto-executes) or use the "Provide Arguments" button
          const callSites = state.callSitesByFunction.get(functionId);
          if (!callSites || callSites.length === 0) {
            // No call sites - user must use the button
            // Note: We can't use vscode.window here since this is in the webview
            // Instead, we'll just return silently - the button is visible in the UI
            console.log('[flowPanel] No stored args and no call sites - user should use "Provide Arguments" button');
            return;
          } else {
            // Call sites exist - user should select one or use the button
            console.log('[flowPanel] No stored args but call sites exist - user should select a call site or use "Provide Arguments" button');
            return;
          }
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
      // Request call sites when expanding a parent function
      if (!state.loadingCallSites.has(parentId)) {
        state.loadingCallSites.add(parentId);
        console.log('[flowPanel] Requesting call sites for parent:', parentId);
        vscode.postMessage({ type: 'find-call-sites', functionId: parentId });
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
        vscode.postMessage({ type: 'reveal-function-file', functionId: targetFunctionId });
      }
    }
    render();
  }

  function render() {
    let content = '';
    if (!parents.length) {
      content = '<p class="placeholder">No call flows available.</p>';
    } else {
      content = parents.map((parentId) => renderParentBlock(parentId)).join('');
    }
    content += renderArgsFormModal();
    content += renderLoadingOverlay();
    root.innerHTML = content;
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

  function renderArgsFormModal() {
    if (!state.argsFormVisible || !state.argsFormData) {
      return '';
    }
    
    const { functionId, params, functionName } = state.argsFormData;
    const functionDisplay = functionName || extractDisplayName(functionId);
    
    let formFields = '';
    if (params && params.length > 0) {
      params.forEach(function(paramName, index) {
        formFields += `
          <div class="form-field">
            <label for="param-${index}" class="form-label">${escapeHtml(paramName)}</label>
            <input 
              type="text" 
              id="param-${index}" 
              class="form-input" 
              data-param="${escapeAttribute(paramName)}"
              placeholder="Enter value (JSON: strings use quotes, numbers/booleans without quotes)"
              autocomplete="off"
            />
          </div>
        `;
      });
    } else {
      formFields = '<div class="form-field"><p class="form-info">This function has no parameters.</p></div>';
    }
    
    return `
      <div class="args-form-overlay" data-action="close-args-form">
        <div class="args-form-modal">
          <div class="args-form-header">
            <h3 class="args-form-title">Function Arguments</h3>
            <button type="button" class="args-form-close" data-action="close-args-form" aria-label="Close">&times;</button>
          </div>
          <div class="args-form-body">
            <div class="args-form-info">
              <div class="args-form-function-name">
                <span class="info-label">Function:</span>
                <span class="info-value">${escapeHtml(functionDisplay)}</span>
              </div>
            </div>
            <form class="args-form" data-function-id="${escapeAttribute(functionId)}">
              ${formFields}
              <div class="form-help-text">
                <span class="help-icon">💡</span>
                <span>After saving, click any line number in the function to execute it with these arguments.</span>
              </div>
              <div class="form-actions">
                <button type="button" class="form-btn form-btn-secondary" data-action="close-args-form">Cancel</button>
                <button type="submit" class="form-btn form-btn-primary">Done</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;
  }

  function renderCallSitesSection(parentId) {
    const callSites = state.callSitesByFunction.get(parentId);
    const loading = state.loadingCallSites.has(parentId);
    const selected = state.selectedCallSite.get(parentId);

    if (loading) {
      return '<div class="call-sites-section"><div class="placeholder mini">Loading call sites...</div></div>';
    }

    if (!callSites || callSites.length === 0) {
      return '<div class="call-sites-section">' +
        '<div class="placeholder mini">No call sites found. Provide arguments to execute this function.</div>' +
        '<button type="button" class="execute-with-args-btn" data-action="execute-with-args" data-parent-id="' + escapeAttribute(parentId) + '">Provide Arguments</button>' +
        '</div>';
    }

    let html = '<div class="call-sites-section">';
    html += '<div class="call-sites-header">Call Sites (' + callSites.length + '):</div>';
    html += '<button type="button" class="execute-with-args-btn" data-action="execute-with-args" data-parent-id="' + escapeAttribute(parentId) + '" title="Click to provide function arguments manually">Provide Arguments Manually</button>';
    html += '<div class="call-sites-list">';
    
    callSites.forEach(function(callSite, index) {
      const isSelected = selected && selected.line === callSite.line && selected.file === callSite.file;
      const callingFunctionName = callSite.calling_function || '&lt;top-level&gt;';
      const fileDisplay = callSite.file.split('/').pop() || callSite.file;
      const callSiteKey = parentId + '::' + callSite.file + '::' + callSite.line;
      
      html += '<div class="call-site-item ' + (isSelected ? 'selected' : '') + '" data-call-site-index="' + index + '" data-action="select-call-site" data-parent-id="' + escapeAttribute(parentId) + '">';
      html += '<div class="call-site-header">';
      html += '<span class="call-site-file">' + escapeHtml(fileDisplay) + '</span>';
      html += '<span class="call-site-line">:' + callSite.line + '</span>';
      html += '<span class="call-site-function"> in ' + escapeHtml(callingFunctionName) + '()</span>';
      html += '</div>';
      html += '<div class="call-site-code">' + escapeHtml(callSite.call_line) + '</div>';
      html += '</div>';
    });
    
    html += '</div>';
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
    
    const body = isExpanded
      ? (callSitesSection + (fn
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

