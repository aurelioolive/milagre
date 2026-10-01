import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComponentProps, KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  AiBrowserIcon,
  AiChat01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Attachment01Icon,
  AtIcon,
  Cancel01Icon,
  CommandIcon,
  File02Icon,
  Link01Icon,
  Mic01Icon,
  Search01Icon,
  SecurityCheckIcon,
  SlidersHorizontalIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { ModelOption, ModelProvider, PermissionMode } from "../model";
import { MODEL_CATALOG, PERMISSION_MODES } from "../model";
import type { ImageDraft } from "./usePastedImages";

type SpeechRecognitionResultLike = { [index: number]: { transcript: string } };
type SpeechRecognitionEventLike = Event & { results: { [index: number]: SpeechRecognitionResultLike } };
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

type IconData = ComponentProps<typeof HugeiconsIcon>["icon"];

function Icon({ icon, size = 15 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

type Source = { key: string; name: string; desc: string; icon: IconData };

const SOURCES: Source[] = [
  { key: "attach", name: "Add files", desc: "Upload from your computer", icon: Attachment01Icon },
  { key: "context", name: "Project context", desc: "Files, decisions, and shared records", icon: File02Icon },
  { key: "worktrees", name: "Worktrees", desc: "Coordinate connected worktrees", icon: Link01Icon },
  { key: "web", name: "Web search", desc: "Search current information", icon: AiBrowserIcon },
];

const COMMANDS = [
  { key: "summarize", name: "/summarize", desc: "Digest the thread so far" },
  { key: "blockers", name: "/blockers", desc: "Find blockers across worktrees" },
  { key: "plan", name: "/plan", desc: "Draft the next steps" },
  { key: "review", name: "/review", desc: "Review the current agent output" },
];

const FILES = ["project-context.md", "worktree-diff.patch", "agent-output.txt"];

function parseToken(draft: string): { kind: "at" | "slash"; query: string; start: number } | null {
  const match = /(^|\s)([@/])([\w-]*)$/.exec(draft);
  if (!match) return null;
  return { kind: match[2] === "@" ? "at" : "slash", query: match[3].toLowerCase(), start: match.index + match[1].length };
}

interface PromptComposerProps {
  imageDraft: ImageDraft;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSend: () => void;
  isSending: boolean;
  selectedModel: ModelOption;
  onModelChange: (model: ModelOption) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
}

export function PromptComposer({ imageDraft, draft, onDraftChange, onSend, isSending, selectedModel, onModelChange, permissionMode, onPermissionModeChange }: PromptComposerProps) {
  const [dismissed, setDismissed] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [provider, setProvider] = useState<ModelProvider>(selectedModel.provider);
  const [query, setQuery] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const [engaged, setEngaged] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [listening, setListening] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const modelRowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [rowBox, setRowBox] = useState<{ top: number; height: number } | null>(null);
  const [modelBox, setModelBox] = useState<{ top: number; height: number } | null>(null);
  const [modelHovered, setModelHovered] = useState<number | null>(null);

  const token = dismissed ? null : parseToken(draft);
  const menu: "at" | "slash" | null = plusOpen ? "at" : token?.kind ?? null;
  const tokenQuery = plusOpen ? "" : token?.query ?? "";
  const rows = menu === "at"
    ? SOURCES.filter((source) => source.name.toLowerCase().includes(tokenQuery))
    : menu === "slash"
      ? COMMANDS.filter((command) => command.name.slice(1).startsWith(tokenQuery))
      : [];
  const modelRows = MODEL_CATALOG.filter((model) => model.provider === provider && `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()));
  const canSend = draft.trim().length > 0 || imageDraft.images.length > 0;

  useEffect(() => {
    setActive(0);
    setEngaged(false);
  }, [menu, tokenQuery]);

  useLayoutEffect(() => {
    const target = rowRefs.current[active];
    if (target) setRowBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [active, menu, tokenQuery, rows.length]);

  useLayoutEffect(() => {
    if (!modelOpen) return;
    const target = modelRowRefs.current[modelHovered ?? MODEL_CATALOG.findIndex((model) => model.id === selectedModel.id)];
    if (target) setModelBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [modelOpen, modelHovered, selectedModel.id, modelRows.length]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const controls = controlsRef.current;
    const measure = measureRef.current;
    const modelButton = modelRef.current;
    if (!input || !controls || !measure || !modelButton) return;
    const fixedControlsWidth = 28 * 3 + modelButton.offsetWidth;
    const inlineInputWidth = controls.clientWidth - fixedControlsWidth - 16;
    const needsFullWidth = draft.includes("\n") || measure.offsetWidth + 8 > inlineInputWidth;
    if (needsFullWidth !== expanded) setExpanded(needsFullWidth);
    input.style.height = "0px";
    const contentHeight = input.scrollHeight;
    input.style.height = `${Math.min(Math.max(contentHeight, 28), 100)}px`;
    input.style.overflowY = contentHeight > 100 ? "auto" : "hidden";
  }, [draft, expanded, selectedModel.name]);

  useEffect(() => {
    if (!modelOpen && !plusOpen && !permissionOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest("[data-promptbar]")) {
        setModelOpen(false);
        setPlusOpen(false);
        setPermissionOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [modelOpen, plusOpen, permissionOpen]);

  function chooseModel(model: ModelOption) {
    onModelChange(model);
    setProvider(model.provider);
    setModelOpen(false);
    setQuery("");
    inputRef.current?.focus();
  }

  function toggleListening() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.lang = "pt-BR";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      if (transcript) onDraftChange(draft ? `${draft.trimEnd()} ${transcript}` : transcript);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  function pick(row: { key: string; name: string }) {
    const source = SOURCES.find((item) => item.key === row.key);
    if (source?.key === "attach") {
      setAttachments((current) => [...current, FILES[current.length % FILES.length]]);
      if (token) onDraftChange(draft.slice(0, token.start));
    } else if (menu === "at") {
      onDraftChange(`${token ? draft.slice(0, token.start) : draft}@${row.name} `);
    } else {
      onDraftChange(`${token ? draft.slice(0, token.start) : draft}${row.name} `);
    }
    setPlusOpen(false);
    setDismissed(false);
    inputRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (menu && rows.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setEngaged(true);
        setActive((current) => (current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        pick(rows[active]);
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
      setPlusOpen(false);
      setModelOpen(false);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend();
    }
  }

  return (
    <div data-promptbar className="w-full">
      <div className="relative">
        {menu && (
          <div onMouseLeave={() => setEngaged(false)} className="absolute inset-x-0 bottom-full z-20 mb-2 rounded-[10px] border border-line bg-surface p-1 shadow-raised" style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom center" }}>
            <span aria-hidden className="pointer-events-none absolute inset-x-1 rounded-[6px] bg-hover" style={{ top: rowBox?.top ?? 0, height: rowBox?.height ?? 0, opacity: rowBox && engaged ? 1 : 0, transition: "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease" }} />
            {rows.map((row, index) => {
              const source = menu === "at" ? SOURCES.find((item) => item.key === row.key) : undefined;
              return <button key={row.key} type="button" ref={(element) => { rowRefs.current[index] = element; }} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => { setActive(index); setEngaged(true); }} onClick={() => pick(row)} className="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2 text-left">
                {source && <span className="flex size-5.5 shrink-0 items-center justify-center text-ink-2"><Icon icon={source.icon} size={15} /></span>}
                <span className="shrink-0 text-[12.5px] font-medium text-ink">{row.name}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">{row.desc}</span>
              </button>;
            })}
            {rows.length === 0 && <div className="flex h-9 items-center px-2 text-[12px] text-ink-3">No matches for “{tokenQuery}”</div>}
            <div className="mt-1 border-t border-line px-2 pt-1.5 pb-1 text-[11px] text-ink-3">{menu === "at" ? "Type to search sources & files" : "Type to search commands"}</div>
          </div>
        )}

        {modelOpen && (
          <div onMouseLeave={() => setModelHovered(null)} className="absolute bottom-[calc(100%+0.75rem)] right-0 z-20 w-[360px] rounded-[10px] border border-line bg-surface p-1.5 shadow-raised" style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom right" }}>
            <div className="flex items-start justify-between px-2 pb-2 pt-1"><div className="grid gap-0.5"><strong className="text-sm text-ink">Choose a model</strong><span className="text-xs text-ink-3">All available Codex and Claude models</span></div><Icon icon={SlidersHorizontalIcon} size={16} /></div>
            <div className="grid grid-cols-2 gap-1 rounded-control bg-inset p-1">
              {(["codex", "claude"] as ModelProvider[]).map((item) => <button key={item} type="button" className={`flex items-center justify-center gap-1.5 rounded-chip px-2 py-1.5 text-xs font-semibold ${provider === item ? "bg-surface text-ink shadow-xs" : "text-ink-3 hover:text-ink"}`} onClick={() => setProvider(item)}><Icon icon={item === "codex" ? AiChat01Icon : AiBrowserIcon} size={14} />{item === "codex" ? "Codex" : "Claude"}<span className="text-[10px] text-ink-3">{MODEL_CATALOG.filter((model) => model.provider === item).length}</span></button>)}
            </div>
            <label className="my-2 flex items-center gap-2 rounded-control border border-line px-2.5 py-2 text-ink-3"><Icon icon={Search01Icon} size={15} /><input className="w-full border-0 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models…" autoFocus /></label>
            <div className="grid max-h-64 gap-0.5 overflow-y-auto">
              {modelRows.map((model, index) => <button key={model.id} type="button" ref={(element) => { modelRowRefs.current[index] = element; }} onMouseEnter={() => setModelHovered(index)} onClick={() => chooseModel(model)} className={`relative z-10 flex w-full items-center gap-2 rounded-control border px-2 py-2 text-left transition-colors ${model.id === selectedModel.id ? "border-line-strong bg-hover" : "border-transparent hover:border-line hover:bg-inset"}`}><span className={`flex size-7 shrink-0 items-center justify-center rounded-control ${model.provider === "claude" ? "bg-orange-tint text-orange" : "bg-accent-tint text-accent-ink"}`}><Icon icon={model.provider === "claude" ? AiBrowserIcon : AiChat01Icon} size={15} /></span><span className="grid min-w-0 flex-1 gap-0.5"><strong className="truncate text-xs text-ink">{model.name}</strong><small className="truncate text-[10px] text-ink-3">{model.description}</small><code className="text-[9px] text-ink-3">{model.id}</code></span>{model.recommended && <span className="shrink-0 rounded-chip bg-green-tint px-1.5 py-1 text-[9px] font-semibold text-green">Recommended</span>}{model.id === selectedModel.id && <Icon icon={Tick02Icon} size={16} />}</button>)}
              {modelRows.length === 0 && <div className="px-2 py-5 text-center text-xs text-ink-3">No models found.</div>}
            </div>
          </div>
        )}

        {permissionOpen && (
          <div className="absolute bottom-[calc(100%+0.75rem)] left-0 z-20 w-[280px] rounded-[10px] border border-line bg-surface p-1.5 shadow-raised" style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom left" }}>
            <div className="px-2 pb-1.5 pt-1"><strong className="text-sm text-ink">Agent permissions</strong><p className="mt-0.5 text-[11px] leading-4 text-ink-3">Choose how much access this run can use.</p></div>
            <div className="grid gap-0.5">
              {PERMISSION_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => {
                    onPermissionModeChange(mode.id);
                    setPermissionOpen(false);
                    inputRef.current?.focus();
                  }}
                  className={`flex items-start gap-2 rounded-control px-2 py-2 text-left transition-colors hover:bg-hover ${permissionMode === mode.id ? "bg-inset" : ""}`}
                >
                  <span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-chip ${mode.id === "full" ? "bg-red-tint text-red" : mode.id === "auto" ? "bg-green-tint text-green" : "bg-accent-tint text-accent-ink"}`}><Icon icon={SecurityCheckIcon} size={13} /></span>
                  <span className="grid min-w-0 gap-0.5"><strong className="text-xs text-ink">{mode.name}</strong><small className="text-[10px] leading-4 text-ink-3">{mode.description}</small></span>
                  {permissionMode === mode.id && <Icon icon={Tick02Icon} size={15} />}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className={`promptbar-surface relative isolate flex flex-col overflow-visible border border-line bg-surface transition-[border-color,border-radius] duration-150 focus-within:border-line-strong ${expanded ? "gap-2.5 rounded-[22px] p-3.5" : "gap-1.5 rounded-[14px] p-1.5"}`}>
          {imageDraft.images.length > 0 && <div className="flex flex-wrap gap-2 px-1 pt-1" aria-label="Attached images">{imageDraft.images.map((image) => <div key={image.id} className="relative rounded-lg border border-line bg-inset p-1"><img src={image.dataUrl} alt={image.name} className="h-20 w-24 rounded object-contain" /><button type="button" aria-label={`Remove image ${image.name}`} onClick={() => imageDraft.remove(image.id)} className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full border border-line bg-surface text-ink shadow-xs"><Icon icon={Cancel01Icon} size={12} /></button></div>)}</div>}
          {imageDraft.loading && <div role="status" className="px-2 text-xs text-ink-3">Loading images…</div>}
          {imageDraft.error && <div role="alert" className="px-2 text-xs text-red">{imageDraft.error}</div>}
          {attachments.length > 0 && <div className="flex flex-wrap gap-1.5 px-0.5 pt-0.5">{attachments.map((file, index) => <span key={`${file}-${index}`} className="flex h-6.5 items-center gap-1.5 rounded-chip bg-field py-1 pr-1 pl-1.5 text-[11.5px] text-ink-2 shadow-hairline"><Icon icon={File02Icon} size={12} /><span className="max-w-36 truncate">{file}</span><button type="button" aria-label={`Remove ${file}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="flex size-5 items-center justify-center rounded-[5px] text-ink-3 hover:bg-line hover:text-ink"><Icon icon={Cancel01Icon} size={10} /></button></span>)}</div>}
          <span ref={measureRef} aria-hidden="true" className="pointer-events-none absolute invisible whitespace-pre text-[13px] leading-[18px]">{draft}</span>
          <div ref={controlsRef} className={`grid items-end gap-x-1 gap-y-1.5 ${expanded ? "grid-cols-[28px_auto_minmax(0,1fr)_auto_28px_28px]" : "grid-cols-[28px_minmax(0,1fr)_auto_auto_28px_28px]"}`}>
            <button type="button" aria-label="Add attachments and sources" aria-expanded={plusOpen} onClick={() => { setModelOpen(false); setPlusOpen((current) => !current); inputRef.current?.focus(); }} className={`flex size-7 shrink-0 items-center justify-center text-ink-3 transition-colors hover:bg-hover hover:text-ink ${plusOpen ? "bg-hover" : ""}`}><Icon icon={Add01Icon} size={16} /></button>
            <textarea onPaste={(event) => void imageDraft.onPaste(event)} ref={inputRef} rows={1} value={draft} onChange={(event) => { onDraftChange(event.target.value); setDismissed(false); setPlusOpen(false); }} onKeyDown={handleKeyDown} placeholder={listening ? "Listening…" : "Prompt or tag a worktree with @"} aria-label="Prompt" className={`${expanded ? "col-span-full col-start-1 row-start-1 min-h-[68px] px-2 py-2 text-[14px] leading-5" : "col-start-2 row-start-1 min-h-7 px-1 py-[5px] text-[13px] leading-[18px]"} min-w-0 w-full resize-none overflow-hidden bg-transparent text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3`} />
            <button ref={modelRef} type="button" aria-expanded={modelOpen} onClick={() => { setPlusOpen(false); setPermissionOpen(false); setModelOpen((current) => !current); }} className={`flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink ${expanded ? "col-start-2 row-start-2 justify-self-start" : "col-start-3 row-start-1"}`}><span className={`flex size-5 items-center justify-center rounded-chip ${selectedModel.provider === "claude" ? "bg-orange-tint text-orange" : "bg-accent-tint text-accent-ink"}`}><Icon icon={selectedModel.provider === "claude" ? AiBrowserIcon : AiChat01Icon} size={13} /></span><span className="max-w-28 truncate">{selectedModel.name}</span><Icon icon={ArrowDown01Icon} size={12} /></button>
            <button type="button" aria-label="Agent permissions" aria-expanded={permissionOpen} onClick={() => { setPlusOpen(false); setModelOpen(false); setPermissionOpen((current) => !current); }} className={`flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium transition-colors hover:bg-hover ${permissionMode === "full" ? "text-red" : permissionMode === "auto" ? "text-green" : "text-ink-2"} ${expanded ? "col-start-3 row-start-2" : "col-start-4 row-start-1"}`}><Icon icon={SecurityCheckIcon} size={14} /><span className="hidden min-[900px]:inline">{permissionMode === "ask" ? "Ask" : permissionMode === "auto" ? "Auto" : "Full"}</span></button>
            <button type="button" aria-label={listening ? "Stop voice input" : "Start voice input"} aria-pressed={listening} onClick={toggleListening} className={`flex size-7 shrink-0 items-center justify-center rounded-[8px] transition-colors ${expanded ? "col-start-5 row-start-2" : "col-start-5 row-start-1"} ${listening ? "bg-accent-tint text-accent-ink" : "text-ink-3 hover:bg-hover hover:text-ink"}`}><Icon icon={Mic01Icon} size={15} /></button>
            <button type="button" aria-label="Send" disabled={!canSend || isSending || imageDraft.loading} onClick={onSend} className={`flex size-7 shrink-0 items-center justify-center rounded-[8px] text-surface transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94] disabled:cursor-not-allowed disabled:bg-line-strong disabled:text-ink-2 ${expanded ? "col-start-6 row-start-2" : "col-start-6 row-start-1"}`} style={{ background: canSend && !isSending ? "var(--ink)" : "var(--line-strong)" }}><Icon icon={ArrowUp01Icon} size={16} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}
