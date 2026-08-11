import { Response } from "express";
import { AuthedRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { openCyprusCompletion } from "../services/cyprus.service";

// Cyprus AI assistant endpoints. Any authenticated user can use it - it
// only touches the text in the request body and never reads tickets/DB.
export const cyprusController = {
  // POST /ai/cyprus/refine
  // body: { description: string, title?: string }
  //
  // Streams the LLM's output back as text/plain, token by token, so the
  // frontend can show the two polished versions "typing" live. Ollama
  // sends NDJSON lines (each { message: { content: "..." } }), which we
  // forward as raw text. The frontend splits the finished text on the
  // "Version 1:" / "Version 2:" markers into the two suggestion cards.
  refineDescription: asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { description, title } = req.body as { description: string; title?: string };

    // Fails (with a JSON 502) BEFORE any headers are sent if the LLM server
    // is unreachable, so the frontend still gets a clean error response.
    const { upstream } = await openCyprusCompletion({ description, title });

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // Critical for streaming through nginx: without this (or nginx
    // proxy_buffering off) nginx buffers the whole response and the browser
    // only sees it at the very end, killing the live-typing effect.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Stop pulling from Ollama if the browser closes the connection early.
    // NOTE: must watch res (not req) and guard with writableEnded - req's
    // "close" fires as soon as the POST body is fully received (keep-alive),
    // which would abort the stream prematurely.
    res.on("close", () => {
      if (!res.writableEnded) upstream.body?.cancel?.().catch(() => {});
    });

    // The OpenAI-compatible endpoint emits SSE frames like
    //   data: {"choices":[{"delta":{"content":"..."}}]}
    // with the occasional "data: [DONE]". Plain NDJSON (Ollama /api/chat
    // style with {message:{content}}) is also tolerated for flexibility.
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      const data = line.startsWith("data:") ? line.slice(5).trim() : line;
      if (!data || data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const delta =
          (json?.choices?.[0]?.delta?.content as string | undefined) ??
          (json?.message?.content as string | undefined);
        if (delta) res.write(delta);
      } catch {
        // Partial/malformed line - never let one bad frame kill the stream.
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // NDJSON frames can straddle TCP chunks, so consume whole lines and
        // keep any trailing partial line in the buffer.
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
        }
      }
      if (buffer.trim()) handleLine(buffer); // final line (done: true)
      res.end();
    } catch {
      res.end(); // client gone or upstream dropped - nothing more to send
    }
  }),
};
