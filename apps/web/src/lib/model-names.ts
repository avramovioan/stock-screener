const KNOWN: Record<string, string> = {
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-3.5-pro": "Gemini 3.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "openai/gpt-oss-120b": "GPT-OSS 120B",
  "mistral-large-latest": "Mistral Large",
  "mistral-medium-latest": "Mistral Medium",
  "mistral-small-latest": "Mistral Small",
};

/** A readable name for a model id: the table above, else the id title-cased without "-latest". */
export function modelDisplayName(id: string): string {
  const known = KNOWN[id.toLowerCase()];
  if (known) return known;
  return id
    .trim()
    .replace(/-latest$/i, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Gemini is the primary research model; any other model is the backup. */
export function isPrimaryModel(id: string): boolean {
  return /^gemini/i.test(id);
}
