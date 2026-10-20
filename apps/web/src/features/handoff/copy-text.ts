export type CopyOutcome = "clipboard" | "fallback" | "failed";

export interface CopyEnv {
  clipboard: { writeText(text: string): Promise<void> } | undefined;
  /** document.execCommand("copy"): the select-text fallback for browsers or contexts without the async clipboard API. */
  execCopy: () => boolean;
}

export function browserCopyEnv(): CopyEnv {
  return {
    clipboard: typeof navigator !== "undefined" ? navigator.clipboard : undefined,
    execCopy: () => {
      try {
        return document.execCommand("copy");
      } catch {
        return false;
      }
    },
  };
}

/**
 * Copies `text`. Uses the clipboard API when it works; otherwise selects the read-only prompt box and tries execCommand. When both fail
 * the text stays selected so the user can press Ctrl+C (spec 13.1: "clipboard API with select-text fallback").
 */
export async function copyText(
  text: string,
  box: HTMLTextAreaElement | null,
  env: CopyEnv = browserCopyEnv(),
): Promise<CopyOutcome> {
  if (env.clipboard !== undefined) {
    try {
      await env.clipboard.writeText(text);
      return "clipboard";
    } catch {
      // fall through to the select-text fallback (insecure context, permission denied)
    }
  }
  if (box === null) return "failed";
  box.focus();
  box.select();
  return env.execCopy() ? "fallback" : "failed";
}
