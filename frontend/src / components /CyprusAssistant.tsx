import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import { Sparkles, Loader2, X, Check, RotateCcw, AlertTriangle } from "lucide-react";
import API_BASE from "../lib/api";

interface CyprusAssistantProps {
  description: string;
  title?: string;
  token: string;
  onSelect: (text: string) => void;
  onTitleSelect?: (title: string) => void;
}

// Imperative API used by TicketForm for the Ctrl+/ magic polish shortcut -
// rewrites the description directly in the box without showing the panel.
export interface CyprusAssistantHandle {
  polishDirect: () => void;
}

// Strip surrounding markdown noise (bold/italic/code/tick markers, heading
// hashes, blockquote) from an extracted segment - small models frequently
// wrap the labels as "**Version 1:**" or "# Version 1:".
function cleanSegment(s: string): string {
  return s
    .trim()
    .replace(/^[*_`>#~\s]+/, "")
    .replace(/[*_`>#~\s]+$/, "")
    .trim();
}

// CJK / Hangul / kana ranges - the small multilingual model occasionally
// slips into Chinese. Anything containing these characters is dropped.
const FOREIGN_SCRIPT_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

function hasForeignScript(text: string): boolean {
  if (!text) return false;
  const matches = text.match(FOREIGN_SCRIPT_RE);
  return matches !== null && matches.length >= 2;
}

// Split the finished streamed text into the two description versions plus an
// optional "Title Suggestion:" section (mirrors backend parseCyprusStream).
function parseStream(text: string): { suggestions: string[]; suggestedTitle?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { suggestions: [] };

  let body = trimmed;
  let suggestedTitle: string | undefined;
  const titleMatch = body.match(/[*_`>#~\s]*Title\s+Suggestion\s*:[*\s]*([\s\S]*)/i);
  if (titleMatch) {
    const t = cleanSegment(titleMatch[1]);
    if (t && !hasForeignScript(t)) suggestedTitle = t;
    body = body.slice(0, titleMatch.index ?? body.length);
  }

  const segments = body
    .split(/[*_`>#~\s]*Version\s*[12]\s*:[*\s]*/i)
    .map(cleanSegment)
    .filter((s) => s.length > 0 && !hasForeignScript(s));

  let suggestions: string[];
  if (segments.length >= 2) suggestions = segments.slice(0, 2);
  else if (segments.length === 1) suggestions = [segments[0]];
  else {
    const mid = Math.floor(body.length / 2);
    let cut = body.lastIndexOf(" ", mid);
    if (cut === -1) cut = mid;
    suggestions = [body.slice(0, cut).trim(), body.slice(cut).trim()].filter(Boolean).slice(0, 2);
  }

  return { suggestions, suggestedTitle };
}

// Cyprus AI — sits in the corner of the ticket description box. The user
// types their issue, then clicks Cyprus, which asks the self-hosted LLM to
// return two polished versions of the description. Clicking one autofills
// the box, then Cyprus asks whether it should also fill in a title derived
// from the description (or leave the title as it is). There is deliberately
// no free-form chat - it's pick-a-suggestion only. The backend streams the
// text back token-by-token, so the panel renders the output "typing" live.
export const CyprusAssistant = forwardRef<CyprusAssistantHandle, CyprusAssistantProps>(
  function CyprusAssistant({ description, title, token, onSelect, onTitleSelect }, ref) {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [streamingText, setStreamingText] = useState("");
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [suggestedTitle, setSuggestedTitle] = useState<string | null>(null);
    // Set once the user picks a description version while a title suggestion is
    // still pending - swaps the panel to the "add this title?" question.
    const [pendingTitle, setPendingTitle] = useState(false);
    const [error, setError] = useState("");
    const [hint, setHint] = useState("");
    const panelRef = useRef<HTMLDivElement>(null);
    const streamRef = useRef<AbortController | null>(null);
    // When true (set by polishDirect), the finished Version 1 is written
    // straight into the description box and the panel stays closed.
    const directRef = useRef(false);

    // Close the panel on outside click so it doesn't linger over the form.
    useEffect(() => {
      if (!open) return;
      const onMouseDown = (e: MouseEvent) => {
        if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
      };
      document.addEventListener("mousedown", onMouseDown);
      return () => document.removeEventListener("mousedown", onMouseDown);
    }, [open]);

    // Abort an in-flight stream if the component unmounts.
    useEffect(() => () => streamRef.current?.abort(), []);

    const canRefine = description.trim().length >= 10;

    const askCyprus = async (applyDirect = false) => {
      if (!canRefine) {
        setHint("Please write a little more in the description (at least 10 characters) before asking Cyprus.");
        return;
      }
      setHint("");
      setError("");
      setLoading(true);
      setSuggestions([]);
      setSuggestedTitle(null);
      setPendingTitle(false);
      setStreamingText("");
      if (!applyDirect) setOpen(true);

      const controller = new AbortController();
      streamRef.current = controller;
      try {
        const res = await fetch(`${API_BASE}/ai/cyprus/refine`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ description: description.trim(), title: title?.trim() || undefined }),
          signal: controller.signal,
        });

        // Non-OK responses come back as a small JSON error object.
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error || "Cyprus could not generate suggestions");
        }

        // The body is a raw text stream (text/plain), read it chunk by chunk
        // and render it live so the output appears to "type" itself.
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let full = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          full += decoder.decode(value, { stream: true });
          setStreamingText(full);
        }
        const { suggestions: s, suggestedTitle: t } = parseStream(full);
        // Magic-poland mode: write Version 1 straight into the description box.
        if (applyDirect) {
          if (s.length > 0) onSelect(s[0]);
          return;
        }
        setSuggestions(s);
        setSuggestedTitle(t ?? null);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Cyprus could not generate suggestions");
      } finally {
        setLoading(false);
        streamRef.current = null;
      }
    };

    // Kept in a ref so the imperative handle always calls the latest closure
    // (description/title/token change on every keystroke, not just mount).
    const polishDirectRef = useRef<() => void>(() => {});
    polishDirectRef.current = () => {
      if (loading) return;
      void askCyprus(true);
    };

    useImperativeHandle(ref, () => ({ polishDirect: () => polishDirectRef.current() }), []);

  // A version was picked: autofill the description, then (if a title
  // suggestion exists) ask whether to apply it too instead of closing.
  const useSuggestion = (text: string) => {
    onSelect(text);
    if (suggestedTitle && onTitleSelect) {
      setSuggestions([]);
      setPendingTitle(true);
    } else {
      setOpen(false);
      setSuggestions([]);
      setSuggestedTitle(null);
      setStreamingText("");
    }
  };

  const applySuggestedTitle = () => {
    if (suggestedTitle && onTitleSelect) onTitleSelect(suggestedTitle);
    setOpen(false);
    setSuggestions([]);
    setSuggestedTitle(null);
    setPendingTitle(false);
    setStreamingText("");
  };

  const keepCurrentTitle = () => {
    setOpen(false);
    setSuggestions([]);
    setSuggestedTitle(null);
    setPendingTitle(false);
    setStreamingText("");
  };

  return (
    <div className="absolute top-1.5 right-1.5 z-20" ref={panelRef}>
      {/* Corner button - icon only, "Cyprus" label fades in on hover. */}
      <button
        type="button"
        onClick={() => askCyprus(false)}
        disabled={loading}
        title="Ask Cyprus to polish your description"
        className={`group inline-flex items-center px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-all cursor-pointer shadow-sm ${
          open || suggestions.length > 0
            ? "bg-red-600 text-white hover:bg-red-700"
            : "bg-red-50 text-red-700 hover:bg-red-100 border border-red-200"
        } disabled:opacity-60 disabled:cursor-wait`}
      >
        {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
        <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 group-hover:ml-1.5 group-hover:max-w-[7rem] group-hover:opacity-100">
          {loading ? "Polishing..." : "Cyprus"}
        </span>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1.5 w-[340px] max-w-[calc(100vw-2rem)] bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 bg-slate-50">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-red-700 uppercase tracking-wide">
              <Sparkles size={12} />
              Cyprus Suggestions
            </span>
            <button
              type="button"
              onClick={() => {
                streamRef.current?.abort();
                setOpen(false);
              }}
              className="text-slate-400 hover:text-slate-600 cursor-pointer"
              title="Close"
            >
              <X size={14} />
            </button>
          </div>

          <div className="p-2.5 space-y-2 max-h-64 overflow-y-auto">
            {hint && (
              <div className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
                <AlertTriangle size={13} className="shrink-0 mt-px" />
                {hint}
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-2">
                <AlertTriangle size={13} className="shrink-0 mt-px" />
                <span>{error}</span>
              </div>
            )}

            {/* Live "typing" view while the stream is still flowing. */}
            {loading && !error && (
              <div>
                <div className="flex items-center gap-2 text-[11px] text-slate-500 py-1">
                  <Loader2 size={13} className="animate-spin text-red-600" />
                  Cyprus is reviewing your description...
                </div>
                {streamingText && (
                  <p className="text-[11px] leading-relaxed text-slate-700 whitespace-pre-wrap bg-red-50/40 border border-red-100 rounded-lg p-2.5">
                    {streamingText}
                    <span className="inline-block w-1.5 h-3 bg-red-500 animate-pulse align-middle ml-0.5" />
                  </p>
                )}
              </div>
            )}

            {/* Finished suggestions, one card per version. */}
            {!loading && !pendingTitle && suggestions.length > 0 && (
              <>
                <p className="text-[10px] text-slate-400 px-0.5">
                  Choose one to replace the description
                  {suggestedTitle && " (then Cyprus can also suggest a title)"}
                </p>
                {suggestions.map((s, i) => (
                  <div
                    key={i}
                    className="group border border-slate-200 rounded-lg p-2.5 hover:border-red-300 hover:bg-red-50/50 transition-colors"
                  >
                    <p className="text-[11px] leading-relaxed text-slate-700 whitespace-pre-wrap">{s}</p>
                    <div className="flex items-center justify-end mt-2">
                      <button
                        type="button"
                        onClick={() => useSuggestion(s)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-red-600 hover:bg-red-700 text-white text-[10px] font-semibold transition-colors cursor-pointer"
                      >
                        <Check size={11} />
                        Use this
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => askCyprus(false)}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-[11px] text-slate-600 font-semibold transition-colors cursor-pointer"
                >
                  <RotateCcw size={11} />
                  Regenerate
                </button>
              </>
            )}

            {/* After picking a version: ask whether to also use the title. */}
            {!loading && pendingTitle && suggestedTitle && (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold text-slate-700 flex items-center gap-1.5">
                  <Sparkles size={12} className="text-red-600" />
                  Add this title too?
                </div>
                <div className="border border-red-200 bg-red-50/50 rounded-lg px-2.5 py-2 text-[11px] leading-relaxed text-slate-700 font-medium">
                  {suggestedTitle}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={applySuggestedTitle}
                    className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-[10px] font-semibold transition-colors cursor-pointer"
                  >
                    <Check size={11} />
                    Yes, use this title
                  </button>
                  <button
                    type="button"
                    onClick={keepCurrentTitle}
                    className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50 text-[11px] text-slate-600 font-semibold transition-colors cursor-pointer"
                  >
                    No, keep mine
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
  }
);
