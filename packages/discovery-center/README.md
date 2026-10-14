# SAP Discovery Center MCP Server

> Part of the [**sap-mcp-servers**](../../README.md) monorepo (npm workspaces), published to npm independently as `sap-discovery-center-mcp`.

MCP server for [SAP Discovery Center](https://discovery-center.cloud.sap) missions: guided, step-by-step implementation projects on SAP BTP. Searching the catalog and reading a mission need no login. Step instructions need an SAP login, which runs through the shared [`@marianfoo/sap-mcp-auth`](../auth/README.md) browser login.

## Important Warning

This project is unofficial and is not endorsed by SAP. It uses authenticated SAP Discovery Center web endpoints and browser session cookies in ways that may be restricted by SAP terms of service, SAP account terms, or your organization's policies. Use it at your own risk.

## Tools

| Tool | Login | What it returns |
| --- | --- | --- |
| `mission_search` | no | Missions matching a query: ID, name, type, products, description, URL. |
| `mission` | no | One mission by ID or name: use case, prerequisites, BTP services and its steps by phase. |
| `mission_step` | yes | The instructions of one step (`stepId` from `mission`) or of all steps. |

`mission_step` details:

- Discovery Center serves step texts only on a mission the user has started. A mission the user has already started is read as is. Any other mission is **started under the logged-in SAP account** and stays in that user's "My Missions": Discovery Center refuses to cancel it, and completing it would count as a completed mission. The next call reuses it.
- Every step comes back as markdown with absolute link and image URLs. Steps that link a GitHub file return that file's markdown; `source` keeps the link. Steps written in Discovery Center's editor are HTML and converted.
- `relatedMissions` lists the IDs of other missions a step links to, typically the per-application follow-up missions.

## Setup

Build from the repo root (`npm install && npm run build`), then copy `env.example` to a path outside the package and fill in `SAP_USERNAME` and `SAP_PASSWORD`. Set `SAP_ACCOUNT_PREFIX` when your email owns several SAP accounts.

Check the login once:

```bash
ENV_FILE=/absolute/path/to/.env npm run auth:login -w sap-discovery-center-mcp
```

`auth:login` opens a visible browser (`HEADFUL=true`) so you can complete MFA. Without MFA the login also works headless.

MCP client config:

```json
{
  "mcpServers": {
    "sap-discovery-center": {
      "command": "node",
      "args": ["/absolute/path/to/sap-mcp-servers/packages/discovery-center/dist/mcp-server.js"],
      "env": {
        "ENV_FILE": "/absolute/path/to/.env",
        "DISCOVERY_CENTER_TOKEN_CACHE_FILE": "/absolute/path/to/discovery-center-token-cache.json"
      }
    }
  }
}
```

## How it works

- The site sits behind an SAP approuter. Catalog calls go to `/platformx/api/v1` without a session. The login session is accepted only on `/protected/platformx/api/v1`, which every logged-in call uses.
- Writes (starting a mission) carry the approuter's CSRF token, fetched with `x-csrf-token: fetch`.
- A started mission gets its own step IDs. `mission_step` matches them to the catalog steps by phase and name, so step IDs from `mission` stay valid.
