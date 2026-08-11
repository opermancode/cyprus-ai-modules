import { AppError } from "../middleware/errorHandler";

// ---------------------------------------------------------------------------
// Cyprus — self-hosted AI writing assistant for the ticket description box.
//
// Talks to an OpenAI-compatible `/v1/chat/completions` endpoint with
// `stream: true`. In dev and prod that is normally Ollama (defaults to
// http://localhost:11434/v1 when the model runs on the same box as the app,
// or the configured URL when it lives on a separate server). The model
// config is env-driven:
//
//   LLM_BASE_URL  e.g. http://localhost:11434/v1   (or a remote server URL)
//   LLM_MODEL     e.g. qwen2.5:1.5b, llama3.2:3b, ...
//
// The response is streamed token-by-token so the frontend can show the text
// "typing" live, like a copilot. The model is asked to emit two polished
// versions prefixed with "Version 1:" / "Version 2:" plus a short suggested
// title prefixed with "Title Suggestion:"; the controller forwards the raw
// stream, and the frontend (and this module's parseCyprusStream) split the
// finished text into the two suggestions + suggested title.
//
// No ticket or user data ever leaves the network - the request contains only
// the description text the user typed in the form.
// ---------------------------------------------------------------------------

const DEFAULT_LLM_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_LLM_MODEL = "qwen2.5:1.5b";

// Generous timeout: on CPU-only boxes small models can take a while for
// a couple of sentences. Bumped up for slow self-hosted hardware.
const LLM_REQUEST_TIMEOUT_MS = 120_000;

// Long descriptions are truncated before hitting the model: small models
// degrade sharply on huge prompts, and the key facts are almost always in
// the first few thousand characters. The prompt tells the model it was
// truncated so it does not hallucinate the rest.
const MAX_INPUT_CHARS = 4000;
// Allow the model enough output room for two versions + a title on big inputs
// (Ollama's default output cap can cut the stream off mid-way otherwise).
const MAX_OUTPUT_TOKENS = 2048;

export interface CyprusRefineInput {
  description: string;
  title?: string;
}

function buildPrompt(title: string | undefined, description: string) {
  const system = [
    "You are Cyprus, a concise AI writing assistant embedded in a helpdesk ticket form.",
    "You help users turn their raw, informal issue description into clear, professional text.",
    "Given the user's description, produce EXACTLY TWO rewritten versions of the description.",
    "Version 1: fix grammar, spelling, punctuation and flow while keeping the user's own words and tone.",
    "Version 2: a more professional, polished version that keeps every factual detail.",
    "Also propose a short, clear ticket title that captures the issue in a few words.",
    "Do NOT invent facts, numbers, names or actions that are not in the original text.",
    "If the description is short, keep each version about the same length. If the description is long, condense it to the essential facts so each version stays concise (under 120 words).",
    "The title must be at most 100 characters.",
    "Write in English only, unless the user's description is in another language, in which case use that same language. Never switch to Chinese, Japanese, Korean or any other script.",
    "Format the output as exactly three sections. Start the first with the exact prefix 'Version 1:', the second with the exact prefix 'Version 2:', and the third with the exact prefix 'Title Suggestion:'. Do not output anything else.",
  ].join(" ");

  let desc = description;
  let truncated = false;
  if (desc.length > MAX_INPUT_CHARS) {
    desc = desc.slice(0, MAX_INPUT_CHARS);
    truncated = true;
  }

  const user = [
    title ? `Ticket title: ${title}` : "",
    "Description to refine:",
    desc,
    truncated
      ? "(Note: the original description was longer than the first 4000 characters; only the beginning was provided above. Do not mention this in the output.)"
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { system, user };
}

/**
 * Opens a streaming chat completion against the configured LLM and returns
 * the upstream Response once the connection is established and verified.
 * The caller then reads `upstream.body` (NDJSON lines, Ollama format) and
 * forwards the deltas. Throws AppError(502) if the LLM server is unreachable
 * or returns an HTTP error - which happens BEFORE any response is sent to
 * the browser, so the controller can still reply with a JSON error.
 */
export async function openCyprusCompletion({
  description,
  title,
}: CyprusRefineInput): Promise<{ upstream: Response; model: string }> {
  const baseUrl = (process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL).replace(/\/+$/, "");
  const model = process.env.LLM_MODEL || DEFAULT_LLM_MODEL;

  if (!description || description.trim().length === 0) {
    throw new AppError("Description is required to refine", 400);
  }

  const { system, user } = buildPrompt(title, description.trim());

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // AbortSignal.timeout guards against a hung/half-dead model server.
      signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: true,
        temperature: 0.5,
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
    });
  } catch (err) {
    const msg =
      err instanceof Error && err.name === "TimeoutError"
        ? "Cyprus timed out generating suggestions"
        : `Cyprus could not reach the LLM server (${baseUrl})`;
    throw new AppError(`${msg}. Check LLM_BASE_URL/LLM_MODEL and that Ollama is running.`, 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    throw new AppError(
      `Cyprus LLM server returned ${upstream.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      502
    );
  }
  if (!upstream.body) {
    throw new AppError("Cyprus LLM server returned an empty stream", 502);
  }

  return { upstream, model };
}

// Strips surrounding markdown noise (bold/italic/code/tick markers, heading
// hashes, blockquote) and stray whitespace from an extracted segment. Small
// models frequently wrap the labels as "**Version 1:**" or "# Version 1:".
function cleanSegment(s: string): string {
  return s
    .trim()
    .replace(/^[*_`>#~\s]+/, "")
    .replace(/[*_`>#~\s]+$/, "")
    .trim();
}

// CJK / Hangul / kana ranges - the small multilingual model occasionally
// slips into Chinese for the title or a version. Anything containing these
// characters is dropped rather than offered to the user.
const FOREIGN_SCRIPT_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

function hasForeignScript(text: string): boolean {
  if (!text) return false;
  const matches = text.match(FOREIGN_SCRIPT_RE);
  return matches !== null && matches.length >= 2;
}

export interface CyprusStreamResult {
  suggestions: string[];
  suggestedTitle?: string;
}

/**
 * Splits the finished streamed text (which contains "Version 1:", "Version 2:"
 * and a trailing "Title Suggestion:" section) into up to two clean description
 * suggestions plus the suggested title. Tolerates missing markers (including
 * markdown-wrapped ones like "**Version 1:**") and falls back to splitting the
 * text in two when no markers are found. Returns no title if the marker is
 * absent.
 */
export function parseCyprusStream(text: string): CyprusStreamResult {
  const trimmed = text.trim();
  if (!trimmed) return { suggestions: [] };

  let body = trimmed;
  let suggestedTitle: string | undefined;

  // Pull the trailing "Title Suggestion:" section out of the body, allowing
  // markdown markers around the label (e.g. "**Title Suggestion:** ...").
  const titleMatch = body.match(/[*_`>#~\s]*Title\s+Suggestion\s*:[*\s]*([\s\S]*)/i);
  if (titleMatch) {
    const t = cleanSegment(titleMatch[1]);
    if (t && !hasForeignScript(t)) suggestedTitle = t;
    body = body.slice(0, titleMatch.index ?? body.length);
  }

  // Markdown markers around "Version N:" are consumed by the split so they
  // never leak into the extracted segments as stray "**" prefixes. Versions
  // that slipped into a foreign script are filtered out.
  const segments = body
    .split(/[*_`>#~\s]*Version\s*[12]\s*:[*\s]*/i)
    .map(cleanSegment)
    .filter((s) => s.length > 0 && !hasForeignScript(s));

  let suggestions: string[];
  if (segments.length >= 2) {
    suggestions = segments.slice(0, 2);
  } else if (segments.length === 1) {
    suggestions = [segments[0]];
  } else {
    // No markers at all - split the text roughly in half on a word boundary.
    const mid = Math.floor(body.length / 2);
    let cut = body.lastIndexOf(" ", mid);
    if (cut === -1) cut = mid;
    const first = body.slice(0, cut).trim();
    const second = body.slice(cut).trim();
    suggestions = [first, second].filter(Boolean).slice(0, 2);
  }

  return { suggestions, suggestedTitle };
}
