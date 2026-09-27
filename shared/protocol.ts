export type Role = "user" | "assistant" | "system"

export type ToolStatus = "running" | "done" | "error"

export type TokenUsage = {
  total?: number
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

export type TextPart = {
  id: string
  type: "text"
  text: string
}

/** The model's thinking, when it exposes any. Kept for display only: it is never sent
 *  back in a later request (DeepSeek's reasoner rejects that outright, and it is
 *  transient by nature). */
export type ReasoningPart = {
  id: string
  type: "reasoning"
  text: string
}

export type ToolPart = {
  id: string
  type: "tool"
  callID: string
  tool: string
  input: unknown
  status: ToolStatus
  title?: string
  output?: string
  error?: string
  diff?: string
  compactedAt?: number
}

export type MemorySource = "user" | "probe" | "tool" | "inferred"

export type MemoryStatus = "active" | "pending"

export type MemoryDelta = {
  key: string
  value: string
  source?: MemorySource
}

export type CompactionPart = {
  id: string
  type: "compaction"
  summary: string
  foldedMessageIDs: string[]
  foldedCount: number
  tokensBefore: number
  tokensAfter: number
  tailStartId?: string
  addedMemories: MemoryDelta[]
  invalidatedMemories: MemoryDelta[]
}

export type FilePart = {
  id: string
  type: "file"
  mime: string
  filename: string
  size: number
  /** key into .data/files — the bytes are deliberately not in the message, so a
   *  screenshot does not bloat the persisted session json */
  fileID: string
}

export type Part = TextPart | ReasoningPart | ToolPart | CompactionPart | FilePart

export type Message = {
  id: string
  sessionID: string
  role: Role
  createdAt: number
  parts: Part[]
  summary?: boolean
  tokens?: TokenUsage
}

export type PermissionRequest = {
  id: string
  sessionID: string
  tool: string
  title: string
  detail: string
  createdAt: number
}

export type PermissionResponse = "once" | "always" | "reject"

export type QuestionRequest = {
  id: string
  sessionID: string
  question: string
  options: string[]
  allowFreeText: boolean
  createdAt: number
}

/** Pure UI grouping. A folder never scopes the agent's tools - the workspace
 *  comes from settings, so moving a conversation between folders changes nothing
 *  about what the agent can reach. */
export type FolderNode = {
  id: string
  name: string
  parentID: string | null
  order: number
}

/** How far the file tools may reach. "workspace" keeps read/write/edit/list/grep
 *  inside the session workspace; "full" lets them touch any path on the machine.
 *  It is a per-session user choice, never something the agent can grant itself. */
export type AccessMode = "workspace" | "full"

/** How much the agent is allowed to do in a conversation. "plan" withholds every mutating
 *  tool - write / edit / bash / MCP - so the agent can only look and report; "agent" is
 *  everything. Like accessMode it is a per-conversation user choice and never something the
 *  agent can grant itself. */
export type SessionMode = "plan" | "agent"

/** The two seats of a shared conversation. It is a property of the client's token, not of a
 *  particular conversation: "control" drives the agent and owns everything administrative,
 *  "review" may only read conversations that were shared with it. */
export type Seat = "control" | "review"

export type SessionInfo = {
  id: string
  title: string
  workspace: string
  createdAt: number
  running: boolean
  /** always set: a conversation cannot exist outside a folder */
  folderID: string
  accessMode: AccessMode
  mode: SessionMode
  /** per-conversation model override; unset means "follow the global setting" */
  model?: string
  /** set on sub-agents: the conversation that spawned it */
  parentID?: string
  /** set on sub-agents: what it was told to do, shown in the UI */
  task?: string
  /** visible to the review seat. Only the control seat can flip it, and a sub-agent is
   *  visible whenever the conversation that spawned it is. */
  shared: boolean
}

/** Who the caller is. `seat` is null when the server requires a token and none was
 *  presented - that is the state the UI turns into "ask the host for a link". */
export type MeView = {
  seat: Seat | null
  authRequired: boolean
}

/** The links the control seat hands out. Tokens ride in the URL fragment, which browsers
 *  never send to the server, so they stay out of access logs and referrers. */
export type ShareView = {
  enabled: boolean
  host: string
  controlURL: string
  reviewURL: string
}

export type ServerEvent =
  | {
      type: "snapshot"
      session: SessionInfo
      messages: Message[]
      /** Prompts still waiting for an answer. Nothing else replays them, so a client that
       *  connects (or reconnects) mid-turn would otherwise never see the dialog and the
       *  turn would sit there until it timed out. */
      permission?: PermissionRequest
      question?: QuestionRequest
      spawn?: SpawnRequest
    }
  | { type: "message.start"; message: Message }
  | { type: "part.start"; messageID: string; part: Part }
    | { type: "text.delta"; messageID: string; partID: string; delta: string }
    | { type: "reasoning.delta"; messageID: string; partID: string; delta: string }
  | { type: "tool.input"; messageID: string; partID: string; input: unknown }
  | { type: "tool.output"; messageID: string; partID: string; chunk: string }
  | {
      type: "tool.end"
      messageID: string
      partID: string
      status: Exclude<ToolStatus, "running">
      title?: string
      output?: string
      error?: string
      diff?: string
    }
  | { type: "permission.request"; request: PermissionRequest }
  | { type: "permission.resolved"; permissionID: string; response: PermissionResponse }
    | { type: "question.request"; request: QuestionRequest }
    | { type: "question.resolved"; questionID: string; answer: string }
    | { type: "spawn.request"; request: SpawnRequest }
    | { type: "spawn.resolved"; spawnID: string; response: SpawnResponse }
    | { type: "subagents.changed"; sessionID: string; subagents: SessionInfo[] }
  | { type: "session.status"; sessionID: string; running: boolean }
    /** the conversation's own metadata changed - currently only `shared`. Emitted so the
     *  review seat can drop a conversation the moment the control seat stops sharing it. */
    | { type: "session.info"; session: SessionInfo }
  | { type: "message.tokens"; messageID: string; tokens: TokenUsage }
    | { type: "parts.compacted"; sessionID: string; partIDs: string[]; at: number }
    | { type: "note.changed"; sessionID: string }
    | { type: "error"; message: string }

/** A folder-scoped knowledge document the agent writes for *other* agents.
 *  It describes the project itself - what it is, how to run it, what to watch out
 *  for - never what a particular work session did. */
export type NoteSection = {
  name: string
  body: string
  /** ISO timestamp of the last write */
  updatedAt?: string
  /** which conversation wrote it */
  sessionID?: string
  tokens: number
}

export type NoteView = {
  sessionID: string
  sessionTitle: string
  path: string
  text: string
  sections: NoteSection[]
  /** the workspace recorded in the file header, when it was written */
  workspace: string | null
  tokens: number
  budget: number
  /** section names that fit inside the injection budget */
  injected: string[]
  omitted: { name: string; tokens: number }[]
  updatedAt: string | null
}

/** The agent wants to fan this conversation out to helper agents. Always shown to the user
 *  before anything is created — the count and the tasks are the agent's proposal, never a
 *  silent decision. */
export type SpawnRequest = {
  id: string
  sessionID: string
  tasks: string[]
  /** the agent's suggestion; the user can flip it in the prompt */
  parallel: boolean
  createdAt: number
}

export type SpawnResponse = {
  allowed: boolean
  parallel: boolean
}

/** What one helper agent accomplished, handed back to the conversation that spawned it. */
export type SubagentReport = {
  id: string
  task: string
  status: "done" | "failed" | "aborted" | "pending"
  report: string
}

export type RunStatus = "idle" | "running"

export type LogLevel = "debug" | "info" | "warn" | "error"

export type LogEntry = {
  seq: number
  ts: number
  level: LogLevel
  scope: string
  message: string
  data?: Record<string, unknown>
}

export type LogEvent =
  | { type: "log.snapshot"; entries: LogEntry[] }
  | { type: "log.entry"; entry: LogEntry }
