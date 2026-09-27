import type {
  AccessMode,
  FolderNode,
  LogEntry,
  LogLevel,
  MeView,
  MemorySource,
  MemoryStatus,
  Message,
  NoteSection,
  NoteView,
  PermissionResponse,
  QuestionRequest,
  Seat,
  SessionInfo,
  SessionMode,
  ShareView,
} from "@shared/protocol"
import { authToken, withToken } from "./auth"

export type { AccessMode, FolderNode, NoteSection, NoteView, QuestionRequest, Seat, SessionMode }

/** One workspace file, as the read-only viewer sees it. */
export type FilePreview = {
  path: string
  size: number
  text: string
  startLine: number
  totalLines: number
  truncated: boolean
  binary: boolean
}

export type ContextInfo = {
  /** which model these numbers describe; null means "no model selected" */
  model: string | null
  window: number
  inputLimit: number
  maxOutputTokens: number
  budget: number
  /** where these numbers came from: the user's own entry, the vendored registry, or the
   *  global defaults. The panel should say so rather than presenting a guess as a fact. */
  limitsFrom: "user" | "registry" | "default"
  /** what the vendored registry alone suggests, independent of the user's own entry; null
   *  when it has never heard of this model */
  registry: {
    limits: ModelLimits
    matched: "provider" | "exact" | "segment"
    providers: number
    disagreed: boolean
    fetchedAt: string | null
  } | null
  auto: boolean
  prune: boolean
  pruneProtect: number
  preserveRecent: number
}

/** Per-model limits the user fills in; an unset field falls back to the global env config. */
export type ModelLimits = { context?: number; input?: number; output?: number }

/** A saved API endpoint preset. The key never leaves the server — only a masked hint. */
export type PublicProvider = {
  id: string
  name: string
  baseURL: string
  model: string
  hasApiKey: boolean
  apiKeyHint: string
}

export type ProviderView = { active: string | null; list: PublicProvider[]; path: string }

/** An MCP server as the browser is allowed to see it: env is masked, and the trust
 *  confirmation is bound to a fingerprint of command + args + cwd. */
export type McpState = "disabled" | "starting" | "ready" | "failed"

export type PublicMcpServer = {
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  tools: string[]
  enabled: boolean
  trusted: boolean
  /** enabled, but its definition changed since it was confirmed: it will NOT run */
  needsTrust: boolean
  fingerprint: string
}

export type McpServerStatus = {
  id: string
  name: string
  status: McpState
  tools: number
  error?: string
}

export type McpView = {
  path: string
  list: PublicMcpServer[]
  status: McpServerStatus[]
}

export type McpServerInput = {
  id?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  tools?: string[]
  enabled?: boolean
  /** the one-time confirmation; a plain enable never grants trust */
  acknowledge?: boolean
}

/** A server another agent has configured but goto has not imported. `problem` marks entries
 *  that cannot be imported at all (a remote/HTTP server, a missing command). */
export type DiscoveredMcpServer = {
  name: string
  from: string
  kind: "opencode" | "mcpServers" | "vscode"
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  enabled: boolean
  splitFrom: string | null
  warnings: string[]
  problem: string | null
  imported: boolean
}

export type McpImportResult = McpView & {
  imported: string[]
  skipped: { name: string; reason: string }[]
}

export type SkillSource = "project" | "personal"

export type SkillInfo = {
  name: string
  description: string
  source: SkillSource
  /** absolute path; scripts and references live alongside it */
  dir: string
  /** tokens the body costs the context once the agent loads it */
  tokens: number
  /** when set, the skill ships dependencies that must be installed before use */
  install: string | null
  entries: string[]
  /** listed in the system prompt; false when the description budget dropped it */
  injected: boolean
}

export type SkillsView = {
  workspace: string
  roots: { source: SkillSource; dir: string }[]
  budget: number
  promptChars: number
  list: SkillInfo[]
}

export type SkillBody = {
  name: string
  description: string
  source: SkillSource
  dir: string
  body: string
}

export type Settings = {
  baseURL: string
  model: string
  workspace: string
  hasApiKey: boolean
  apiKeyHint: string
  apiKeySource: "saved" | "env" | "none"
  permissionTools: string[]
  maxSteps: number
  /** how many helper agents one conversation may fan out to */
  max: number
  /** the fetch tool's switch; off unless the user turns it on */
  webFetch: boolean
  settingsPath: string
  memory: {
    hypothesisTtlTurns: number
    maxTokens: number
  }
  context: ContextInfo
}

export type SettingsPatch = {
  apiKey?: string
  baseURL?: string
  model?: string
  workspace?: string
  webFetch?: boolean
}

export type TestResult = {
  ok: boolean
  models: number
  modelFound: boolean
}

export type MemoryEntry = {
  id: string
  key: string
  value: string
  source: MemorySource
  status: MemoryStatus
  stale: boolean
  rev: number
}

export type MemoryEntryInput = {
  id?: string
  key?: string
  value?: string
  source?: MemorySource
  status?: MemoryStatus
}

export type MemoryConflict = {
  id: string
  key: string
  value: string
  source: MemorySource
  status: MemoryStatus
  reason: string
  expected?: string
  correctable: boolean
}

export type MemoryView = {
  sessionID: string
  path: string
  text: string
  tokens: number
  pending: number
  ttlTurns: number
  maxTokens: number
  entries: MemoryEntry[]
  conflicts: MemoryConflict[]
}

export type CommandInfo = {
  name: string
  aliases: string[]
  usage: string
  description: string
}

export type TreeNode = {
  name: string
  path: string
  type: "file" | "directory"
  size?: number
}

export type TreeView = {
  path: string
  root: string
  nodes: TreeNode[]
  truncated: boolean
}

export type UploadedFile = {
  id: string
  type: "file"
  mime: string
  filename: string
  size: number
  fileID: string
}

export type LogView = {
  entries: LogEntry[]
  level: LogLevel
  file: string
  maxBytes: number
  keepFiles: number
}

export class ApiError extends Error {
  code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = "ApiError"
    this.code = code
  }
}

/** Endpoints this UI calls. `/api/version` reports what the running server actually
 *  registered, so a bundle rebuilt without a server restart is caught at boot instead of
 *  failing one confusing call at a time. */
export const REQUIRED_ROUTES = [
  "/api/version",
  "/api/me",
  "/api/share",
  "/api/share/rotate",
  "/api/workspace/file",
  "/api/sessions/:id/share",
  "/api/models",
  "/api/context",
  "/api/model-limits",
  "/api/providers",
  "/api/mcp",
  "/api/mcp/discover",
  "/api/mcp/import",
  "/api/skills",
  "/api/skills/:name",
  "/api/sessions/:id/rewind",
  "/api/sessions/:id/model",
  "/api/sessions/:id/mode",
  "/api/spawns/:id",
]

export type ServerVersion = { startedAt: number; pid: number; routes: string[] }

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  // The one place every call passes through, so this is the only place the seat has to be
  // attached. EventSource and download links cannot set headers and use withToken() instead.
  const token = authToken()
  const res = await fetch(input, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { "x-goto-token": token } : {}),
    },
  })

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    let code: string | undefined
    let parsed = false
    try {
      const body = (await res.json()) as { error?: string; code?: string }
      parsed = true
      if (body.error) detail = body.error
      code = body.code
    } catch {
      detail = `${res.status} ${res.statusText}`
    }

    // an unmatched route comes back as a plain-text 404 from the framework, not as one of
    // our JSON errors. That means the server predates this endpoint, not that it is missing.
    if (res.status === 404 && !parsed) {
      throw new ApiError(
        `服务端不认识这个接口：${init?.method ?? "GET"} ${input}。它多半比前端旧，重启 gt 即可。`,
        "STALE_SERVER",
      )
    }

    throw new ApiError(detail, code)
  }

  return (await res.json()) as T
}

function send(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }
}

export const api = {
  settings: () => request<Settings>("/api/settings"),
  version: () => request<ServerVersion>("/api/version"),
  /** who this browser is. `seat` is null when the server wants a token and this browser has
   *  none - the UI turns that into "ask the host for a link" instead of a wall of 401s. */
  me: () => request<MeView>("/api/me"),
  share: () => request<ShareView>("/api/share"),
  rotateShare: (seat?: "control" | "review" | "both") =>
    request<ShareView>("/api/share/rotate", send("POST", { seat })),
  sessionShare: (id: string, shared: boolean) =>
    request<SessionInfo>(`/api/sessions/${encodeURIComponent(id)}/share`, send("POST", { shared })),
  workspaceFile: (sessionID: string, path: string, offset = 1) =>
    request<FilePreview>(
      `/api/workspace/file?session=${encodeURIComponent(sessionID)}&path=${encodeURIComponent(path)}&offset=${offset}`,
    ),
  updateSettings: (patch: SettingsPatch) => request<Settings>("/api/settings", send("PUT", patch)),
  testConnection: (patch: SettingsPatch) => request<TestResult>("/api/settings/test", send("POST", patch)),

  memory: (sessionID: string) => request<MemoryView>(`/api/memory?session=${encodeURIComponent(sessionID)}`),
  saveMemory: (sessionID: string, entries: MemoryEntryInput[]) =>
    request<MemoryView>("/api/memory", send("PUT", { session: sessionID, entries })),
  decideMemory: (sessionID: string, id: string, decision: "approve" | "reject") =>
    request<MemoryView>("/api/memory/decide", send("POST", { session: sessionID, id, decision })),

  logs: (limit = 500) => request<LogView>(`/api/logs?limit=${limit}`),
  commands: () => request<CommandInfo[]>("/api/commands"),
  tree: (sessionID: string, dir = "") =>
    request<TreeView>(`/api/tree?session=${encodeURIComponent(sessionID)}&path=${encodeURIComponent(dir)}`),
  uploadToWorkspace: (sessionID: string, dir: string, files: { path: string; dataBase64: string }[]) =>
    request<{
      written: { path: string; bytes: number; renamedFrom?: string }[]
      skipped: { name: string; reason: string }[]
    }>("/api/workspace/upload", send("POST", { session: sessionID, dir, files })),

  folders: () => request<FolderNode[]>("/api/folders"),

  note: (sessionID: string) => request<NoteView>(`/api/notes?session=${encodeURIComponent(sessionID)}`),
  saveNote: (sessionID: string, text: string) =>
    request<NoteView>("/api/notes", send("PUT", { session: sessionID, text })),
  // a download link cannot carry a header, so the seat rides in the query string here
  noteExportURL: (sessionID: string) => withToken(`/api/notes/export?session=${encodeURIComponent(sessionID)}`),
  createFolder: (input: { name: string; parentID?: string | null }) =>
    request<FolderNode>("/api/folders", send("POST", input)),
  updateFolder: (id: string, patch: { name?: string; parentID?: string | null }) =>
    request<FolderNode>(`/api/folders/${encodeURIComponent(id)}`, send("PATCH", patch)),
  deleteFolder: (id: string) =>
    request<{ ok: boolean }>(`/api/folders/${encodeURIComponent(id)}`, { method: "DELETE" }),
  moveSession: (id: string, folderID: string) =>
    request<SessionInfo>(`/api/sessions/${encodeURIComponent(id)}/folder`, send("POST", { folderID })),

  sessions: () => request<SessionInfo[]>("/api/sessions"),
  models: (refresh = false) => request<{ models: string[]; fetchedAt: number; error?: string }>(`/api/models${refresh ? "?refresh=1" : ""}`),
  providers: () => request<ProviderView>("/api/providers"),
  saveProvider: (input: { id?: string; name?: string; baseURL?: string; apiKey?: string; model?: string }) =>
    request<ProviderView>("/api/providers", send("PUT", input)),
  deleteProvider: (id: string) =>
    request<ProviderView>(`/api/providers/${encodeURIComponent(id)}`, send("DELETE")),
  /** copies the preset into the live config and returns the new settings */
  activateProvider: (id: string) =>
    request<Settings>(`/api/providers/${encodeURIComponent(id)}/activate`, send("POST")),

  mcp: () => request<McpView>("/api/mcp"),
  saveMcpServer: (input: McpServerInput) => request<McpView>("/api/mcp", send("PUT", input)),
  deleteMcpServer: (id: string) =>
    request<McpView>(`/api/mcp/${encodeURIComponent(id)}`, { method: "DELETE" }),
  mcpDiscover: () => request<{ servers: DiscoveredMcpServer[] }>("/api/mcp/discover"),
  mcpImport: (names?: string[]) =>
    request<McpImportResult>("/api/mcp/import", send("POST", names && names.length > 0 ? { names } : {})),

  skills: (sessionID?: string) =>
    request<SkillsView>(`/api/skills${sessionID ? `?session=${encodeURIComponent(sessionID)}` : ""}`),
  skill: (name: string, sessionID?: string) =>
    request<SkillBody>(
      `/api/skills/${encodeURIComponent(name)}${sessionID ? `?session=${encodeURIComponent(sessionID)}` : ""}`,
    ),
  setSessionModel: (id: string, model: string) => request<SessionInfo>(`/api/sessions/${id}/model`, send("POST", { model })),
  context: (model: string) => request<ContextInfo>(`/api/context?model=${encodeURIComponent(model)}`),
  modelLimits: () => request<{ path: string; limits: Record<string, ModelLimits> }>("/api/model-limits"),
  saveModelLimits: (model: string, limits: ModelLimits) =>
    request<{ limits: Record<string, ModelLimits> }>("/api/model-limits", send("PUT", { model, limits })),
  createSession: (folderID: string, workspace?: string) =>
    request<SessionInfo>("/api/sessions", send("POST", { folderID, workspace })),
  session: (id: string) => request<{ session: SessionInfo; messages: Message[] }>(`/api/sessions/${id}`),
  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setAccessMode: (id: string, mode: AccessMode) =>
    request<SessionInfo>(`/api/sessions/${encodeURIComponent(id)}/access`, send("POST", { mode })),
  setMode: (id: string, mode: SessionMode) =>
    request<SessionInfo>(`/api/sessions/${encodeURIComponent(id)}/mode`, send("POST", { mode })),

  prompt: (id: string, text: string, model?: string, files: UploadedFile[] = []) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/prompt`, send("POST", { text, model, files })),

  upload: (input: { mime: string; filename: string; dataBase64: string }) =>
    request<UploadedFile>("/api/files", send("POST", input)),
  abort: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}/abort`, send("POST")),
  rewind: (id: string, messageID: string) =>
    request<{ ok: boolean; removed: number }>(`/api/sessions/${id}/rewind`, send("POST", { messageID })),
  permission: (id: string, response: PermissionResponse) =>
    request<{ ok: boolean }>(`/api/permissions/${id}`, send("POST", { response })),
  answerQuestion: (id: string, answer: string, skip = false) =>
    request<{ ok: boolean }>(`/api/questions/${encodeURIComponent(id)}`, send("POST", { answer, skip })),
  resolveSpawn: (id: string, allowed: boolean, parallel: boolean) =>
    request<{ ok: boolean }>(`/api/spawns/${encodeURIComponent(id)}`, send("POST", { allowed, parallel })),
}
