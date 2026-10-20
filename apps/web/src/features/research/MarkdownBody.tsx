import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

const BLOCKED = [
  "img",
  "picture",
  "source",
  "iframe",
  "frame",
  "object",
  "embed",
  "script",
  "style",
  "link",
  "meta",
  "form",
  "input",
  "button",
  "svg",
  "math",
  "video",
  "audio",
];

function normalise(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Model-written Markdown is untrusted (spec 15.2 T11 and T13): raw HTML is skipped, images and embeds are removed, and a
 * link is rendered as a link only when its URL is one of the evidence-ledger URLs in `allowedUrls`; everything else is text.
 */
export function MarkdownBody({
  markdown,
  allowedUrls = [],
}: {
  markdown: string;
  allowedUrls?: readonly string[];
}) {
  const allowed = new Set(allowedUrls.map(normalise).filter((u): u is string => u !== null));
  return (
    <div className="max-w-[68ch] space-y-3 text-[0.95rem] leading-7 [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown
        skipHtml
        rehypePlugins={[rehypeSanitize]}
        disallowedElements={BLOCKED}
        unwrapDisallowed
        urlTransform={(url) => (normalise(url) === null ? "" : url)}
        components={{
          a: ({ href, children }) => {
            const target = href === undefined ? null : normalise(href);
            return target !== null && allowed.has(target) ? (
              <a href={target} target="_blank" rel="noopener noreferrer" className="underline">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
