import { Card, CardContent } from "@/components/ui/card";

const controls = [
    {
        title: "Nothing is applied until you say so.",
        body: "PRism proposes fixes. You pick which ones to apply, and how: a fix branch with a pull request (the default), a direct commit, or a suggestion comment.",
    },
    {
        title: "Checked as a batch.",
        body: "When you apply several fixes together, PRism validates them together first. If the combined check fails, nothing is applied.",
    },
    {
        title: "Stale-safe.",
        body: "If someone pushes to the pull request while a fix is being prepared, PRism sees the new commit and discards the stale fix instead of applying it.",
    },
    {
        title: "You can overrule the model.",
        body: "Mark a finding as noise or a false alarm, or use Show this issue to bring back one that PRism filtered out.",
    },
];

export default function TrustSection() {
    return (
        <section id="control" className="scroll-mt-20 py-16 md:py-24 max-w-5xl mx-auto px-6 w-full">
            <h2 className="font-heading text-3xl md:text-4xl font-bold tracking-tight mb-12">
                You stay in control.
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
                {controls.map((item) => (
                    <div key={item.title} className="space-y-2">
                        <h3 className="text-lg font-medium text-foreground">{item.title}</h3>
                        <p className="text-base text-muted-foreground leading-relaxed">{item.body}</p>
                    </div>
                ))}
            </div>

            <Card className="mt-12 bg-muted/30">
                <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="space-y-2">
                        <h3 className="text-lg font-medium text-foreground">What PRism asks GitHub for</h3>
                        <p className="text-muted-foreground leading-relaxed">
                            Signing in asks GitHub for the <span className="font-mono text-sm">repo</span> permission. PRism uses it to read your pull requests and code and, when you apply a fix, to push it to a branch or a commit. You can revoke access at any time in your{" "}
                            <a href="https://github.com/settings/applications" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-foreground">
                                GitHub settings
                            </a>.
                        </p>
                    </div>
                    <div className="space-y-2">
                        <h3 className="text-lg font-medium text-foreground">Where your code goes when a fix is tested</h3>
                        <p className="text-muted-foreground leading-relaxed">
                            Fixes are tested in an isolated sandbox. It gets a copy of the code it needs to check the fix, but none of your environment variables, and it cannot reach private networks. Running your repository&apos;s tests is optional and set per repository.
                        </p>
                    </div>
                </CardContent>
            </Card>
        </section>
    );
}
