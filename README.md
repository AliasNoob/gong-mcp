# Gong MCP Server

A Model Context Protocol (MCP) server that provides access to Gong's API for retrieving call recordings and transcripts. This server allows Claude to interact with Gong data through a standardized interface.

## Features

- List Gong calls with optional date range filtering
- Retrieve detailed transcripts for specific calls
- Secure authentication using Gong's API credentials
- Standardized MCP interface for easy integration with Claude
- Extended tools for detailed calls and user lookup

## Prerequisites

- Node.js 18 or higher
- Docker (optional, for containerized deployment)
- Gong API credentials (Access Key and Secret)

## Installation

### Local Development

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the project:
   ```bash
   npm run build
   ```

### Docker

Build the container:
```bash
docker build -t gong-mcp .
```

## Configuring MCP Clients (Claude, Codex VS Code, others)

Configure the Docker MCP gateway to run this server. Example entry (Claude Desktop / Codex / VS Code MCP):

```json
{
  "command": "docker",
  "args": [
    "run",
    "-i",
    "--rm",
    "gong-mcp"
  ],
  "env": {
    "GONG_ACCESS_KEY": "your_access_key_here",
    "GONG_ACCESS_SECRET": "your_access_secret_here",
    "GONG_USER_FULL_NAME": "Your Gong Full Name",
    "GONG_USER_ID": "optional_cached_user_id"
  }
}
```

Notes:
- Use `-i` (no TTY) for stdio MCP.
- Set env vars in the client config or `.env` (git-ignored). Keep secrets local.
- If `GONG_USER_ID` is not provided, the server resolves it once from `GONG_USER_FULL_NAME` and writes it to `.env` so subsequent runs skip the lookup.
- Codex/VS Code: ensure your Docker MCP gateway is connected; restart the client after updating envs.

## Available Tools

### List Calls

Retrieves a list of Gong calls with optional date range filtering.

```typescript
{
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
}
```

### List Calls Extensive

Retrieves detailed Gong calls via `/v2/calls/extensive` with optional date range, user filter (defaults to `GONG_USER_FULL_NAME`), and text filter. Includes participants, timestamps, duration, title, and Gong URL when available.

Inputs: `start_date`, `end_date`, `user_id` or `user_ids/userIds` array, `text` (customer/search text).

Returns: callId, title, started/ended timestamps, duration, participants (role/displayName/id), and a Gong URL.

### Activity Day By Day

Retrieves daily activity for users in a date range via `/v2/stats/activity/day-by-day` (returns attended/hosted call IDs and other stats).

Inputs: `fromDate` (YYYY-MM-DD inclusive), `toDate` (YYYY-MM-DD exclusive), optional `userIds` (defaults to resolved user), optional `cursor`.

Returns: Gong activity records including `callsAttended`, `callsAsHost`, and other per-day stats.

### My Calls Range

Lists calls you hosted or attended for a date range using day-by-day activity and enriches with call details (host name, URL).

Inputs: `fromDate` (YYYY-MM-DD inclusive), `toDate` (YYYY-MM-DD exclusive), optional `daysBack` (defaults to 5 when dates are omitted), optional `userIds` (defaults to resolved user).

Returns: callId, title, start time, duration, host name/id, Gong URL, plus a formatted summary list.

### My Calls Today

Lists today's calls for the default user using day-by-day activity (accurate attendance) and enriches each call with call details. Uses a cached `GONG_USER_ID` (auto-resolved once from `GONG_USER_FULL_NAME`).

Inputs: none.

Returns: date label, count, and a compact list of today's calls (callId, title, start time, duration, Gong URL).

### Get Users

Lists Gong users with optional `name_filter` (case-insensitive substring, applied locally). Returns userId, fullName, email.

### Retrieve Transcripts

Retrieves detailed transcripts for specified call IDs.

```typescript
{
  name: "retrieve_transcripts",
  description: "Retrieve transcripts for specified call IDs. Returns detailed transcripts including speaker IDs, topics, and timestamped sentences.",
  inputSchema: {
    type: "object",
    properties: {
      callIds: {
        type: "array",
        items: { type: "string" },
        description: "Array of Gong call IDs to retrieve transcripts for"
      }
    },
    required: ["callIds"]
  }
}
```

## License

MIT License - see LICENSE file for details

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request 
