// Wire protocol between the bridge-server (VM) and the MV3 extension (Mac).
// One JSON object per WebSocket text frame. The extension dials OUT to the
// bridge, so auth happens IN-BAND as the first frame (a browser WebSocket
// cannot set Authorization/CF-Access-* headers).

/** Extension -> bridge: first frame, authenticates the connection. */
export interface HelloMsg {
  t: "hello";
  token: string;
  ext?: string;
  v?: number;
  profile?: string;
}

/** Bridge -> extension: auth accepted; tells the extension the heartbeat cadence. */
export interface WelcomeMsg {
  t: "welcome";
  heartbeatMs: number;
}

/** Bridge -> extension: an MCP tool call to execute. */
export interface CmdMsg {
  t: "cmd";
  id: string;
  name: string;
  args: Record<string, unknown>;
  deadlineMs: number;
  /** Logical agent/session that owns the target tabs. Absent => "default". */
  sessionId?: string;
}

/** Bridge -> extension: pre-register a session (optional; sessions are also created
 *  lazily on first cmd). Sent when an MCP client opens a stateful transport. */
export interface SessionOpenMsg {
  t: "session_open";
  sessionId: string;
}

/** Bridge -> extension: an MCP client disconnected; tear down its owned tabs. */
export interface SessionCloseMsg {
  t: "session_close";
  sessionId: string;
}

/** Extension -> bridge: ack that a session's tabs were cleaned up. */
export interface SessionClosedMsg {
  t: "session_closed";
  sessionId: string;
}

/** MCP-shaped content part (text or image), passed straight through to the agent. */
export interface ContentPart {
  type: "text" | "image";
  text?: string;
  data?: string; // base64 (image)
  mimeType?: string;
}

export interface ToolResult {
  content: ContentPart[];
  isError?: boolean;
}

/** Extension -> bridge: result of a cmd. `result` is already MCP-shaped. */
export interface ResMsg {
  t: "res";
  id: string;
  ok: boolean;
  result?: ToolResult;
  error?: { code?: string; message?: string };
}

/** Extension -> bridge: debugger attach/detach/tab-close notifications. The
 *  top-level fields describe aggregate/most-recent state (kept for the popup and
 *  legacy status); `sessions` carries the per-session/per-tab breakdown. */
export interface StatusMsg {
  t: "status";
  attached: boolean;
  tabId?: number | null;
  url?: string | null;
  reason?: string;
  sessions?: Array<{
    sessionId: string;
    tabs: Array<{ tab: string; url: string | null; attached: boolean; active: boolean }>;
  }>;
}

/** Bidirectional app-level heartbeat. Native WS ping/pong frames are not
 *  visible to service-worker JS and do not reliably reset the MV3 idle timer,
 *  so we use observable app-level pings instead. */
export interface PingMsg {
  t: "ping";
}
export interface PongMsg {
  t: "pong";
}

/** Bridge -> extension: auth rejected. */
export interface ErrorMsg {
  t: "error";
  code: string;
}

export type FromExtension = HelloMsg | ResMsg | StatusMsg | SessionClosedMsg | PingMsg | PongMsg;

// ---------------------------------------------------------------------------------------------
// Validation of everything the extension sends
// ---------------------------------------------------------------------------------------------
//
// The interfaces above are a DESCRIPTION; until now they were also the only checking. Frames were
// `JSON.parse`d and cast straight to `FromExtension`, then switched on `msg.t` — so every field
// below was whatever the sender said it was.
//
// That was survivable while the WS face was something you ran for yourself. It is not now: that
// face is published through cloudflared and deliberately has NO Cloudflare Access policy in front
// of it, because a browser WebSocket cannot send the headers Access needs. The in-band token is
// the only gate, and everything after it used to be unexamined — including a `status` frame whose
// `sessions` array is unbounded, which is a memory-shaped hole on a small VM, and a `res` frame
// that could resolve a pending command with a payload of any shape.
//
// BOUNDS, NOT JUST TYPES. The counts are what stop a single frame from being expensive; the
// image `data` bound is deliberately generous, because a real screenshot is genuinely large and a
// cap that refuses one is a broken product rather than a defended one.

import { z } from "zod";

/** A screenshot arrives base64 in `data`; the express body limit above it is 10 MB. */
const MAX_IMAGE_CHARS = 8_000_000;
const MAX_CONTENT_PARTS = 64;
const MAX_SESSIONS = 200;
const MAX_TABS_PER_SESSION = 200;

const contentPartSchema = z.object({
  type: z.enum(["text", "image"]),
  text: z.string().max(MAX_IMAGE_CHARS).optional(),
  data: z.string().max(MAX_IMAGE_CHARS).optional(),
  mimeType: z.string().max(200).optional(),
});

const toolResultSchema = z.object({
  content: z.array(contentPartSchema).max(MAX_CONTENT_PARTS),
  isError: z.boolean().optional(),
});

const helloSchema = z.object({
  t: z.literal("hello"),
  token: z.string().min(1).max(512),
  ext: z.string().max(200).optional(),
  v: z.number().int().optional(),
  profile: z.string().max(200).optional(),
});

const resSchema = z.object({
  t: z.literal("res"),
  id: z.string().min(1).max(200),
  ok: z.boolean(),
  result: toolResultSchema.optional(),
  error: z
    .object({ code: z.string().max(200).optional(), message: z.string().max(4000).optional() })
    .optional(),
});

const statusSchema = z.object({
  t: z.literal("status"),
  attached: z.boolean(),
  tabId: z.number().int().nullable().optional(),
  url: z.string().max(4000).nullable().optional(),
  reason: z.string().max(1000).optional(),
  sessions: z
    .array(
      z.object({
        sessionId: z.string().max(200),
        tabs: z
          .array(
            z.object({
              tab: z.string().max(200),
              url: z.string().max(4000).nullable(),
              attached: z.boolean(),
              active: z.boolean(),
            })
          )
          .max(MAX_TABS_PER_SESSION),
      })
    )
    .max(MAX_SESSIONS)
    .optional(),
});

const sessionClosedSchema = z.object({
  t: z.literal("session_closed"),
  sessionId: z.string().min(1).max(200),
});

const fromExtensionSchema = z.discriminatedUnion("t", [
  helloSchema,
  resSchema,
  statusSchema,
  sessionClosedSchema,
  z.object({ t: z.literal("ping") }),
  z.object({ t: z.literal("pong") }),
]);

/**
 * Parse one inbound frame, or null if it is not something the extension may say.
 *
 * Returns null rather than throwing because the caller's only sane response to a bad frame is to
 * drop it — the socket is authenticated by then, and one malformed message is far more likely to
 * be a version skew than an attack. A THROW here would take down the connection and, with it,
 * every in-flight command on it.
 */
export function parseFromExtension(raw: unknown): FromExtension | null {
  const parsed = fromExtensionSchema.safeParse(raw);
  return parsed.success ? (parsed.data as FromExtension) : null;
}
export type ToExtension =
  | WelcomeMsg
  | CmdMsg
  | SessionOpenMsg
  | SessionCloseMsg
  | PingMsg
  | PongMsg
  | ErrorMsg;
