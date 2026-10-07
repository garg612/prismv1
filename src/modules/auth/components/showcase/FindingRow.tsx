import { Badge } from "@/components/ui/badge";

interface FindingRowProps {
    severity: "High" | "Medium";
    source: "Semgrep" | "ESLint";
    origin: "New in this PR" | "Already in the base branch";
    title: string;
    location: string;
}

/** One finding, using the same words as the real review page. */
export function FindingRow({ severity, source, origin, title, location }: FindingRowProps) {
    return (
        <li className="space-y-1.5 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
                <Badge variant={severity === "High" ? "destructive" : "secondary"}>{severity} severity</Badge>
                <Badge variant="outline">{source}</Badge>
                <span className="text-xs text-muted-foreground">{origin}</span>
            </div>
            <p className="text-sm font-medium text-foreground">{title}</p>
            <p className="font-mono text-xs text-muted-foreground">{location}</p>
        </li>
    );
}
