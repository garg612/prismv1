/** A few lines of source with their real line numbers in the gutter. */
export function CodeSnippet({ code, startLine }: { code: string; startLine: number }) {
    const lines = code.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
    return (
        <pre className="overflow-x-auto rounded-md border bg-muted/40 py-2 font-mono text-xs leading-5">
            {lines.map((line, i) => (
                <div key={i} className="flex">
                    <span className="w-12 shrink-0 select-none pr-3 text-right tabular-nums text-muted-foreground/60" aria-hidden>
                        {startLine + i}
                    </span>
                    <code className="pr-3">{line || " "}</code>
                </div>
            ))}
        </pre>
    );
}
