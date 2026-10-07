import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Check } from "lucide-react";
import { FixChecks } from "./showcase/FixChecks";

function RiskRow({ title, score, outcome }: { title: string; score: number; outcome: string }) {
    return (
        <li className="space-y-1.5">
            <p className="text-sm font-medium">{title}</p>
            <div className="flex items-center gap-3">
                <div className="h-1.5 flex-1 rounded-full bg-muted" role="img" aria-label={`Risk score ${score} out of 100`}>
                    <div className="h-full rounded-full bg-foreground" style={{ width: `${score}%` }} />
                </div>
                <span className="w-16 text-right font-mono text-xs text-muted-foreground">{score} / 100</span>
            </div>
            <p className="text-xs text-muted-foreground">{outcome}</p>
        </li>
    );
}

const steps = [
    {
        id: "scan",
        label: "Scan",
        title: "Scan the pull request",
        body: "When a pull request opens or gets a new commit, PRism runs Semgrep and ESLint on the exact commit. An AI reviewer also reads the diff for logic bugs, and labels those as suggestions.",
        visual: (
            <Card size="sm">
                <CardHeader>
                    <CardTitle>Scan</CardTitle>
                    <CardDescription>5 issues found on this commit</CardDescription>
                </CardHeader>
                <CardContent>
                    <ul className="divide-y text-sm">
                        <li className="flex justify-between py-2"><span>Semgrep</span><span className="text-muted-foreground">3 findings</span></li>
                        <li className="flex justify-between py-2"><span>ESLint</span><span className="text-muted-foreground">2 findings</span></li>
                        <li className="flex justify-between py-2"><span>AI logic review</span><span className="text-muted-foreground">2 suggestions</span></li>
                    </ul>
                </CardContent>
            </Card>
        ),
    },
    {
        id: "triage",
        label: "Triage",
        title: "Decide what is worth your time",
        body: "Each finding gets a risk score. Likely noise is moved into a collapsed list, and you can bring any of it back with one click. High-severity security issues are always shown, whatever their score.",
        visual: (
            <Card size="sm">
                <CardHeader>
                    <CardTitle>Triage</CardTitle>
                    <CardDescription>Example risk scores: 0 is noise, 100 is a real problem</CardDescription>
                </CardHeader>
                <CardContent>
                    <ul className="space-y-4">
                        <RiskRow title="Potential SQL injection detected." score={82} outcome="Shown" />
                        <RiskRow title="'usr' is not defined." score={80} outcome="Shown" />
                        <RiskRow title="Debugging console.log detected." score={33} outcome="Filtered out as noise" />
                    </ul>
                </CardContent>
            </Card>
        ),
    },
    {
        id: "fix",
        label: "Fix",
        title: "Propose a fix and check it",
        body: "PRism writes a small change, applies it in an isolated sandbox and scans again. If you turned on tests for the repository, it also runs install, lint, build and tests on the code before and after the fix.",
        visual: (
            <Card size="sm">
                <CardHeader>
                    <CardTitle>Suggested fix</CardTitle>
                    <CardDescription className="font-mono text-xs">userService.js</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <pre className="overflow-x-auto rounded-md border font-mono text-xs leading-relaxed">
                        <code className="block bg-destructive/10 px-3 py-1">{"- return db.query(\"SELECT * FROM users WHERE username = '\" + username + \"'\");"}</code>
                        <code className="block bg-success/15 px-3 py-1">{"+ return db.query(\"SELECT * FROM users WHERE username = $1\", [username]);"}</code>
                    </pre>
                    <div className="space-y-2">
                        <p className="text-xs font-medium uppercase text-muted-foreground">How this fix was checked</p>
                        <FixChecks />
                    </div>
                </CardContent>
            </Card>
        ),
    },
    {
        id: "decision",
        label: "Your decision",
        title: "You choose what to apply",
        body: "Pick the fixes you want. Selected fixes are checked together before anything is applied. You can also mark a finding as noise or a false alarm.",
        visual: (
            <Card size="sm">
                <CardHeader>
                    <CardTitle>Apply selected fixes as</CardTitle>
                    <CardDescription>Set per repository</CardDescription>
                </CardHeader>
                <CardContent>
                    <ul className="divide-y text-sm">
                        <li className="flex justify-between py-2"><span>Fix branch + pull request</span><span className="text-muted-foreground">Default</span></li>
                        <li className="py-2">Direct commit</li>
                        <li className="py-2">Suggestion comment</li>
                    </ul>
                </CardContent>
            </Card>
        ),
    },
    {
        id: "recheck",
        label: "Re-check",
        title: "Scan again",
        body: "After a fix is applied, the updated pull request is scanned again, so you can see the finding is gone and nothing new appeared.",
        visual: (
            <Card size="sm">
                <CardHeader>
                    <CardTitle>Re-check</CardTitle>
                    <CardDescription>Updated pull request scanned</CardDescription>
                </CardHeader>
                <CardContent>
                    <ul className="space-y-2 text-sm">
                        <li className="flex items-center gap-2"><Check className="size-4 shrink-0" aria-hidden />Potential SQL injection: resolved</li>
                        <li className="flex items-center gap-2"><Check className="size-4 shrink-0" aria-hidden />No new issues introduced</li>
                    </ul>
                </CardContent>
            </Card>
        ),
    },
];

export default function PipelineSection() {
    return (
        <section id="how-it-works" className="scroll-mt-20 py-16 md:py-24 max-w-5xl mx-auto px-6 w-full">
            <div className="mb-10 space-y-3">
                <h2 className="font-heading text-3xl md:text-4xl font-bold tracking-tight">
                    How it works
                </h2>
                <p className="text-muted-foreground text-lg">
                    Connect a repository and open a pull request. PRism takes it from there.
                </p>
            </div>

            <Tabs defaultValue="scan">
                <TabsList variant="line" className="w-full justify-start overflow-x-auto">
                    {steps.map((step) => (
                        <TabsTrigger key={step.id} value={step.id} className="flex-none px-3">
                            {step.label}
                        </TabsTrigger>
                    ))}
                </TabsList>
                {steps.map((step) => (
                    <TabsContent key={step.id} value={step.id} className="pt-8">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 items-start">
                            <div className="space-y-3">
                                <h3 className="text-xl font-medium text-foreground">{step.title}</h3>
                                <p className="text-base text-muted-foreground leading-relaxed">{step.body}</p>
                            </div>
                            {step.visual}
                        </div>
                    </TabsContent>
                ))}
            </Tabs>
        </section>
    );
}
