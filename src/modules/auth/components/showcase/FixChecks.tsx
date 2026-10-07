import { Check, Minus } from "lucide-react";

const checks = [
    "Change applies cleanly",
    "Code still parses",
    "Semgrep no longer reports this issue",
    "No new issues introduced",
];

/** "How this fix was checked", as shown on the review page. */
export function FixChecks() {
    return (
        <ul className="space-y-2 text-sm">
            {checks.map((label) => (
                <li key={label} className="flex items-center gap-2">
                    <Check className="size-4 shrink-0 text-foreground" aria-hidden />
                    <span>{label}</span>
                </li>
            ))}
            <li className="flex items-start gap-2 text-muted-foreground">
                <Minus className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>Install, lint, build and tests run when turned on for the repository.</span>
            </li>
        </ul>
    );
}
