# Cyprus AI — Ticket Description Assistant

Feature summary, changed/added files, and production setup steps.

---

## 1. What the feature does

In the **Ticket Form → Description** box, a red **Cyprus** button appears in the top-right corner. After the user types their issue description, they click it and the self-hosted LLM (Ollama) returns **two polished versions** of the description (grammar-fixed and professional tone). The user clicks one and it autofills the description box. Cyprus then asks whether it should **also fill in a suggested title** derived from the description (the LLM emits a "Title Suggestion:" section) — the user can accept it or keep their own title. No chat, no external data transfer — only the typed text is sent to the company's own LLM server.

The backend **streams** the LLM's text back token-by-token (`text/plain`), so the two versions appear to "type" themselves live in the panel instead of waiting for the whole response.

API flow: browser → `/api/ai/cyprus/refine` → (nginx `/api` → backend :3000) → Ollama `/v1/chat/completions`.

---

## 2. Files added (new)

| File | Purpose |
|---|---|
| `backend/src/services/cyprus.service.ts` | Builds the prompt (2 polished description versions **+ a suggested title**, max 100 chars) and opens a **streaming** completion against the LLM (`{LLM_BASE_URL}/chat/completions`, `stream: true`). Returns the upstream `Response` for the controller to forward. Exports `openCyprusCompletion` (throws clean `502` on LLM failure, 120s timeout) and `parseCyprusStream` (splits finished text into `{ suggestions, suggestedTitle }` — tolerant of markdown-wrapped labels like `**Version 1:**`). |
| `backend/src/controllers/cyprus.controller.ts` | `POST /ai/cyprus/refine` handler. Reads the Ollama stream, extracts text deltas and **forwards them to the browser live** (`text/plain`, flush per chunk). Also sets `X-Accel-Buffering: no` so nginx does not buffer the stream. Aborts the upstream pull if the browser disconnects (via `res.on("close")` guarded by `writableEnded`). |
| `backend/src/routes/cyprus.ts` | Route registration: `requireAuth` → `cyprusLimiter` → zod validation → controller. |
| `frontend/src/components/CyprusAssistant.tsx` | The UI: red corner button + popover panel. Reads the stream with a fetch reader, renders the raw text "typing" live, then splits it into 2 suggestion cards + a suggested title. Picking a version autofills the description, then Cyprus asks "Add this title too?" with **Yes, use this title** / **No, keep mine**. "Regenerate", loading & error states, outside-click close, abort on close/unmount. |

### 2.1 Title-suggestion flow (added later)

- The LLM now emits a third section prefixed `Title Suggestion:` (short title, ≤ 100 chars, derived from the description). It appears as the trailing section of the streamed text.
- The frontend parses it out, and after the user picks a description version it shows the "Add this title too?" prompt instead of closing the panel.
- `TicketForm.tsx` wires it via the new `onTitleSelect` prop → `setNewTicketTitle`.
- If the model omits the marker, `suggestedTitle` is simply `undefined` and the prompt never appears (graceful degradation).
- **Non-English output guard:** the small multilingual model (e.g. `qwen2.5:1.5b`) occasionally slips into Chinese for the title. Two defenses: the system prompt now demands "English only (or the description's language), never Chinese/Japanese/Korean", and both parsers filter out any version or title containing ≥ 2 CJK/Hangul/kana characters (`hasForeignScript`), so a bad segment is never offered to the user.
- **Long descriptions:** descriptions over **4,000 chars** (`MAX_INPUT_CHARS`) are truncated before reaching the model (small models degrade on huge prompts; the key facts are in the beginning), and the prompt tells the model it was truncated so it doesn't invent the rest. The length instruction is adaptive — short inputs keep their length, long ones are condensed to the essential facts. The request sets `max_tokens: 2048` so the stream isn't cut off mid-version on big inputs.
- **`Ctrl+/` magic polish (both button + shortcut work):** besides the Cyprus button (panel with 2 selectable versions), pressing **Ctrl+/** while focused in the description box triggers `polishDirect()` on the assistant (`useImperativeHandle` via a `forwardRef`) — it calls the same endpoint, skips the panel, and writes Version 1 straight into the description box. Wired in `TicketForm.tsx` (`onKeyDown`, `e.ctrlKey && e.key === "/"` + `e.preventDefault()`); the existing button flow is unchanged.

### 2.1 Streaming format notes (changed during dev)

The OpenAI-compatible endpoint (`/v1/chat/completions`, used via `LLM_BASE_URL`) emits SSE frames:
```
data: {"choices":[{"index":0,"delta":{"content":"Version 1: ..."},"finish_reason":null}]}
```
- Each frame is prefixed `data: ` and ends with `data: [DONE]`.
- The controller tolerates both this and plain NDJSON (`{message:{content}}`) — see `handleLine`.
- The controller returns `text/plain` (not SSE) — the frontend just reads the stream and accumulates text.
- **Stream-format bug found & fixed during dev:** the first streaming version parsed `json.message.content`, but Ollama's OpenAI-compatible endpoint uses `choices[0].delta.content` — so nothing was forwarded. Also, aborting on `req.on("close")` killed the stream immediately (that event fires once the POST body is fully received on keep-alive); the fix is `res.on("close")` with a `!res.writableEnded` guard.

## 3. Files edited (changed)

| File | Change |
|---|---|
| `backend/src/index.ts` | Imported + mounted `cyprusRouter` at `/ai`. |
| `backend/src/utils/schemas.ts` | Added `cyprusRefineSchema` (`description` 10–10000 chars, optional `title`). |
| `backend/src/middleware/rateLimiter.ts` | Added `cyprusLimiter` (6 generations/min per user) so one user cannot flood the model server. |
| `backend/.env.example` | Documented `LLM_BASE_URL` and `LLM_MODEL`. |
| `frontend/src/components/TicketForm.tsx` | Wrapped description box in a `relative` container and rendered `<CyprusAssistant/>` bound to `newTicketDesc` / `newTicketTitle` / `token`. |

## 4. Pre-existing bug fixes made during this work (must also go to prod)

| File | Change |
|---|---|
| `frontend/src/components/BulkInvitePreviewmodal.tsx` → `BulkInvitePreviewModal.tsx` | Renamed file (case mismatch with import in `Invitation.tsx`) — was breaking the Vite build on Linux. |
| `backend/src/utils/ticketBulkUpload.ts` | Added `agents: { email: string }[]` to `TemplateReferenceData` interface — fixed a TypeScript compile error that blocked the backend from starting. |

## 5. Dev-only changes (do NOT take to prod as-is)

| File | Change | Prod note |
|---|---|---|
| `frontend/src/lib/api.ts` | `dev = true`, base = `/api` | **Must flip back to `dev = false`** before the prod frontend build (returns to `https://customerpulse.sanghvimovers.com/api`). |
| `frontend/vite.config.ts` | Added dev proxy `/api` → `http://localhost:3000` | Dev-only. Prod uses nginx instead. |
| `backend/src/lib/s3.ts` + `.env` | `LOCAL_BASE_URL` now reads `PUBLIC_API_BASE_URL` env | Set it correctly in prod (`https://customerpulse.sanghvimovers.com/api`) — prod default already matches, so no action needed. |
| `ecosystem.config.cjs` | pm2 config for local dev | Local convenience, not needed on prod. |

---

## 6. Production setup steps

### 6.1 Install + configure Ollama (the model server)
On the LLM server (same box as the app, or a dedicated server):

> Full step-by-step: see **`OLLAMA_INSTALL_UBUNTU.md`** in the same folder
> (install script, model pull, systemd, security, parallelism, GPU, ops).

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5:7b        # or llama3.1:8b — pick per hardware
```

For concurrent users, raise Ollama parallelism (edit the unit file):

```bash
sudo systemctl edit ollama
# add:
#   Environment="OLLAMA_NUM_PARALLEL=4"
sudo systemctl restart ollama
```

### 6.2 Backend env vars (`backend/.env`)
```env
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen2.5:7b
```
- Same server as app → `http://localhost:11434/v1`
- Separate server → `http://<your-llm-host>:<port>/v1`

### 6.3 Deploy the code
1. Pull the updated backend + frontend code on the prod servers.
2. Backend: `npm install && npm run prisma:generate && npm run build && npm start` (port 3000).
3. Frontend: flip `const dev = false` in `src/lib/api.ts`, then `npm run build` and serve the `dist/` output via nginx.
4. nginx already maps `/api/*` → `http://localhost:3000` — so `/api/ai/cyprus/refine` works with **no nginx change**. Streaming works because the controller sets `X-Accel-Buffering: no` (nginx turns off response buffering for that response without any config edit).

### 6.4 Verify
```bash
curl -s -X POST https://customerpulse.sanghvimovers.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<admin>","password":"<pass>"}'   # grab token

curl -s -N -X POST https://customerpulse.sanghvimovers.com/api/ai/cyprus/refine \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"description":"the crane battery is dead so it wont start"}'
# expect: streamed plain text, e.g.
#   Version 1: The crane battery is dead, so the crane will not start.
#   Version 2: The crane cannot be started because its battery has died.
#   Title Suggestion: Crane fails to start - dead battery
# (Use -N / --no-buffer to see tokens arrive live.)
```

---

## 7. Hardware / concurrency notes

- Ollama queues requests by default (`OLLAMA_NUM_PARALLEL=1`); raising it allows N concurrent generations.
- Small CPU box (like this dev VM: 2 CPU / 3.8 GB RAM / no GPU): ~11s per suggestion, 1 user at a time, higher parallelism risks OOM.
- GPU or 16 GB+ RAM server: comfortably runs 4+ concurrent with an 8B model.
- The backend rate-limits Cyprus to 6 calls/min/user regardless of model server.



Added (new):

backend/src/services/cyprus.service.ts — streaming LLM call, prompt (2 versions + title), parseCyprusStream, CJK filter, truncation
backend/src/controllers/cyprus.controller.ts — POST /ai/cyprus/refine, forwards the live stream
backend/src/routes/cyprus.ts — route with requireAuth + cyprusLimiter + zod validation
frontend/src/components/CyprusAssistant.tsx — red button + panel UI, streaming consumer, title prompt
Changed (existing):

backend/src/index.ts — mounted the /ai router
backend/src/utils/schemas.ts — added cyprusRefineSchema
backend/src/middleware/rateLimiter.ts — added cyprusLimiter (6/min/user)
backend/.env.example — documented LLM_BASE_URL, LLM_MODEL
frontend/src/components/TicketForm.tsx — wired <CyprusAssistant/> + onTitleSelect
backend/.env (local only) — LLM_BASE_URL, LLM_MODEL, PUBLIC_API_BASE_URL
Docs (new):

/home/ubuntu/CYPRUS_AI_SETUP.md
/home/ubuntu/OLLAMA_INSTALL_UBUNTU.md
