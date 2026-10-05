/**
 * Text in which `backticks` mark code, as model and scanner messages write it.
 * The marked parts are set as inline code; everything else stays plain text.
 */
export function InlineText({ text }: { text: string }) {
    const parts = text.split(/(`[^`\n]+`)/g);
    return (
        <>
            {parts.map((part, i) =>
                part.length > 2 && part.startsWith("`") && part.endsWith("`")
                    ? <code key={i} className="rounded border bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{part.slice(1, -1)}</code>
                    : part
            )}
        </>
    );
}
