import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FindingRow } from "./FindingRow";

/** A static example of a PRism review. Everything on it is illustrative. */
export function ReviewPreview() {
    return (
        <Card className="w-full text-left">
            <CardHeader className="border-b">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <CardTitle>acme/api · #142</CardTitle>
                        <CardDescription>feat: add user search</CardDescription>
                    </div>
                    <Badge variant="outline">Example review</Badge>
                </div>
            </CardHeader>
            <CardContent className="p-0">
                <p className="border-b px-4 py-3 text-sm text-muted-foreground">
                    5 issues found · 3 shown · 2 filtered out as noise
                </p>
                <ul className="divide-y">
                    <FindingRow
                        severity="High"
                        source="Semgrep"
                        origin="New in this PR"
                        title="Potential SQL injection detected. Use parameterized queries."
                        location="userService.js:6 · prism-sql-injection"
                    />
                    <FindingRow
                        severity="Medium"
                        source="ESLint"
                        origin="New in this PR"
                        title="'usr' is not defined."
                        location="userService.js:17 · no-undef"
                    />
                    <FindingRow
                        severity="High"
                        source="Semgrep"
                        origin="Already in the base branch"
                        title="Potential command injection detected. Avoid passing untrusted strings to exec()."
                        location="backup.js:4 · prism-command-injection"
                    />
                </ul>
                <div className="space-y-1 border-t bg-muted/30 px-4 py-3 text-sm">
                    <p className="font-medium">Filtered out as noise · 2</p>
                    <p className="text-muted-foreground">PRism rated these as unlikely to matter. Open to check them or bring one back.</p>
                </div>
                <div className="space-y-1 border-t px-4 py-3 text-sm">
                    <p className="font-medium">AI suggestions · 2 <span className="font-normal text-muted-foreground">(optional)</span></p>
                    <p className="text-muted-foreground">Possible logic bugs you may want to look at. They are not confirmed by a scanner or by tests.</p>
                </div>
            </CardContent>
        </Card>
    );
}
