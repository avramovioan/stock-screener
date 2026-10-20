import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type { DiscountRow } from "@/features/screening/types";
import { ChatGptIcon, ClaudeIcon, GeminiIcon, GrokIcon } from "./ai-icons";
import { buildResearchPrompt } from "./research-prompt";

/** A prefilled link longer than this is not trusted to the address bar; the plain new-chat page opens instead. */
export const MAX_PREFILL_URL = 8000;

export interface AssistantConfig {
  id: string;
  name: string;
  title: string;
  /** prefill: open the site with the prompt in the URL; paste: copy, then open from the toast action. */
  mode: "prefill" | "paste";
  /** URL template with a {prompt} placeholder (prefill mode only). */
  prefillUrl?: string;
  plainUrl: string;
}

export const ASSISTANTS: readonly AssistantConfig[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    title: "ChatGPT",
    mode: "prefill",
    prefillUrl: "https://chatgpt.com/?prompt={prompt}",
    plainUrl: "https://chatgpt.com/",
  },
  {
    id: "claude",
    name: "Claude",
    title: "Claude",
    mode: "prefill",
    prefillUrl: "https://claude.ai/new?q={prompt}",
    plainUrl: "https://claude.ai/new",
  },
  {
    id: "grok",
    name: "Grok",
    title: "Grok",
    mode: "prefill",
    prefillUrl: "https://grok.com/?q={prompt}",
    plainUrl: "https://grok.com/",
  },
  {
    id: "gemini",
    name: "Gemini",
    title: "Gemini",
    mode: "paste",
    plainUrl: "https://gemini.google.com/app",
  },
];

const ICONS: Record<string, ReactNode> = {
  chatgpt: <ChatGptIcon />,
  claude: <ClaudeIcon />,
  grok: <GrokIcon />,
  gemini: <GeminiIcon />,
};

const BUTTON =
  "inline-flex size-11 items-center justify-center rounded-[10px] border border-input bg-card text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function label(a: AssistantConfig): string {
  return a.mode === "prefill" ? `Open the prompt in ${a.name}` : `Copy the prompt for ${a.name}`;
}

/** The URL to open: the prefilled one while it is short enough, otherwise the plain page. */
function targetUrl(a: AssistantConfig, prompt: string): string {
  if (!a.prefillUrl) return a.plainUrl;
  const url = a.prefillUrl.replace("{prompt}", encodeURIComponent(prompt));
  return url.length > MAX_PREFILL_URL ? a.plainUrl : url;
}

/** Writes the prompt to the clipboard; true when it worked. Never throws. */
async function copyPrompt(prompt: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(prompt);
    return true;
  } catch {
    return false;
  }
}

function openAction(a: AssistantConfig) {
  return {
    label: `Open ${a.name}`,
    onClick: () => {
      window.open(a.plainUrl, "_blank", "noopener,noreferrer");
    },
  };
}

/**
 * "Or run the evaluation in your own AI" (board AiHandoff). Prefill sites open a tab with the prompt in the URL
 * (opened synchronously in the click so popup blockers allow it); paste sites copy first and open from the toast
 * action. Copy only copies.
 */
export function AiHandoff({ row }: { row: DiscountRow }) {
  const run = async (a: AssistantConfig | null) => {
    const prompt = buildResearchPrompt(row);
    const copied = copyPrompt(prompt); // started in the click
    if (a?.mode === "prefill") window.open(targetUrl(a, prompt), "_blank", "noopener,noreferrer");
    const ok = await copied;
    if (!a) {
      if (ok) toast.success("Prompt copied.");
      else toast.error("Could not copy the prompt.");
    } else if (a.mode === "prefill") {
      if (ok)
        toast.success(
          `Prompt copied and ${a.name} opened in a new tab. Review it there and press Send.`,
        );
      else toast.error("Could not copy the prompt.");
    } else if (ok) {
      toast.success("Prompt copied.", {
        description: `Open ${a.name} and paste it with Ctrl+V, or long-press and Paste on a phone.`,
        action: openAction(a),
        duration: 12000,
      });
    } else {
      toast.error("Could not copy the prompt.", { action: openAction(a), duration: 12000 });
    }
  };
  return (
    <div className="flex flex-col gap-2" data-testid="ai-handoff">
      <p className="text-[13px] text-muted-foreground">Or run the evaluation in your own AI</p>
      <div className="flex items-center gap-2">
        {ASSISTANTS.map((assistant) => (
          <button
            key={assistant.id}
            type="button"
            aria-label={label(assistant)}
            title={assistant.title}
            onClick={() => void run(assistant)}
            className={BUTTON}
          >
            {ICONS[assistant.id]}
          </button>
        ))}
        <span aria-hidden="true" className="mx-1 h-7 w-px bg-border" />
        <button
          type="button"
          aria-label="Copy the prompt"
          title="Copy the prompt"
          onClick={() => void run(null)}
          className={`${BUTTON} text-primary`}
        >
          <Copy aria-hidden="true" size={20} />
        </button>
      </div>
    </div>
  );
}
