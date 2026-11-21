/**
 * aios-mcp-gateway (ARCHITECTURE.md 7.6).
 *
 * The MCP server that aios **always** passes to the CLI (constraint 7). The user's own MCP servers (user / project
 * registrations, plugin-bundled ones, connectors) are read by the CLI itself, as with the stock CLI (item 110 dropped
 * `--strict-mcp-config`, ARCHITECTURE 4.6.4). It holds no state and only forwards tool calls to main over a Unix
 * domain socket. Search, approval and plugin execution all happen on the main side (constraints 7 / 8).
 *
 * How it starts: **the CLI** launches it from the config main wrote into `--mcp-config`.
 * The runtime is the Electron binary used as Node with `ELECTRON_RUN_AS_NODE=1` (spike 10).
 * So aios cannot warm it up in advance, and startup + handshake take about 1.35 seconds.
 * **It is spawned on the first send, not when the thread is opened.**
 *
 * Design promises:
 * - **No timeout is implemented.** An approval goes through even after 600 seconds (spike 2). The backend's own
 *   timeouts (TODO 632, 7.6.5) are handled by telling main when a call is cancelled (`approve-wait.ts`).
 * - If main is down / disconnected, **return deny without dragging the CLI down**.
 *   The UI shows this deny distinctly from a refusal by the user (4.2).
 * - It does not reconnect after main restarts. The session is treated as ended.
 *
 * Note: this file knows the shape of the permission prompt response (`behavior` / `updatedInput`).
 * Apart from the Adapter it is the only place that knows a backend-specific format, and that is deliberately
 * confined here (12.5). To add a backend with a different contract, write another gateway.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { connect, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  DEFAULT_DOCUMENT_BYTES,
  DEFAULT_TEXT_BYTES,
  MAX_TEXT_BYTES,
  respond,
  respondOrError
} from './respond.js'
import { LineReader } from '../common/line-reader.js'
import { keepAlive, watchCancellation } from './approve-wait.js'
import { getOpenUrlTextShape, openDiffShape, openFileShape, openUrlShape, WEB_PAGE_TEXT_NOTICE } from './viewer-schemas.js'
import { parsePluginToolList, registerPluginTools, toolUseIdOf } from './plugin-tools.js'
import { PendingCalls } from './pending-calls.js'
import { screenshotResponse } from './screenshot-response.js'

const SOCKET = process.env['AIOS_SOCKET'] ?? ''
const TOKEN = process.env['AIOS_TOKEN'] ?? ''
const SESSION = process.env['AIOS_SESSION'] ?? ''

let socket: Socket | null = null
const pending = new PendingCalls()

function failAll(message: string): void {
  pending.failAll(message)
  socket = null
}

function link(): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = connect(SOCKET)
    s.on('connect', () => {
      socket = s
      resolve()
    })
    s.on('error', (err) => {
      failAll(`aios main not reachable: ${err.message}`)
      reject(err)
    })
    s.on('close', () => failAll('aios main disconnected'))
    // One per connection. A chunk boundary that lands in the middle of a UTF-8 character does not garble it (TODO 565).
    const reader = new LineReader()
    s.on('data', (chunk: Buffer) => {
      for (const line of reader.push(chunk)) {
        let message: { id?: number; result?: unknown; error?: string } | null
        try {
          message = JSON.parse(line) as typeof message
        } catch {
          continue
        }
        if (message === null || typeof message !== 'object' || typeof message.id !== 'number') continue
        pending.settle(message.id, message.error, message.result)
      }
    })
  })
}

/** Calls main. `timeoutMs` is only for calls with a bounded wait (not for approvals etc., see the promise above). */
function callMain(payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  const s = socket
  if (s === null) return Promise.reject(new Error('aios main not connected'))
  return pending.start((id) => {
    s.write(`${JSON.stringify({ id, token: TOKEN, payload })}\n`)
  }, timeoutMs)
}

interface Decision {
  behavior: 'allow' | 'deny'
  message?: string
  updatedInput?: unknown
}

function toDecision(value: unknown, originalInput: unknown): Decision {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >
  if (record['allowed'] === true) {
    // With allow, `updatedInput` is **not accepted if omitted** (spike 2).
    // If main did not rewrite it, echo the original input unchanged.
    // For a multiple-choice question (T31) the arguments carrying the answer arrive here: the backend reads
    // `updatedInput.answers` and runs the tool as if the user had answered.
    const updated = record['updatedInput']
    if (updated !== undefined && updated !== null) {
      return { behavior: 'allow', updatedInput: updated }
    }
    return { behavior: 'allow', updatedInput: originalInput ?? {} }
  }
  const message = typeof record['message'] === 'string' ? record['message'] : 'denied by aios'
  return { behavior: 'deny', message }
}

const server = new McpServer({ name: 'aios', version: '0.1.0' })

server.registerTool(
  'approve',
  {
    title: 'aios approval inbox',
    description: 'Routes a permission request to the aios approval inbox and waits for the user.',
    inputSchema: {
      tool_name: z.string(),
      input: z.unknown().optional(),
      tool_use_id: z.string().optional(),
      permission_suggestions: z.unknown().optional()
    }
  },
  async (args, extra) => {
    // Marker for this call (TODO 632). On a cancellation notice main uses it to find the request in the inbox.
    const callId = randomUUID()
    const toolUseId = args.tool_use_id ?? null
    // When the backend gives up waiting (`notifications/cancelled` from the hard timeout), tell main so it removes
    // the request from the inbox and the on-screen dialog (7.6.5). The answer can no longer arrive, so drop the return value here.
    const stopWatching = watchCancellation(extra, () => {
      callMain({ kind: 'approveCancelled', sessionId: SESSION, callId, toolUseId }).catch(() => {})
    })
    // While waiting, send progress every 60 seconds so the CLI's idle timeout (default 30 minutes) does not cut us off
    // (7.6.5, spike 29). Does nothing without a `progressToken`.
    const stopProgress = keepAlive(extra)
    let decision: Decision
    try {
      const result = await callMain({
        kind: 'approve',
        sessionId: SESSION,
        toolName: args.tool_name,
        toolUseId,
        callId,
        input: args.input ?? {}
      })
      decision = toDecision(result, args.input)
    } catch (err) {
      // main is down. **Return deny without dragging the CLI down** (7.6).
      // Use wording that shows the cause is on the main side - the UI distinguishes it from a user refusal (4.2).
      decision = { behavior: 'deny', message: `aios unavailable: ${(err as Error).message}` }
    } finally {
      stopProgress()
      stopWatching()
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(decision) }] }
  }
)

/** Forwards to main; if main is down, returns the error message (without dragging the CLI down). */
async function forward(kind: string, payload: Record<string, unknown>): Promise<unknown> {
  try {
    return await callMain({ kind, sessionId: SESSION, ...payload })
  } catch (err) {
    return { error: `aios unavailable: ${(err as Error).message}` }
  }
}

// ---- Search tools (7.6.1). Narrow with search, then fetch only the documents needed ----

server.registerTool(
  'search',
  {
    title: 'aios unified search',
    description:
      'Search the local index of this computer: file contents, and past conversations. ' +
      'Returns only the top ranked summaries (id, uri, title, snippet). ' +
      'Start here, then call getDocument on the few results you actually need. ' +
      'IMPORTANT: without source, only files are searched. To look for something the user said or did in a past conversation, ' +
      'you MUST pass source: "conversation" (or "transcript"); do not conclude that no such conversation exists from a search without source. ' +
      'Smart case: a word containing an uppercase letter matches case exactly; all-lowercase words ignore case. ' +
      'For a file:// result you intend to edit, prefer the standard Read tool for the full text. ' +
      'To find files by their name or path rather than by what they contain, use searchFiles. ' +
      'When you mention a past conversation found here, ALWAYS make its name the text of a Markdown link, ' +
      'so one press on the name opens it: [<conversation name>](<thread_uri>) when you mean the conversation itself ' +
      '(thread_uri is returned with every conversation hit; thread_title only when the conversation has a name: ' +
      'without it, make a short phrase that says what the conversation is about the link text, never an empty link text), ' +
      'or [<text>](<uri>) with the hit\'s uri ' +
      '(thread://<threadId>/<eventId>) when you mean that particular message. Copy the thread:// value exactly as returned; ' +
      'do not put the link on a separate line and do not leave the name as plain text.',
    inputSchema: {
      query: z.string(),
      // TODO 1225: the three built-in sources, or an extension's source (such as `aios.gmail`). Which sources exist is decided by main (only the shape is checked here).
      source: z
        .string()
        .regex(/^[a-z][a-z0-9._:/-]{0,127}$/)
        .optional()
        .describe(
          'Omitted: files only. Use "conversation" to search past conversations (required for them). Limit to one source: "fs" (files), "conversation", "transcript", or an Extension source such as "aios.gmail" (that Extension\'s documents only)'
        ),
      limit: z.number().int().min(1).max(50).optional()
    }
  },
  async (args) =>
    respond(
      await forward('search', {
        query: args.query,
        source: args.source ?? '',
        limit: args.limit ?? 20
      })
    )
)

// TODO 1158: expose file-name search (the same matching as Cmd+P) to the conversation's CLI. Returns no body text.
server.registerTool(
  'searchFiles',
  {
    title: 'aios file name search',
    description:
      'Find files and folders on this computer by name or path (like the quick open of an editor), using the aios index. ' +
      'Use this when you know (part of) a file name or folder; to search by what a file contains, use search instead. ' +
      'Every word must appear in the file name or in its folder path (substring, not fuzzy); a word containing / is matched against the path. ' +
      'Filters: *.md or ext:md for the extension, name:report for the name only. ' +
      'Smart case: a word containing an uppercase letter matches case exactly; all-lowercase words ignore case. ' +
      'Matches inside the working folder of this conversation come first (in_working_folder), then the rest (hits). ' +
      'Each hit has path (pass it to Read, or to openFile to show it to the user) and, for files, id (pass it to getDocument). File contents are not returned.',
    inputSchema: {
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(50).optional()
    }
  },
  async (args) => respondOrError(await forward('searchFiles', { query: args.query, limit: args.limit ?? 20 }))
)

// TODO 1235: a document is named by rowid (`id`), or by its exact uri, or by (source, source_id). main resolves it
// to one rowid in the index process and then runs the same checks as for an id.
const DOCUMENT_LOOKUP_SCHEMA = {
  uri: z.string().min(1).max(2000).optional(),
  source: z.string().regex(/^[a-z][a-z0-9._:/-]{0,127}$/).optional(),
  source_id: z.string().min(1).max(2000).optional()
}

function documentLookup(args: { id?: string; uri?: string; source?: string; source_id?: string }): Record<string, unknown> {
  return {
    ...(args.id !== undefined ? { id: args.id } : {}),
    ...(args.uri !== undefined ? { uri: args.uri } : {}),
    ...(args.source !== undefined ? { source: args.source } : {}),
    ...(args.source_id !== undefined ? { source_id: args.source_id } : {})
  }
}

server.registerTool(
  'getDocument',
  {
    title: 'aios document',
    description:
      'Fetch one document found by search: metadata plus the beginning of its text. ' +
      'Positions are UTF-8 byte offsets into the document. If has_more is true, continue with ' +
      'getDocumentText using offset = next_offset (null means the whole text was returned). ' +
      'For file:// documents you can also use the standard Read tool. ' +
      'Pass the id of a search hit, or (for non-file documents such as an Extension\'s) its exact uri, ' +
      'or source together with source_id; the lookup is an exact match and fails when nothing or several documents match.',
    inputSchema: {
      id: z.string().optional(),
      ...DOCUMENT_LOOKUP_SCHEMA,
      limit: z.number().int().min(256).max(MAX_TEXT_BYTES).optional()
    }
  },
  async (args) =>
    respond(
      await forward('getDocument', { ...documentLookup(args), limit: args.limit ?? DEFAULT_DOCUMENT_BYTES })
    )
)

server.registerTool(
  'getDocumentText',
  {
    title: 'aios document text',
    description:
      'Fetch a range of a document found by search, starting at the UTF-8 byte offset `offset`. ' +
      'The range is aligned to whole characters. To read on, call again with offset = next_offset ' +
      'from the response (always use next_offset, even when truncated: true); ' +
      'next_offset is null at the end of the document. ' +
      'The document is named by id, or by its exact uri, or by source together with source_id (as for getDocument).',
    inputSchema: {
      id: z.string().optional(),
      ...DOCUMENT_LOOKUP_SCHEMA,
      offset: z.number().int().min(0).optional(),
      length: z.number().int().min(256).max(MAX_TEXT_BYTES).optional()
    }
  },
  async (args) =>
    respond(
      await forward('getDocumentText', {
        ...documentLookup(args),
        offset: args.offset ?? 0,
        length: args.length ?? DEFAULT_TEXT_BYTES
      })
    )
)

server.registerTool(
  'getChunk',
  {
    title: 'aios chunk',
    description: 'Fetch the matched chunk of a document with one chunk of context on each side.',
    inputSchema: { id: z.string() }
  },
  async (args) => respond(await forward('getChunk', { id: args.id }))
)

// ---- ViewerPane tools (7.6.2, item 97). Open / close / list. Approval goes through the same path as other mcp__* tools ----
// (default auto-allow does not stop; in a strict-mode thread it goes to approval). Path checks and window
// selection are all on the main side (SessionManager.handleViewerRequest); this side only forwards.

server.registerTool(
  'openFile',
  {
    title: 'aios open file',
    description:
      "Show a file to the user in the viewer pane of this conversation's window. " +
      'Accepts an absolute path, a file:// URI, or a path relative to the working directory. ' +
      'Use highlight to mark search terms in it, and line (1-based) to scroll to and mark that line. ' +
      'For a PDF, page (1-based) scrolls to that page; it is ignored when line is given. ' +
      'Directories are rejected. ' +
      'If no window is showing this conversation, the file is shown when the user opens it.',
    inputSchema: openFileShape
  },
  async (args) =>
    respond(
      await forward('openFile', {
        path: args.path,
        ...(args.highlight === undefined ? {} : { highlight: args.highlight }),
        ...(args.line === undefined ? {} : { line: args.line }),
        ...(args.page === undefined ? {} : { page: args.page })
      })
    )
)

// TODO 822: open an http(s) URL in a ViewerPane web view (tab). No approval needed (default auto-allow, 167).
// "Use this instead of an external browser or `open`" is encouraged both in the description and in the extra instructions the Adapter passes to the CLI.
server.registerTool(
  'openUrl',
  {
    title: 'aios open web page',
    description:
      "Show a web page (http or https URL) to the user in the viewer pane of this conversation's window, as a tab of the built-in browser. " +
      'Use this whenever the user asks you to open or show a web page or web app (for example Gmail, a draft you just created, a document, a pull request), ' +
      'instead of opening an external browser or running the open command. ' +
      'The user is already signed in to sites they used there before. Other URL schemes are rejected. ' +
      'To read the page (for example to review a pull request on a site the user is signed in to), call getOpenUrlText after opening it.',
    inputSchema: openUrlShape
  },
  // TODO 1043: in a conversation with a secret marker it waits in the approval inbox, so, as with `getOpenUrlText`, send the cancellation notice and progress (review 57-3).
  async (args, extra) => {
    const callId = randomUUID()
    const stopWatching = watchCancellation(extra, () => {
      callMain({ kind: 'approveCancelled', sessionId: SESSION, callId, toolUseId: null }).catch(() => {})
    })
    const stopProgress = keepAlive(extra)
    try {
      return respond(await forward('openUrl', { url: args.url, callId }))
    } finally {
      stopProgress()
      stopWatching()
    }
  }
)

// TODO 1052: read the body (text only) of a web tab the user opened. URLs that are not open are not read (main refuses). Consent is asked
// in the approval inbox only the first time, so, as with `approve`, send the cancellation notice and progress. A fixed notice (not an instruction) is put at the head of the body.
server.registerTool(
  'getOpenUrlText',
  {
    title: 'aios read web page',
    description:
      "Read the text of a web page open in a tab of the built-in browser in this conversation's window (opened by the user or with openUrl). " +
      "Because it reads the rendered tab, it works for pages the user is signed in to (for example a pull request) and for pages drawn by JavaScript. " +
      'Choose the tab by url (a page open in a tab) or tabId (from listOpenFiles, webTabs); with neither, the tab the user sees in the viewer pane now is read. ' +
      'Pages that are not open in a tab are not fetched: open them with openUrl first. Returns url, title and text only. ' +
      'Positions are UTF-8 byte offsets; if truncated is true, call again with offset = next_offset. ' +
      'The first use asks the user once for permission.',
    inputSchema: getOpenUrlTextShape
  },
  async (args, extra) => {
    const callId = randomUUID()
    const stopWatching = watchCancellation(extra, () => {
      callMain({ kind: 'approveCancelled', sessionId: SESSION, callId, toolUseId: null }).catch(() => {})
    })
    const stopProgress = keepAlive(extra)
    try {
      const result = await forward('getOpenUrlText', {
        ...(args.tabId === undefined ? {} : { tabId: args.tabId }),
        ...(args.url === undefined ? {} : { url: args.url }),
        offset: args.offset ?? 0,
        length: args.length ?? DEFAULT_TEXT_BYTES,
        callId
      })
      const withNotice =
        typeof result === 'object' && result !== null && typeof (result as Record<string, unknown>)['text'] === 'string'
          ? { notice: WEB_PAGE_TEXT_NOTICE, ...(result as Record<string, unknown>) }
          : result
      return respond(withNotice)
    } finally {
      stopProgress()
      stopWatching()
    }
  }
)

// TODO 1061 (1): return an image of what the ViewerPane of this conversation's window is currently showing in front (web tab, file viewer, diff).
// A web tab asks for consent in the approval inbox only the first time (the same consent as 1052), so send the cancellation notice and progress.
server.registerTool(
  'getViewerScreenshot',
  {
    title: 'aios viewer screenshot',
    description:
      "Take a screenshot of what the viewer pane (the right side) of this conversation's window shows the user right now: " +
      'the web page in the visible built-in browser tab, the file viewer (for example a PDF, an image, a document or code) or a diff. ' +
      'Use it to see layout, images, charts or anything the text alone does not show; for the text of a web page, getOpenUrlText is cheaper. ' +
      'Returns an image (PNG or JPEG, at most 1568 px on the long side) and a JSON part telling what was captured (kind, url, title or path). ' +
      'Call listOpenFiles to see what is in view (inView). Taking a screenshot of a web page asks the user once for permission, like getOpenUrlText.',
    inputSchema: {}
  },
  async (_args, extra) => {
    const callId = randomUUID()
    const stopWatching = watchCancellation(extra, () => {
      callMain({ kind: 'approveCancelled', sessionId: SESSION, callId, toolUseId: null }).catch(() => {})
    })
    const stopProgress = keepAlive(extra)
    try {
      return screenshotResponse(await forward('getViewerScreenshot', { callId }))
    } finally {
      stopProgress()
      stopWatching()
    }
  }
)

// TODO 826: open a diff side by side in the ViewerPane's aios.diff. main reads the contents and passes them straight to the window (the plugin reads nothing).
server.registerTool(
  'openDiff',
  {
    title: 'aios open diff',
    description:
      "Show a side-by-side diff to the user in the viewer pane of this conversation's window. " +
      'Use this whenever the user asks you to show or display a diff or the changes of a file, instead of printing a unified diff. ' +
      'path is the changed file (right side): an absolute path, a file:// URI, or a path relative to the working directory. ' +
      'The left side is either base (another file) or rev (a git revision such as HEAD, HEAD~1 or a branch name; the default is HEAD, i.e. the uncommitted changes). ' +
      'Give base or rev, not both. Shows one file pair per call; the user can switch to a single-column view.',
    inputSchema: openDiffShape
  },
  async (args) =>
    respond(
      await forward('openDiff', {
        path: args.path,
        ...(args.base === undefined ? {} : { base: args.base }),
        ...(args.rev === undefined ? {} : { rev: args.rev })
      })
    )
)

server.registerTool(
  'closeFile',
  {
    title: 'aios close file',
    description:
      "Close the file shown in the viewer pane of this conversation. With path, close it only " +
      'if that file is the one open. Unsaved edits by the user are never discarded.',
    inputSchema: { path: z.string().optional() }
  },
  async (args) =>
    respond(await forward('closeFile', args.path === undefined ? {} : { path: args.path }))
)

server.registerTool(
  'listOpenFiles',
  {
    title: 'aios open files',
    description:
      'List the files open in the viewer panes: the one for this conversation (thread: current) ' +
      'and those shown in other windows (thread: other). visible tells whether a window shows the conversation now; ' +
      'shown tells whether the viewer pane has that file in front right now. ' +
      "webTabs lists the web pages open in the built-in browser tabs of this conversation's window (tabId, url, title, active, shown); read one with getOpenUrlText. " +
      "inView tells, for each window showing this conversation, what its viewer pane (the right side) has in front now: " +
      'kind web (tabId, url, title), file (path, and for a PDF the current page, 1-based, and for text the selection the user has made), diff (and the selection the user has made in it), none (closed) or unknown. ' +
      'When the user refers to the page or file "on the right" or "open now", use inView (or the entry with shown: true).',
    inputSchema: {}
  },
  async () => respond(await forward('listOpenFiles', {}))
)

// ---- Bundle conversations (7.6.6, TODO 633 stage 3). The AI splits work into independent bundles and calls this. One approval (a question showing the list of bundles) ----
// The return value is JSON built by main (status: started / declined / error). The wait for the question can be long, like an approval,
// so the cancellation notice and progress are sent the same way as `approve`.

server.registerTool(
  'startBundles',
  {
    title: 'aios start parallel bundles',
    description:
      'Split work into independent bundles and run each in its own new conversation inside its own git worktree, in parallel. ' +
      'Use it only when the work divides into parts that do not need each other and touch mostly different files. ' +
      'The user is shown the list once and approves it; after that they are not asked again. ' +
      'Give each bundle a short name (letters, digits, - and _) and a self-contained prompt: the new conversation does not see this one. ' +
      'Returns at once. When a bundle finishes, aios sends you a short report here (result and branch), so do not poll or wait. ' +
      'Bundles are not merged: they end as branches for the user to review.',
    inputSchema: {
      bundles: z
        .array(
          z.object({
            name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/),
            title: z.string().max(120).optional(),
            prompt: z.string().min(1).max(20000)
          })
        )
        .min(1)
        .max(8)
    }
  },
  async (args, extra) => {
    const callId = randomUUID()
    const stopWatching = watchCancellation(extra, () => {
      callMain({ kind: 'approveCancelled', sessionId: SESSION, callId, toolUseId: null }).catch(() => {})
    })
    const stopProgress = keepAlive(extra)
    try {
      return respond(await forward('startBundles', { bundles: args.bundles, callId }))
    } finally {
      stopProgress()
      stopWatching()
    }
  }
)

// ---- aios's own settings (7.6.8, TODO 1060). Value validation, classification and the approval inbox are all in main; this side only forwards ----

server.registerTool(
  'getSettings',
  {
    title: 'aios settings',
    description:
      'List the settings of aios itself (this app): name, current value, default, allowed values, description, ' +
      'and whether changing it needs the approval of the user (changeNeedsApproval). ' +
      'Use it when the user asks about an aios setting or where something is configured. Pass names to read only some.',
    inputSchema: { names: z.array(z.string().max(100)).max(50).optional() }
  },
  async (args) => respond(await forward('getSettings', args.names === undefined ? {} : { names: args.names }))
)

// main asks in the approval inbox every time for settings that touch a choke point or updates, so, as with `approve`, send the cancellation notice and progress.
server.registerTool(
  'setSetting',
  {
    title: 'aios change setting',
    description:
      'Change one setting of aios itself (this app) by name; call getSettings first for the names and allowed values. ' +
      'The change takes effect in aios at once; an open aios window may not show the new value until it is reopened for some settings. ' +
      'Settings with changeNeedsApproval: true (approvals, updates, login, links) ask the user every time; the others change without asking. ' +
      'Only do this when the user asked for the change.',
    inputSchema: { name: z.string().max(100), value: z.unknown() }
  },
  async (args, extra) => {
    // Do not confuse an omitted value with an explicit null (e.g. reset to default). To clear a setting, require an explicit null.
    if (args.value === undefined) {
      return respond({ error: 'value is required. Pass null explicitly to clear a setting that allows null.' })
    }
    const callId = randomUUID()
    const toolUseId = toolUseIdOf(extra)
    const stopWatching = watchCancellation(extra, () => {
      callMain({ kind: 'approveCancelled', sessionId: SESSION, callId, toolUseId }).catch(() => {})
    })
    const stopProgress = keepAlive(extra)
    try {
      return respond(await forward('setSetting', { name: args.name, value: args.value, callId, toolUseId }))
    } finally {
      stopProgress()
      stopWatching()
    }
  }
)

// TODO 1060 stage 2: show that item in the settings screen. It only opens and changes no value, so it is not put in the approval inbox (name validation is in main).
server.registerTool(
  'openSettings',
  {
    title: 'aios open settings',
    description:
      "Open the settings screen of aios itself (this app) in this conversation's window and scroll to one setting, highlighted. " +
      'name is a setting name from getSettings. Use it when the user asks where a setting is, or to show a setting you read or changed. ' +
      'It does not change any value. The conversation is hidden behind the settings screen until the user goes back to it.',
    inputSchema: { name: z.string().max(100) }
  },
  async (args) => respond(await forward('openSettings', { name: args.name }))
)

// ---- Plugin tools (7.6.7, TODO 847). The list is received from main once, at startup ----

/**
 * Upper bound on waiting for the list. If main does not answer, start without plugin tools (do not make the CLI wait).
 * A timed-out call is removed from the bookkeeping table (`PendingCalls`). **Why 2 seconds** (shortened from 5 in the
 * wave 45 code-review): main's answer only reads a table in the same process, one round trip (p50 0.10 ms in spike 10),
 * and the socket is already connected. If main's JS thread does not answer for 2 seconds it is stuck, and other tools
 * would not answer either. The wait happens before stdio is connected, so it directly delays the first send of the
 * conversation (869 made the first message wait for the MCP connection). If we miss the list, the session simply has
 * no plugin tools and `list_changed` is not sent (switching takes effect from the next session, owner decision).
 */
const PLUGIN_TOOLS_WAIT_MS = 2_000

async function loadPluginTools(): Promise<void> {
  if (socket === null) return
  const listed = await callMain({ kind: 'pluginTools', sessionId: SESSION }, PLUGIN_TOOLS_WAIT_MS).catch(() => null)
  registerPluginTools(server, parsePluginToolList(listed), async (name, args, extra) => {
    // A tool with side effects makes main wait for the user in the approval inbox, so, as with `approve`, send the cancellation notice and progress.
    const callExtra = extra as Parameters<typeof keepAlive>[0]
    const callId = randomUUID()
    const stopWatching = watchCancellation(callExtra, () => {
      callMain({ kind: 'approveCancelled', sessionId: SESSION, callId, toolUseId: null }).catch(() => {})
    })
    const stopProgress = keepAlive(callExtra)
    try {
      // If main is down or disconnected, return `{ error }` (without dragging the CLI down, 7.6).
      return await forward('pluginTool', { name, arguments: args, callId, toolUseId: toolUseIdOf(extra) })
    } finally {
      stopProgress()
      stopWatching()
    }
  })
}

async function main(): Promise<void> {
  try {
    await link()
  } catch {
    // Even if we cannot connect, still start as an MCP server. Only the individual calls become deny;
    // the CLI as a whole is not brought down.
  }
  // The tools are listed in `tools/list`, so register them before connecting stdio.
  await loadPluginTools()
  await server.connect(new StdioServerTransport())
}

void main()
