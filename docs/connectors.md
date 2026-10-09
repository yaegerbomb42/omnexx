# Connectors

Connect omnexx to the apps you use, so the agent can read your mail, file a Linear issue or
check Sentry while it works. Every connector is free: omnexx talks to the app's MCP server
directly, with no paid broker in between.

```bash
omnexx connect                 # list the apps and which are connected
omnexx connect notion          # opens your browser to sign in
omnexx connect github --set Authorization=<personal access token>
omnexx disconnect notion       # removes it and forgets the sign-in
```

In the app: `/apps`, `/apps notion`, `/apps github --set Authorization=<token>`.

## How each kind signs in

| Kind                   | Apps                                                                                                                                                    | What happens                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser sign-in        | Notion, Linear, Jira and Confluence, GitLab, Sentry, Supabase, Vercel, Cloudflare, Stripe, PayPal, Intercom, monday.com, Figma, Canva, Todoist, Dropbox | The vendor hosts the server. omnexx registers itself, opens the sign-in page, and keeps the tokens in `~/.config/omnexx/mcp-oauth.json` (0600). Tokens refresh on their own; a run never stops to ask.          |
| Token                  | GitHub, Slack, Airtable, Trello, Discord, HubSpot                                                                                                       | You paste a token once (where to get it is shown). It goes into `mcp-secrets.json` (0600); the config only names it.                                                                                            |
| Your own Google client | Gmail, Google Calendar, Drive, Docs, Sheets                                                                                                             | Runs the `workspace-mcp` server locally with an OAuth client you create in Google Cloud (free, about 5 minutes; `omnexx connect gmail` prints the steps). Google signs you in the first time the agent uses it. |
| No setup               | Outlook / Microsoft 365, Shopify developer docs                                                                                                         | A local server; Microsoft asks for a device-code sign-in on first use.                                                                                                                                          |

Figma and Vercel may only accept sign-ins from apps they have approved. If one refuses, use
the vendor's local server through `omnexx mcp add`.

## Why Google needs your own client

Google treats Gmail access as a restricted scope. A shared app would need Google's paid
security review before anyone outside a 100-person test list could sign in. Your own client
skips that: it is free and only ever signs in you.

## Anything else

`omnexx mcp add <name>` searches the official MCP registry for every other server.
Connectors are MCP servers under `[mcp.servers.<name>]`, so `omnexx mcp list` and
`omnexx mcp test <name>` work on them too. Remote servers with `oauth = true` take
`oauth_client_id` and `oauth_scope` for servers that need a pre-registered client.
