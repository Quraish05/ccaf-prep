# MCP authorization + sampling — synthesis

Day 7 of the CCA-F prep. Two MCP topics that show up in "secure MCP" scenario questions: the **authorization spec** (how clients connect to OAuth-protected remote MCP servers) and the **sampling primitive** (how servers ask the client to run LLM completions). Synthesis here is grounded in [MCP spec 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18) — not training data.

The repo's `.mcp.json` wires Linear's remote MCP at `https://mcp.linear.app/sse`. Verification flow at the bottom.

## 1. Authorization

### When it applies
- **HTTP-based transports** (HTTP / SSE) — `SHOULD` conform to the auth spec.
- **stdio transport** — `SHOULD NOT` use this spec; pass credentials via environment variables instead.
- Authorization is **OPTIONAL** for MCP implementations as a whole. A server can serve everyone, or require OAuth.

### Roles
- **MCP server** → OAuth 2.1 *resource server*. Validates access tokens.
- **MCP client** (e.g. Claude Code) → OAuth 2.1 *client*. Obtains tokens on the user's behalf.
- **Authorization server** → separate concept from the MCP server; may be co-hosted or separate. Issues tokens.

### The full flow (load-bearing requirements)

The spec stitches together four RFCs. Memorise the role of each:

| RFC | Acronym | Role |
| --- | --- | --- |
| [draft-ietf-oauth-v2-1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13) | **OAuth 2.1** | Base authorization framework. Authorization Code + PKCE only — no implicit grant, no password grant. |
| [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) | **Protected Resource Metadata** | Server (`MUST`) advertises which authorization server issues its tokens. Discovered at `/.well-known/oauth-protected-resource`. |
| [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) | **AS Metadata** | Authorization server (`MUST`) advertises its endpoints + capabilities. Discovered at `/.well-known/oauth-authorization-server`. Client (`MUST`) use it. |
| [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) | **Dynamic Client Registration** | Client + AS `SHOULD` support DCR so the client can register itself without prior coordination. Falls back to hardcoded or user-supplied client IDs when unsupported. |
| [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html) | **Resource Indicators** | Client (`MUST`) include `resource=<canonical-server-uri>` in *both* authorize and token requests. Binds the issued token to a specific MCP server's audience. |

The first-connection dance Claude Code runs against an OAuth-protected MCP server:

```
1. Client → Server: MCP request (no token)
2. Server → Client: 401 Unauthorized + WWW-Authenticate header
                    (header points at /.well-known/oauth-protected-resource)
3. Client → Server: GET /.well-known/oauth-protected-resource
4. Server → Client: { "authorization_servers": ["https://as.example/..."] }
5. Client → AS:     GET /.well-known/oauth-authorization-server
6. AS → Client:     { "authorization_endpoint": "...", "token_endpoint": "...",
                      "registration_endpoint": "...", ... }
7. Client → AS:     POST /register     (Dynamic Client Registration, if supported)
8. AS → Client:     { client_id, [client_secret] }
9. Client generates PKCE (code_verifier + code_challenge) + a state value.
10. Client opens browser to AS authorize URL with:
       response_type=code, client_id, redirect_uri,
       code_challenge, code_challenge_method=S256, state,
       resource=https://mcp.linear.app    ← RFC 8707, MUST
11. User authorizes in browser.
12. AS → browser → Client localhost callback with ?code=...&state=...
13. Client → AS: POST /token with code + code_verifier + resource=...
14. AS → Client: access_token (+ refresh_token, +/- id_token)
15. Client → Server: MCP request with Authorization: Bearer <token>
16. Server validates audience claim — token must be for THIS server.
```

### Hard requirements worth committing to memory

- **PKCE is mandatory** for MCP clients (mitigates auth-code injection).
- **Resource parameter is mandatory** on *both* authorize and token requests — even if the AS doesn't appear to support it. Token audience-binding is the whole point.
- **Tokens go in `Authorization: Bearer`** — never in URI query strings.
- **Audience validation is mandatory** server-side. A server `MUST` reject tokens issued for a different audience.
- **No token passthrough** — if the MCP server makes upstream API calls, it `MUST NOT` reuse the client's token. It exchanges separately.
- **HTTPS-only** for all AS endpoints. Redirect URIs are either `localhost` or HTTPS.
- **State parameter** in the authorize step + exact-match redirect URIs prevent open-redirection and CSRF.

### Common exam traps
- "What is the client required to discover first?" → the **resource metadata** (RFC 9728) — that tells the client which AS to talk to. *Then* the AS metadata (RFC 8414).
- "Why is the resource parameter important?" → audience binding. Stops a token from one MCP server being replayed against a different one.
- "Can the MCP server forward the client's token to a downstream API?" → **No.** Explicitly forbidden (token passthrough → confused-deputy).
- "Is implicit grant allowed?" → **No.** OAuth 2.1 dropped it. MCP uses Authorization Code + PKCE.

## 2. Sampling

### What it is
Sampling lets an **MCP server request an LLM completion from the MCP client**. Direction is inverted vs the usual model: instead of the client calling a server tool, the server says "please run this prompt through your LLM and return the result". The server gets agentic capability without needing its own API key.

### Wire protocol
- Method: **`sampling/createMessage`** (JSON-RPC request from server to client).
- The client `MUST` declare `capabilities.sampling: {}` at session initialize for the server to use this.

**Request shape** (minimum useful):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "sampling/createMessage",
  "params": {
    "messages": [
      { "role": "user",
        "content": { "type": "text", "text": "..." } }
    ],
    "modelPreferences": {
      "hints": [{ "name": "claude-3-sonnet" }],
      "intelligencePriority": 0.8,
      "speedPriority": 0.5,
      "costPriority": 0.3
    },
    "systemPrompt": "You are a helpful assistant.",
    "maxTokens": 100
  }
}
```

- `messages` — required, array of role+content. Content can be `text`, `image` (base64), or `audio` (base64).
- `modelPreferences` — optional, all advisory. The client picks the actual model.
  - `hints[]` — model-name substrings; client maps them to an equivalent model from whatever provider it has. The server doesn't pick a model; it suggests.
  - `costPriority` / `speedPriority` / `intelligencePriority` — 0-1 normalized weights for the client's selection heuristic.
- `systemPrompt` — optional, advisory.
- `maxTokens` — optional cap.

**Response:** `{ role: "assistant", content: {...}, model: "<actual-model-used>", stopReason: "endTurn" | ... }`.

### Security model — the human-in-the-loop part
The spec is firm here. Clients `SHOULD`:
- Show the user the server's sampling request before honouring it.
- Let the user **view and edit the prompt** before forwarding to the LLM.
- Show the response to the user before returning it to the server.
- Implement rate-limiting per-server.
- Validate content on both sides.

The model is "the server cannot pull arbitrary completions out of your subscription without your consent". A naive client that auto-approves sampling requests turns the MCP session into a free LLM proxy for a possibly-untrusted server.

### When you'd use sampling
- The server wants to perform a multi-step reasoning task inside one of its tools (e.g. "summarise these 10 documents and pick the best one" — the summarise step is a sampling request).
- The server wants to delegate "creative" or "judgment" work to a model without shipping its own API key.
- Contrast with **tool calls**: tool calls are deterministic functions the client invokes. Sampling is the inverse — the server asks the client to invoke its LLM. Choose tool calls for explicit, named capabilities; choose sampling when the server wants generative ability mid-flow.

### Limitations
- The server **never picks the exact model** — only suggests via `hints` + priorities. The client may map a Claude hint to a Gemini equivalent.
- Sampling is **opt-in per client** — many clients (including some Claude Code / Claude Desktop versions) don't yet implement it. The server `SHOULD` degrade gracefully if the client didn't advertise the capability.
- Each call requires user approval (per the security model) — sampling-heavy designs add friction.

### Common exam traps
- "Who initiates a sampling request?" → **The server.** It's the inversion from normal MCP traffic.
- "Does the server choose the model?" → **No.** It can hint and prioritise; the client makes the final pick.
- "What's the safety control?" → **Human-in-the-loop approval** before the prompt goes to the LLM *and* before the response goes back to the server.
- "Why use sampling vs another tool call?" → Tool call = deterministic capability. Sampling = "I need an LLM to think for me right now, but I don't have one."

## 3. Verification — completing OAuth with Linear from Claude Code

The repo ships `.mcp.json` at root with Linear wired. To complete the flow:

```bash
# 1. From the repo root, launch Claude Code so it auto-loads .mcp.json
cd /Users/quraish/Desktop/QURAISH/SIDE_PROJECTS/cca-f-prep
claude

# 2. Inside the CLI, list MCP servers and connect to Linear
/mcp
```

What you'll see step by step:

1. Claude Code reads `.mcp.json` and finds the `linear` server.
2. It opens an SSE connection to `https://mcp.linear.app/sse`.
3. Linear responds with `401 Unauthorized` + a `WWW-Authenticate` header pointing at its resource metadata endpoint.
4. Claude Code follows the discovery chain (9728 → 8414), performs Dynamic Client Registration if the AS supports it, generates PKCE + state, and **opens your browser** to Linear's authorize URL.
5. You log in to Linear in the browser and click *Allow* to grant the requested scopes.
6. Linear redirects to Claude Code's local callback (typically `http://localhost:<port>/...`) with the auth code.
7. Claude Code exchanges code + PKCE verifier + the `resource=https://mcp.linear.app` parameter for an access token.
8. Token is stored (per-user, under your Claude Code config dir — not in this repo).
9. Subsequent `/mcp` calls show the `linear` server as **connected**, and Linear's tools (e.g. `create_issue`, `list_issues`) become available to Claude.

### Confirming it worked
- `/mcp` should list `linear` with status **connected** and show its advertised tools.
- Try asking Claude something Linear-specific, e.g. *"List my Linear issues assigned this week"*. It should call a Linear MCP tool, not refuse for lack of capability.
- The token cache lives outside the repo (Claude Code's config dir); the `.mcp.json` in-repo only points at the server — no secrets are committed.

### If you'd rather use Atlassian
Swap `linear` for the Atlassian remote MCP. The Atlassian remote endpoint at time of writing is `https://mcp.atlassian.com/v1/sse` (verify against the [current Atlassian blog post](https://www.atlassian.com/blog/announcements/remote-mcp-server) before relying on it). Replace the `url` in `.mcp.json` and you go through the same discovery → OAuth → bearer flow against Atlassian's IdP instead.

### What this exercises for the exam
- Discovery chain (401 → 9728 → 8414).
- Audience binding via `resource` (RFC 8707).
- PKCE flow end-to-end.
- Token storage outside the project tree.
- The non-trivial fact that the spec is a *composition* of five RFCs — not one.
