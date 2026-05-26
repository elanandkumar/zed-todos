#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// LSP transport (stdio, no npm deps)
// ---------------------------------------------------------------------------

let inputBuffer = '';
let contentLength = -1;

process.stdin.on('data', (chunk) => {
  inputBuffer += chunk.toString('binary');
  processMessages();
});

function processMessages() {
  while (true) {
    if (contentLength < 0) {
      const idx = inputBuffer.indexOf('\r\n\r\n');
      if (idx < 0) break;
      const header = inputBuffer.slice(0, idx);
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) break;
      contentLength = parseInt(m[1], 10);
      inputBuffer = inputBuffer.slice(idx + 4);
    }
    if (inputBuffer.length < contentLength) break;
    const raw = inputBuffer.slice(0, contentLength);
    inputBuffer = inputBuffer.slice(contentLength);
    contentLength = -1;
    try {
      handleMessage(JSON.parse(Buffer.from(raw, 'binary').toString('utf8')));
    } catch (_) {}
  }
}

function send(obj) {
  const json = JSON.stringify(obj);
  const len  = Buffer.byteLength(json, 'utf8');
  process.stdout.write(`Content-Length: ${len}\r\n\r\n${json}`);
}

function reply(id, result)       { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, msg) { send({ jsonrpc: '2.0', id, error: { code, message: msg } }); }

let _reqId = 0;
function request(method, params) { send({ jsonrpc: '2.0', id: `s${++_reqId}`, method, params }); }

// ---------------------------------------------------------------------------
// Document store
// ---------------------------------------------------------------------------

const docs = new Map(); // uri → string

function getLines(uri) {
  return (docs.get(uri) || '').split('\n');
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const CAPABILITIES = {
  textDocumentSync: { openClose: true, change: 1 /* full */ },

  codeActionProvider: {
    codeActionKinds: ['quickfix'],
    resolveProvider: false,
  },

  documentOnTypeFormattingProvider: {
    firstTriggerCharacter: '\n',
  },

  inlayHintProvider: { resolveProvider: false },

  semanticTokensProvider: {
    full: true,
    legend: {
      // 0 function → pending  [ ]     yellow  (#dcdcaa VSCode Dark Modern)
      // 1 type     → done     [x]/[-] teal    (#4ec9b0)
      // 2 comment  → comment lines    grey    (#6a9955)
      // 3 string   → in-progress [/]  orange  (#ce9178)
      // 4 decorator→ @tags            accent
      // 5 keyword  → section headers  blue    (#569cd6)
      tokenTypes: ['function', 'type', 'comment', 'string', 'decorator', 'keyword'],
      tokenModifiers: [],
    },
  },
};

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

function handleMessage(msg) {
  const { method, id, params } = msg;
  if (!method) return; // response to one of our server→client requests — ignore

  switch (method) {
    case 'initialize': {
      const opts = (params.initializationOptions || {}).markers || {};
      if (opts.pending)     MARKERS.pending     = opts.pending;
      if (opts.done)        MARKERS.done        = opts.done;
      if (opts.in_progress) MARKERS.in_progress = opts.in_progress;
      if (opts.cancelled)   MARKERS.cancelled   = opts.cancelled;
      buildRegexes();
      reply(id, { capabilities: CAPABILITIES, serverInfo: { name: 'todo-ls', version: '0.1.0' } });
      break;
    }

    case 'initialized':
      break;

    case 'shutdown':
      reply(id, null);
      break;

    case 'exit':
      process.exit(0);
      break;

    case 'textDocument/didOpen':
      docs.set(params.textDocument.uri, params.textDocument.text);
      break;

    case 'textDocument/didChange':
      if (params.contentChanges.length > 0)
        docs.set(params.textDocument.uri, params.contentChanges[0].text);
      request('workspace/inlayHint/refresh', null);
      break;

    case 'textDocument/didClose':
      docs.delete(params.textDocument.uri);
      break;

    case 'textDocument/onTypeFormatting':
      reply(id, handleOnTypeFormatting(params));
      break;

    case 'textDocument/codeAction':
      reply(id, handleCodeAction(params));
      break;

    case 'textDocument/inlayHint':
      reply(id, handleInlayHints(params));
      break;

    case 'textDocument/semanticTokens/full':
      reply(id, { data: computeTokens(docs.get(params.textDocument.uri) || '') });
      break;

    default:
      if (id !== undefined) replyErr(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Config  (overridable via initializationOptions in settings.json)
// ---------------------------------------------------------------------------

// Full marker strings — not just the inner char.
// Defaults use [ ] bracket style; override to e.g. "☐" / "✔" / "◑" / "✗"
const MARKERS = {
  pending:     '[ ]',
  done:        '[x]',
  in_progress: '[/]',
  cancelled:   '[-]',
};

// Shared regexes — rebuilt after config is applied
const HEADER_RE  = /^(\s*)([^\[\n]+):(\s*)$/;
const COMMENT_RE = /^(\s*)(\/\/.*)$/;
const ATAG_RE    = /@\w+(?:\([^)]*\))?/g;

let ANY_TASK_RE;

function buildRegexes() {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Longest match first to avoid partial matches
  const alts = [MARKERS.pending, MARKERS.done, MARKERS.in_progress, MARKERS.cancelled]
    .map(esc)
    .sort((a, b) => b.length - a.length)
    .join('|');
  ANY_TASK_RE = new RegExp(`^(\\s*)(${alts})(.*)`);
}

buildRegexes();

// ---------------------------------------------------------------------------
// On-type formatting  (Enter on task line → auto-insert next task)
// ---------------------------------------------------------------------------

function handleOnTypeFormatting({ textDocument, position, ch }) {
  if (ch !== '\n') return null;

  const lines = getLines(textDocument.uri);
  const prevLineNo = position.line - 1;
  if (prevLineNo < 0) return null;

  const prevLine = lines[prevLineNo] || '';
  const m = ANY_TASK_RE.exec(prevLine);
  if (!m) return null;

  const [, indent, marker, rest] = m;

  // Only continue pending and in-progress tasks; done/cancelled stop the chain
  if (marker !== MARKERS.pending && marker !== MARKERS.in_progress) return null;

  // Break-out gesture: empty task line → remove its marker and stop
  if (rest.trim() === '') {
    return [{
      range: {
        start: { line: prevLineNo, character: 0 },
        end:   { line: prevLineNo, character: prevLine.length },
      },
      newText: indent,
    }];
  }

  // Insert new pending task on the newly created line
  const curLine = lines[position.line] || '';
  return [{
    range: {
      start: { line: position.line, character: 0 },
      end:   { line: position.line, character: curLine.length },
    },
    newText: `${indent}${MARKERS.pending} `,
  }];
}

// ---------------------------------------------------------------------------
// Code actions
// ---------------------------------------------------------------------------

function handleCodeAction({ textDocument, range }) {
  const uri    = textDocument.uri;
  const lines  = getLines(uri);
  const lineNo = range.start.line;
  const line   = lines[lineNo] || '';

  const m = ANY_TASK_RE.exec(line);
  if (!m) {
    // Empty or non-task line — offer to insert a task here
    const indent = line.match(/^(\s*)/)[1];
    return [{
      title: 'New Task Here',
      kind: 'quickfix',
      edit: {
        changes: {
          [uri]: [{
            range: {
              start: { line: lineNo, character: 0 },
              end:   { line: lineNo, character: line.length },
            },
            newText: `${indent}${MARKERS.pending} `,
          }],
        },
      },
    }];
  }

  const [, indent, marker, rest] = m;
  const actions = [];

  function makeAction(title, newMarker) {
    return {
      title,
      kind: 'quickfix',
      edit: {
        changes: {
          [uri]: [{
            range: {
              start: { line: lineNo, character: 0 },
              end:   { line: lineNo, character: line.length },
            },
            newText: `${indent}${newMarker}${rest}`,
          }],
        },
      },
    };
  }

  if (marker !== MARKERS.done)        actions.push(makeAction('Mark Done',        MARKERS.done));
  if (marker !== MARKERS.in_progress) actions.push(makeAction('Mark In Progress', MARKERS.in_progress));
  if (marker !== MARKERS.pending)     actions.push(makeAction('Mark Pending',     MARKERS.pending));
  if (marker !== MARKERS.cancelled)   actions.push(makeAction('Mark Cancelled',   MARKERS.cancelled));

  actions.push({
    title: 'New Task Below',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [{
          range: {
            start: { line: lineNo, character: line.length },
            end:   { line: lineNo, character: line.length },
          },
          newText: `\n${indent}${MARKERS.pending} `,
        }],
      },
    },
  });

  actions.push({
    title: 'New Task Above',
    kind: 'quickfix',
    edit: {
      changes: {
        [uri]: [{
          range: {
            start: { line: lineNo, character: 0 },
            end:   { line: lineNo, character: 0 },
          },
          newText: `${indent}${MARKERS.pending} \n`,
        }],
      },
    },
  });

  return actions;
}

// ---------------------------------------------------------------------------
// Inlay hints  (task count per section header)
// ---------------------------------------------------------------------------

function handleInlayHints({ textDocument }) {
  const lines = getLines(textDocument.uri);

  // Collect section header positions
  const sections = [];
  lines.forEach((line, li) => {
    if (HEADER_RE.test(line)) {
      sections.push({ lineNo: li, lineLen: line.trimEnd().length, count: 0 });
    }
  });

  if (sections.length === 0) return [];

  // Count tasks per section (tasks belong to last header above them)
  lines.forEach((line, li) => {
    if (!ANY_TASK_RE.test(line)) return;
    for (let i = sections.length - 1; i >= 0; i--) {
      if (sections[i].lineNo < li) {
        sections[i].count++;
        break;
      }
    }
  });

  return sections
    .filter(s => s.count > 0)
    .map(({ lineNo, lineLen, count }) => ({
      position: { line: lineNo, character: lineLen },
      label: ` (${count})`,
      kind: 1, // Type
      paddingLeft: false,
    }));
}

// ---------------------------------------------------------------------------
// Semantic tokens  (syntax highlighting)
// ---------------------------------------------------------------------------

// tokenTypes legend indices:
const TK_PENDING    = 0;  // [ ]  pending           → yellow  (function)
const TK_DONE       = 1;  // [x]  done              → teal    (type)
const TK_COMMENT    = 2;  // // comment lines        → grey    (comment)
const TK_INPROGRESS = 3;  // [/]  in-progress        → orange  (string)
const TK_DECORATOR  = 4;  // @tags                   → accent  (decorator)
const TK_HEADER     = 5;  // section headers          → blue   (keyword)
const TK_CANCELLED  = 2;  // [-]  cancelled          → grey    (comment) — reuses comment slot

function computeTokens(text) {
  const lines = text.split('\n');
  const data  = [];
  let prevLine = 0;
  let prevChar = 0;

  function push(line, char, len, type, mods) {
    if (len <= 0) return;
    data.push(
      line - prevLine,
      line === prevLine ? char - prevChar : char,
      len,
      type,
      mods,
    );
    prevLine = line;
    prevChar = char;
  }

  lines.forEach((line, li) => {
    // Section header:  "Todo:"
    let m = HEADER_RE.exec(line);
    if (m) {
      push(li, m[1].length, m[2].length + 1, TK_HEADER, 0);
      return;
    }

    // Comment line:  // note
    m = COMMENT_RE.exec(line);
    if (m) {
      push(li, m[1].length, m[2].length, TK_COMMENT, 0);
      return;
    }

    // Task line
    m = ANY_TASK_RE.exec(line);
    if (m) {
      const indent     = m[1].length;
      const marker     = m[2];
      // Use Buffer.byteLength for multi-byte Unicode markers (e.g. ☐ = 3 bytes)
      // but LSP positions are in UTF-16 code units
      const markerLen  = [...marker].reduce((n, c) => n + (c.codePointAt(0) > 0xFFFF ? 2 : 1), 0);
      const markerEnd  = indent + markerLen;
      const bodyRaw    = m[3];

      let markerType;
      if (marker === MARKERS.done)            markerType = TK_DONE;
      else if (marker === MARKERS.cancelled)  markerType = TK_CANCELLED;
      else if (marker === MARKERS.in_progress) markerType = TK_INPROGRESS;
      else markerType = TK_PENDING;

      push(li, indent, markerLen, markerType, 0);

      if (bodyRaw.length > 0) {
        ATAG_RE.lastIndex = 0;
        let lastIdx = 0;
        let tagMatch;
        while ((tagMatch = ATAG_RE.exec(bodyRaw)) !== null) {
          const before = tagMatch.index - lastIdx;
          if (before > 0)
            push(li, markerEnd + lastIdx, before, markerType, 0);
          push(li, markerEnd + tagMatch.index, tagMatch[0].length, TK_DECORATOR, 0);
          lastIdx = tagMatch.index + tagMatch[0].length;
        }
        const trailing = bodyRaw.length - lastIdx;
        if (trailing > 0)
          push(li, markerEnd + lastIdx, trailing, markerType, 0);
      }
    }
  });

  return data;
}
