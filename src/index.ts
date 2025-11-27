#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

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
const GONG_USER_ID = process.env.GONG_USER_ID;
const ENV_FILE_PATH = path.resolve(process.cwd(), ".env");

// Check for required environment variables
if (!GONG_ACCESS_KEY || !GONG_ACCESS_SECRET) {
  console.error("Error: GONG_ACCESS_KEY and GONG_ACCESS_SECRET environment variables are required");
  process.exit(1);
}

const pad2 = (num: number) => String(num).padStart(2, "0");

function persistUserIdToEnv(userId: string) {
  try {
    if (!userId) return;
    if (!fs.existsSync(ENV_FILE_PATH)) return;
    const current = fs.readFileSync(ENV_FILE_PATH, "utf8");
    const lines = current.split(/\r?\n/);
    let updated = false;
    const nextLines = lines.map((line) => {
      if (line.trim().startsWith("GONG_USER_ID=")) {
        updated = true;
        return `GONG_USER_ID=${userId}`;
      }
      return line;
    });
    if (!updated) {
      nextLines.push(`GONG_USER_ID=${userId}`);
    }
    const next = nextLines.join(os.EOL);
    if (next !== current) {
      fs.writeFileSync(ENV_FILE_PATH, next, "utf8");
    }
  } catch (err) {
    console.error(`Failed to persist GONG_USER_ID to .env: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function formatLocalIso(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hoursOffset = pad2(Math.floor(abs / 60));
  const minutesOffset = pad2(abs % 60);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${sign}${hoursOffset}:${minutesOffset}`;
}

function formatDuration(seconds?: number): string | undefined {
  if (seconds === undefined || seconds === null) return undefined;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m${pad2(secs)}s`;
}

function formatYmd(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addDays(date: Date, delta: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + delta);
  return copy;
}

function defaultRangeFromDaysBack(daysBack: number): { fromDate: string; toDate: string } {
  const today = new Date();
  const end = formatYmd(today); // exclusive end date is today (company time zone assumed)
  const start = formatYmd(addDays(today, -Math.max(1, Math.floor(daysBack))));
  return { fromDate: start, toDate: end };
}

function collectCallIdsFromActivities(users: Array<{
  userDailyActivityStats?: Array<Record<string, unknown>>;
}> | undefined): Set<string> {
  const all = new Set<string>();
  if (!users) return all;
  for (const u of users) {
    for (const day of u.userDailyActivityStats || []) {
      (day.callsAttended as string[] | undefined)?.forEach((id) => all.add(id));
      (day.callsAsHost as string[] | undefined)?.forEach((id) => all.add(id));
    }
  }
  return all;
}

function formatTimeShort(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return undefined;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function getTodayBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return {
    startIso: formatLocalIso(start),
    endIso: formatLocalIso(end),
    label: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`,
    startDate: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`,
    endDate: `${end.getFullYear()}-${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}`,
  };
}

// Type definitions
interface GongCall {
  id: string;
  title: string;
  scheduled?: string;
  started?: string;
  primaryUserId?: string;
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

interface GongGetCallResponse {
  call: GongCall;
}

interface GongActivityDayByDayResponse {
  records?: {
    totalRecords?: number;
    currentPageSize?: number;
    currentPageNumber?: number;
    cursor?: string;
  };
  usersDetailedActivities?: Array<{
    userId: string;
    userEmailAddress?: string;
    userDailyActivityStats?: Array<Record<string, unknown>>;
    callsAsHost?: string[];
    callsGaveFeedback?: string[];
    callsRequestedFeedback?: string[];
    callsReceivedFeedback?: string[];
    ownCallsListenedTo?: string[];
    othersCallsListenedTo?: string[];
    callsSharedInternally?: string[];
    callsSharedExternally?: string[];
    callsAttended?: string[];
    callsCommentsGiven?: string[];
    callsCommentsReceived?: string[];
    callsMarkedAsFeedbackGiven?: string[];
    callsMarkedAsFeedbackReceived?: string[];
    callsScorecardsFilled?: string[];
    callsScorecardsReceived?: string[];
    fromDate?: string;
    toDate?: string;
  }>;
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

interface GongActivityDayByDayArgs {
  cursor?: string;
  filter: {
    fromDate: string;
    toDate: string;
    userIds?: string[];
    createdFromDateTime?: string;
    createdToDateTime?: string;
  };
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

  async getCall(callId: string): Promise<GongGetCallResponse> {
    return this.request<GongGetCallResponse>('GET', `/calls/${callId}`);
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

  async activityDayByDay(args: GongActivityDayByDayArgs): Promise<GongActivityDayByDayResponse> {
    const payload: Record<string, unknown> = { filter: args.filter };
    if (args.cursor) payload.cursor = args.cursor;
    return this.request<GongActivityDayByDayResponse>('POST', '/stats/activity/day-by-day', undefined, payload);
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
let cachedUserId: string | null = GONG_USER_ID || null;
async function getOrResolveMyUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;
  if (GONG_USER_ID) {
    cachedUserId = GONG_USER_ID;
    persistUserIdToEnv(cachedUserId);
    return cachedUserId;
  }
  if (!GONG_USER_FULL_NAME) {
    throw new Error("Set GONG_USER_ID or GONG_USER_FULL_NAME to resolve the default user.");
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
  persistUserIdToEnv(cachedUserId);
  return cachedUserId;
}

// User cache for id -> display name
const userCache: Map<string, string> = new Map();
let usersLoaded = false;
async function ensureUserCache() {
  if (usersLoaded) return;
  let cursor: string | undefined;
  let safety = 0;
  do {
    const resp = await gongClient.getUsers(cursor);
    for (const u of resp.users || []) {
      const name =
        u.fullName ||
        u.name ||
        `${u.firstName || ""} ${u.lastName || ""}`.trim() ||
        u.emailAddress ||
        u.email ||
        u.id ||
        "Unknown";
      if (u.id) userCache.set(u.id, name);
    }
    cursor = resp.records?.cursor;
    safety += 1;
  } while (cursor && safety < 50);
  usersLoaded = true;
}

async function resolveUserName(userId?: string): Promise<string | undefined> {
  if (!userId) return undefined;
  if (userCache.has(userId)) return userCache.get(userId);
  await ensureUserCache();
  return userCache.get(userId);
}

function normalizeCallRecord(call: Record<string, unknown>) {
  const meta = (call as Record<string, unknown>).metaData as Record<string, unknown> | undefined;
  const source = meta || call;
  const participants = Array.isArray((source as Record<string, unknown>).participants)
    ? ((source as Record<string, unknown>).participants as Array<Record<string, unknown>>)
    : [];
  const started =
    (source as Record<string, unknown>).started ||
    (source as Record<string, unknown>).startTime ||
    (source as Record<string, unknown>).startedAt ||
    (source as Record<string, unknown>).scheduled;
  const ended =
    (source as Record<string, unknown>).ended ||
    (source as Record<string, unknown>).endTime ||
    (source as Record<string, unknown>).endedAt;
  return {
    callId: (source as Record<string, unknown>).id,
    title: (source as Record<string, unknown>).title || (source as Record<string, unknown>).subject,
    startedAt: started,
    endedAt: ended,
    duration: (source as Record<string, unknown>).duration,
    scheduled: (source as Record<string, unknown>).scheduled,
    hostUserId: (source as Record<string, unknown>).primaryUserId,
    participants: participants.map((p) => ({
      role: (p as Record<string, unknown>).role || (p as Record<string, unknown>).type,
      displayName: (p as Record<string, unknown>).displayName || (p as Record<string, unknown>).name,
      id: (p as Record<string, unknown>).id || (p as Record<string, unknown>).userId,
    })),
    gongUrl:
      (source as Record<string, unknown>).url ||
      ((source as Record<string, unknown>).id
        ? `https://app.gong.io/call?id=${(source as Record<string, unknown>).id}`
        : undefined),
  };
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

const ACTIVITY_DAY_BY_DAY_TOOL: Tool = {
  name: "activity_day_by_day",
  description: "Retrieve daily activity for users between dates (Gong stats/day-by-day). Returns call IDs for attended/hosted calls, feedback, and other daily stats.",
  inputSchema: {
    type: "object",
    properties: {
      fromDate: { type: "string", description: "Inclusive start date YYYY-MM-DD (company time zone)." },
      toDate: { type: "string", description: "Exclusive end date YYYY-MM-DD (company time zone)." },
      userIds: {
        type: "array",
        items: { type: "string" },
        description: "Optional Gong user IDs. Defaults to resolved user if omitted."
      },
      cursor: { type: "string", description: "Optional cursor for pagination." }
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

const MY_CALLS_TODAY_TOOL: Tool = {
  name: "my_calls_today",
  description: "List today's calls for the default user (uses cached GONG_USER_ID, resolves once from GONG_USER_FULL_NAME if missing).",
  inputSchema: {
    type: "object",
    properties: {}
  }
};

const MY_CALLS_RANGE_TOOL: Tool = {
  name: "my_calls_range",
  description: "List calls I hosted or attended in a date range (day-by-day stats + call details). Dates are company time zone. toDate is exclusive.",
  inputSchema: {
    type: "object",
    properties: {
      fromDate: { type: "string", description: "Inclusive start date YYYY-MM-DD" },
      toDate: { type: "string", description: "Exclusive end date YYYY-MM-DD" },
      daysBack: { type: "number", description: "Optional number of days to look back (defaults to 5) when dates are omitted" },
      userIds: {
        type: "array",
        items: { type: "string" },
        description: "Optional Gong user IDs; defaults to resolved user."
      }
    },
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
  tools: [
    LIST_CALLS_TOOL,
    LIST_CALLS_EXTENSIVE_TOOL,
    ACTIVITY_DAY_BY_DAY_TOOL,
    MY_CALLS_RANGE_TOOL,
    MY_CALLS_TODAY_TOOL,
    GET_USERS_TOOL,
    RETRIEVE_TRANSCRIPTS_TOOL,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: unknown } }) => {
  try {
    const { name, arguments: rawArgs } = request.params;
    const args = rawArgs ?? {};

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

        const normalized = allCalls.map((call) => normalizeCallRecord(call));

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

      case "activity_day_by_day": {
        const argObj = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
        const fromDate = typeof argObj.fromDate === "string" ? argObj.fromDate : undefined;
        const toDate = typeof argObj.toDate === "string" ? argObj.toDate : undefined;
        const cursor = typeof argObj.cursor === "string" ? argObj.cursor : undefined;
        let userIds = Array.isArray(argObj.userIds) ? argObj.userIds.filter((u) => typeof u === "string") : undefined;
        if (!fromDate || !toDate) {
          throw new Error("fromDate and toDate (YYYY-MM-DD) are required");
        }
        if (!userIds || userIds.length === 0) {
          userIds = [await getOrResolveMyUserId()];
        }
        const response = await gongClient.activityDayByDay({
          cursor,
          filter: {
            fromDate,
            toDate,
            userIds,
          },
        });
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          isError: false,
        };
      }

      case "my_calls_range": {
    const argObj = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
    let fromDate = typeof argObj.fromDate === "string" ? argObj.fromDate : undefined;
    let toDate = typeof argObj.toDate === "string" ? argObj.toDate : undefined;
    const daysBack = typeof argObj.daysBack === "number" ? Math.max(1, Math.floor(argObj.daysBack)) : 5;

    // If dates are omitted, default to the last N days ending today (exclusive).
    if (!fromDate || !toDate) {
      const window = defaultRangeFromDaysBack(daysBack);
      fromDate = fromDate || window.fromDate;
      toDate = toDate || window.toDate;
    }

    // Prevent future end dates (Gong API rejects them).
    const today = formatYmd(new Date());
    if (toDate > today) {
      toDate = today;
    }

    let userIds = Array.isArray(argObj.userIds) ? argObj.userIds.filter((u) => typeof u === "string") : undefined;
    if (!userIds || userIds.length === 0) {
      userIds = [await getOrResolveMyUserId()];
    }

        let activity = await gongClient.activityDayByDay({
          filter: { fromDate, toDate, userIds },
        });

        // Fallback: if user not returned, retry without userIds and filter client-side
        const primaryUserId = userIds[0];
        if (!activity.usersDetailedActivities || activity.usersDetailedActivities.length === 0) {
          const retry = await gongClient.activityDayByDay({
            filter: { fromDate, toDate },
          });
          activity = retry;
        }

        const ids = Array.from(collectCallIdsFromActivities(activity.usersDetailedActivities));

        await ensureUserCache();
        const detailed: Array<Record<string, unknown>> = [];
        for (const id of ids) {
          try {
            const detail = await gongClient.getCall(id);
            detailed.push(normalizeCallRecord(detail.call as unknown as Record<string, unknown>));
          } catch (err) {
            detailed.push({ callId: id });
          }
        }

        detailed.sort((a, b) => {
          const left = a.startedAt ? new Date(String(a.startedAt)).getTime() : 0;
          const right = b.startedAt ? new Date(String(b.startedAt)).getTime() : 0;
          return left - right;
        });

        const formatted = detailed.map((c) => {
          const time = formatTimeShort((c as Record<string, unknown>).startedAt as string | undefined) || "??:??";
          const dur = formatDuration((c as Record<string, unknown>).duration as number | undefined);
          const title = (c as Record<string, unknown>).title || "Untitled";
          const hostId = (c as { hostUserId?: string }).hostUserId;
          const hostName = hostId ? userCache.get(hostId) || hostId : undefined;
          const url = (c as Record<string, unknown>).gongUrl as string | undefined;
          return `${time} — ${title}${dur ? ` (${dur})` : ""}${hostName ? ` — Host: ${hostName}` : ""}${
            url ? ` — ${url}` : ""
          }`;
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  fromDate,
                  toDate,
                  count: detailed.length,
                  calls: detailed.map((c) => ({
                    callId: c.callId,
                    title: c.title,
                    startedAt: c.startedAt,
                    duration: c.duration,
                    hostUserId: (c as { hostUserId?: string }).hostUserId,
                    hostName: (c as { hostUserId?: string }).hostUserId
                      ? userCache.get((c as { hostUserId?: string }).hostUserId as string) ||
                        (c as { hostUserId?: string }).hostUserId
                      : undefined,
                    gongUrl: c.gongUrl,
                  })),
                  formatted,
                },
                null,
                2
              ),
            },
          ],
          isError: false,
        };
      }

      case "my_calls_today": {
        // This endpoint does not return data for the current day; use yesterday -> today window.
        const { startDate, endDate } = getTodayBounds();
        const today = startDate;
        const yesterdayDate = new Date(startDate);
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        const yesterday = `${yesterdayDate.getFullYear()}-${pad2(yesterdayDate.getMonth() + 1)}-${pad2(
          yesterdayDate.getDate()
        )}`;

        const userId = await getOrResolveMyUserId();

        // Fetch activity to get call IDs attended/hosted for yesterday
        const activity = await gongClient.activityDayByDay({
          filter: {
            fromDate: yesterday,
            toDate: today,
            userIds: [userId],
          },
        });

        const activityUser =
          activity.usersDetailedActivities?.find((u) => u.userId === userId) ??
          (activity.usersDetailedActivities && activity.usersDetailedActivities[0]);

        const callIds = Array.from(collectCallIdsFromActivities(activity.usersDetailedActivities));

        await ensureUserCache();
        const detailed: Array<Record<string, unknown>> = [];
        for (const id of callIds) {
          try {
            const detail = await gongClient.getCall(id);
            detailed.push(normalizeCallRecord(detail.call as unknown as Record<string, unknown>));
          } catch (err) {
            detailed.push({ callId: id });
          }
        }

        detailed.sort((a, b) => {
          const left = a.startedAt ? new Date(String(a.startedAt)).getTime() : 0;
          const right = b.startedAt ? new Date(String(b.startedAt)).getTime() : 0;
          return left - right;
        });

        const formatted = detailed.map((c) => {
          const time = formatTimeShort((c as Record<string, unknown>).startedAt as string | undefined) || "??:??";
          const dur = formatDuration((c as Record<string, unknown>).duration as number | undefined);
          const title = (c as Record<string, unknown>).title || "Untitled";
          const hostId = (c as { hostUserId?: string }).hostUserId;
          const hostName = hostId ? userCache.get(hostId) || hostId : undefined;
          const url = (c as Record<string, unknown>).gongUrl as string | undefined;
          return `${time} — ${title}${dur ? ` (${dur})` : ""}${hostName ? ` — Host: ${hostName}` : ""}${
            url ? ` — ${url}` : ""
          }`;
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  dateRange: `${yesterday} to ${today} (yesterday only; current day unsupported by stats API)`,
                  count: detailed.length,
                  calls: detailed.map((c) => ({
                    callId: c.callId,
                    title: c.title,
                    startedAt: c.startedAt,
                    duration: c.duration,
                    hostUserId: (c as { hostUserId?: string }).hostUserId,
                    hostName: (c as { hostUserId?: string }).hostUserId
                      ? userCache.get((c as { hostUserId?: string }).hostUserId as string) ||
                        (c as { hostUserId?: string }).hostUserId
                      : undefined,
                    gongUrl: c.gongUrl,
                  })),
                  formatted,
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
