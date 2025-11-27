#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import dotenv from "dotenv";
import crypto from "crypto";

// Add a modest request timeout to avoid hanging tool calls
const DEFAULT_HTTP_TIMEOUT_MS = 30000;

// Redirect all console output to stderr
const originalConsole = { ...console };
console.log = (...args) => originalConsole.error(...args);
console.info = (...args) => originalConsole.error(...args);
console.warn = (...args) => originalConsole.error(...args);

dotenv.config();

const GONG_API_URL = 'https://api.gong.io/v2';
const GONG_ACCESS_KEY = process.env.GONG_ACCESS_KEY;
const GONG_ACCESS_SECRET = process.env.GONG_ACCESS_SECRET;
const GONG_USER_FULL_NAME = process.env.GONG_USER_FULL_NAME; // Used for default user resolution

// Check for required environment variables
if (!GONG_ACCESS_KEY || !GONG_ACCESS_SECRET) {
  console.error("Error: GONG_ACCESS_KEY and GONG_ACCESS_SECRET environment variables are required");
  process.exit(1);
}

// Type definitions
interface GongCall {
  id: string;
  title: string;
  scheduled?: string;
  started?: string;
  duration?: number;
  direction?: string;
  system?: string;
  scope?: string;
  media?: string;
  language?: string;
  url?: string;
}

interface GongTranscript {
  speakerId: string;
  topic?: string;
  sentences: Array<{
    start: number;
    text: string;
  }>;
}

interface GongUser {
  id: string;
  name?: string; // legacy
  fullName?: string; // legacy
  firstName?: string;
  lastName?: string;
  email?: string; // legacy
  emailAddress?: string;
}

interface GongListCallsResponse {
  calls: GongCall[];
}

interface GongRetrieveTranscriptsResponse {
  transcripts: GongTranscript[];
}

interface GongListCallsExtensiveResponse {
  records?: {
    totalRecords?: number;
    currentPageSize?: number;
    currentPageNumber?: number;
    cursor?: string;
  };
  calls?: Array<Record<string, unknown>>;
}

interface GongUsersResponse {
  records?: {
    cursor?: string;
  };
  users?: GongUser[];
}

interface GongListCallsArgs {
  [key: string]: string | undefined;
  fromDateTime?: string;
  toDateTime?: string;
}

interface GongRetrieveTranscriptsArgs {
  callIds: string[] | string;
}

interface GongListCallsExtensiveArgs {
  start_date?: string;
  end_date?: string;
  user_id?: string;
  user_ids?: string[];
  userIds?: string[];
  text?: string;
}

// Gong API Client
class GongClient {
  private accessKey: string;
  private accessSecret: string;

  constructor(accessKey: string, accessSecret: string) {
    this.accessKey = accessKey;
    this.accessSecret = accessSecret;
  }

  private async generateSignature(method: string, path: string, timestamp: string, params?: unknown): Promise<string> {
    const stringToSign = `${method}\n${path}\n${timestamp}\n${params ? JSON.stringify(params) : ''}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(this.accessSecret);
    const messageData = encoder.encode(stringToSign);
    
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const signature = await crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      messageData
    );
    
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  private async request<T>(method: string, path: string, params?: Record<string, string | undefined>, data?: Record<string, unknown>): Promise<T> {
    const timestamp = new Date().toISOString();
    const url = `${GONG_API_URL}${path}`;
    
    const response = await axios({
      method,
      url,
      params,
      data,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${this.accessKey}:${this.accessSecret}`).toString('base64')}`,
        'X-Gong-AccessKey': this.accessKey,
        'X-Gong-Timestamp': timestamp,
        'X-Gong-Signature': await this.generateSignature(method, path, timestamp, data || params)
      },
      timeout: DEFAULT_HTTP_TIMEOUT_MS
    });

    return response.data as T;
  }

  async listCalls(fromDateTime?: string, toDateTime?: string): Promise<GongListCallsResponse> {
    const params: GongListCallsArgs = {};
    if (fromDateTime) params.fromDateTime = fromDateTime;
    if (toDateTime) params.toDateTime = toDateTime;

    return this.request<GongListCallsResponse>('GET', '/calls', params);
  }

  async retrieveTranscripts(callIds: string[]): Promise<GongRetrieveTranscriptsResponse> {
    return this.request<GongRetrieveTranscriptsResponse>('POST', '/calls/transcript', undefined, {
      filter: {
        callIds,
        includeEntities: true,
        includeInteractionsSummary: true,
        includeTrackers: true
      }
    });
  }

  async listCallsExtensive(filter: Record<string, unknown>, cursor?: string): Promise<GongListCallsExtensiveResponse> {
    const payload: Record<string, unknown> = { filter };
    if (cursor) {
      payload.cursor = cursor;
    }
    return this.request<GongListCallsExtensiveResponse>('POST', '/calls/extensive', undefined, payload);
  }

  async getUsers(cursor?: string, includeAvatars = false): Promise<GongUsersResponse> {
    const params: Record<string, string> = {};
    if (cursor) params.cursor = cursor;
    if (includeAvatars) params.includeAvatars = "true";
    return this.request<GongUsersResponse>('GET', '/users', params);
  }
}

const gongClient = new GongClient(GONG_ACCESS_KEY, GONG_ACCESS_SECRET);

// Cache the resolved user id for the configured full name
let cachedUserId: string | null = null;
async function getOrResolveMyUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;
  if (!GONG_USER_FULL_NAME) {
    throw new Error("GONG_USER_FULL_NAME is not set; unable to resolve default user.");
  }

  let cursor: string | undefined;
  const matches: GongUser[] = [];
  do {
    const resp = await gongClient.getUsers(cursor);
      const users = resp.users ?? [];
      for (const u of users) {
        const composite = `${u.firstName || ""} ${u.lastName || ""}`.trim();
        const candidateName = (composite || u.fullName || u.name || "").trim().toLowerCase();
        if (!candidateName) continue;
        if (candidateName === GONG_USER_FULL_NAME.trim().toLowerCase()) {
          matches.push(u);
        }
      }
    cursor = resp.records?.cursor;
  } while (cursor);

  if (matches.length === 0) {
    throw new Error(`No Gong user matched configured full name '${GONG_USER_FULL_NAME}'.`);
  }

  // Deterministic pick: lowest lexical id if multiple matches
  matches.sort((a, b) => (a.id || "").localeCompare(b.id || ""));
  cachedUserId = matches[0].id;
  if (!cachedUserId) {
    throw new Error("Matched user has no id field; cannot proceed.");
  }
  return cachedUserId;
}

// Tool definitions
const LIST_CALLS_TOOL: Tool = {
  name: "list_calls",
  description: "List Gong calls with optional date range filtering. Returns call details including ID, title, start/end times, participants, and duration.",
  inputSchema: {
    type: "object",
    properties: {
      fromDateTime: {
        type: "string",
        description: "Start date/time in ISO format (e.g. 2024-03-01T00:00:00Z)"
      },
      toDateTime: {
        type: "string",
        description: "End date/time in ISO format (e.g. 2024-03-31T23:59:59Z)"
      }
    }
  }
};

const RETRIEVE_TRANSCRIPTS_TOOL: Tool = {
  name: "retrieve_transcripts",
  description: "Retrieve transcripts for specified call IDs. Returns detailed transcripts including speaker IDs, topics, and timestamped sentences.",
  inputSchema: {
    type: "object",
    properties: {
      callIds: {
        anyOf: [
          {
            type: "array",
            items: { type: "string" }
          },
          {
            type: "string"
          }
        ],
        description: "A Gong call ID or array of Gong call IDs to retrieve transcripts for"
      }
    },
    required: ["callIds"]
  }
};

const LIST_CALLS_EXTENSIVE_TOOL: Tool = {
  name: "list_calls_extensive",
  description: "List detailed Gong calls via /v2/calls/extensive with optional date range, user filter, and text filter. Defaults to the configured GONG_USER_FULL_NAME when userIds are not provided.",
  inputSchema: {
    type: "object",
    properties: {
      start_date: { type: "string", description: "Start date/time ISO (fromDateTime filter)" },
      end_date: { type: "string", description: "End date/time ISO (toDateTime filter)" },
      user_id: { type: "string", description: "Single Gong user id to filter host/owner" },
      user_ids: {
        type: "array",
        items: { type: "string" },
        description: "Array of Gong user ids; overrides default user resolution"
      },
      userIds: {
        type: "array",
        items: { type: "string" },
        description: "Alias for user_ids"
      },
      text: { type: "string", description: "Optional text/customer filter supported by Gong" }
    }
  }
};

const GET_USERS_TOOL: Tool = {
  name: "get_users",
  description: "List Gong users (paginated) with optional name filter applied client-side.",
  inputSchema: {
    type: "object",
    properties: {
      name_filter: { type: "string", description: "Optional case-insensitive substring filter on user name" }
    }
  }
};

// Server implementation
const server = new Server(
  {
    name: "example-servers/gong",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Type guards
function isGongListCallsArgs(args: unknown): args is GongListCallsArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    (!("fromDateTime" in args) || typeof (args as GongListCallsArgs).fromDateTime === "string") &&
    (!("toDateTime" in args) || typeof (args as GongListCallsArgs).toDateTime === "string")
  );
}

function isGongRetrieveTranscriptsArgs(args: unknown): args is GongRetrieveTranscriptsArgs {
  if (typeof args !== "object" || args === null || !("callIds" in args)) return false;
  const val = (args as GongRetrieveTranscriptsArgs).callIds;
  if (typeof val === "string") return true;
  return Array.isArray(val) && val.every((id) => typeof id === "string");
}

function isListCallsExtensiveArgs(args: unknown): args is GongListCallsExtensiveArgs {
  if (typeof args !== "object" || args === null) return false;
  const obj = args as GongListCallsExtensiveArgs;
  const allStrings = ["start_date", "end_date", "user_id", "text"].every(
    (k) => !(k in obj) || typeof (obj as Record<string, unknown>)[k] === "string"
  );
  const userIds = obj.user_ids ?? obj.userIds;
  const arraysValid =
    userIds === undefined ||
    (Array.isArray(userIds) && userIds.every((u) => typeof u === "string"));
  return allStrings && arraysValid;
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [LIST_CALLS_TOOL, LIST_CALLS_EXTENSIVE_TOOL, GET_USERS_TOOL, RETRIEVE_TRANSCRIPTS_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: unknown } }) => {
  try {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error("No arguments provided");
    }

    switch (name) {
      case "list_calls": {
        if (!isGongListCallsArgs(args)) {
          throw new Error("Invalid arguments for list_calls");
        }
        const { fromDateTime, toDateTime } = args;
        const response = await gongClient.listCalls(fromDateTime, toDateTime);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify(response, null, 2)
          }],
          isError: false,
        };
      }

      case "list_calls_extensive": {
        if (!isListCallsExtensiveArgs(args)) {
          throw new Error("Invalid arguments for list_calls_extensive");
        }
        const userIdsExplicit = args.user_ids || args.userIds;
        const userIds = userIdsExplicit && userIdsExplicit.length > 0
          ? userIdsExplicit
          : args.user_id
            ? [args.user_id]
            : [await getOrResolveMyUserId()];

        const filter: Record<string, unknown> = {
          fromDateTime: args.start_date,
          toDateTime: args.end_date,
          userIds,
        };
        if (args.text) {
          filter.text = args.text;
        }

        const allCalls: Array<Record<string, unknown>> = [];
        let cursor: string | undefined;
        let safety = 0;
        do {
          const response = await gongClient.listCallsExtensive(filter, cursor);
          if (response.calls) {
            allCalls.push(...response.calls);
          }
          cursor = response.records?.cursor;
          safety += 1;
        } while (cursor && safety < 50); // prevent runaway pagination

        const normalized = allCalls.map((call) => {
          const participants = Array.isArray((call as Record<string, unknown>).participants)
            ? (call as Record<string, unknown>).participants as Array<Record<string, unknown>>
            : [];
          const started =
            (call as Record<string, unknown>).started ||
            (call as Record<string, unknown>).startTime ||
            (call as Record<string, unknown>).startedAt;
          const ended =
            (call as Record<string, unknown>).ended ||
            (call as Record<string, unknown>).endTime ||
            (call as Record<string, unknown>).endedAt;
          return {
            callId: (call as Record<string, unknown>).id,
            title: (call as Record<string, unknown>).title || (call as Record<string, unknown>).subject,
            startedAt: started,
            endedAt: ended,
            duration: (call as Record<string, unknown>).duration,
            participants: participants.map((p) => ({
              role: (p as Record<string, unknown>).role || (p as Record<string, unknown>).type,
              displayName: (p as Record<string, unknown>).displayName || (p as Record<string, unknown>).name,
              id: (p as Record<string, unknown>).id || (p as Record<string, unknown>).userId,
            })),
            gongUrl:
              (call as Record<string, unknown>).url ||
              ((call as Record<string, unknown>).id
                ? `https://app.gong.io/call?id=${(call as Record<string, unknown>).id}`
                : undefined),
          };
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: normalized.length,
                  calls: normalized,
                },
                null,
                2
              ),
            },
          ],
          isError: false,
        };
      }

      case "get_users": {
        const nameFilter =
          typeof args === "object" && args !== null && "name_filter" in args
            ? (args as { name_filter?: unknown }).name_filter
            : undefined;
        const filterStr = typeof nameFilter === "string" ? nameFilter.toLowerCase() : undefined;
        let cursor: string | undefined;
        const users: GongUser[] = [];
        let safety = 0;
        do {
          const resp = await gongClient.getUsers(cursor);
          users.push(...(resp.users || []));
          cursor = resp.records?.cursor;
          safety += 1;
        } while (cursor && safety < 50);

        const filtered = filterStr
          ? users.filter((u) => {
              const composite = `${u.firstName || ""} ${u.lastName || ""}`.trim().toLowerCase();
              const alt = (u.fullName || u.name || "").toLowerCase();
              return composite.includes(filterStr) || alt.includes(filterStr);
            })
          : users;

        const simplified = filtered.map((u) => ({
          userId: u.id,
          fullName: u.fullName ?? u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() ?? null,
          email: u.emailAddress ?? u.email ?? null,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: simplified.length, users: simplified }, null, 2),
            },
          ],
          isError: false,
        };
      }

      case "retrieve_transcripts": {
        if (!isGongRetrieveTranscriptsArgs(args)) {
          throw new Error("Invalid arguments for retrieve_transcripts");
        }
        const { callIds } = args;
        const idsArray = Array.isArray(callIds) ? callIds : [callIds];
        const response = await gongClient.retrieveTranscripts(idsArray);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify(response, null, 2)
          }],
          isError: false,
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
}); 
