import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const features = [
    {
        title: "Finds problems in your pull request",
        body: "Semgrep and ESLint scan the code in the PR. An AI reviewer also reads the diff for logic mistakes no scanner can see, and shows them as suggestions, not facts.",
    },
    {
        title: "Sets the noise aside",
        body: "Every finding gets a risk score. Likely noise moves to a collapsed list you can reopen, and problems that were already in the base branch are labelled as such. High-severity security issues are always shown.",
    },
    {
        title: "Fixes it, then checks the fix",
        body: "PRism proposes a small change, applies it in an isolated sandbox and scans again. If you turn it on, it also runs your repository's install, lint, build and tests before and after the fix.",
    },
    {
        title: "You decide what lands",
        body: "Nothing is applied until you choose to. Fixes go to a separate branch with a pull request by default, or as a direct commit or a suggestion comment.",
    },
];

export default function FeaturesSection() {
    return (
        <section className="py-16 md:py-24 max-w-5xl mx-auto px-6 w-full">
            <h2 className="font-heading text-3xl md:text-4xl font-bold tracking-tight mb-12">
                What PRism does
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {features.map((feature) => (
                    <Card key={feature.title}>
                        <CardHeader>
                            <CardTitle className="text-lg">{feature.title}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="text-muted-foreground leading-relaxed">{feature.body}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </section>
    );
}
