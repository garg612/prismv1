import { Button } from "@/components/ui/button";
import GithubSignInButton from "./GithubSignInButton";
import { ReviewPreview } from "./showcase/ReviewPreview";
import TechText from "@/components/TechText";
import StrokeText from "@/components/StrokeText";

export default function HeroSection() {
    return (
        <section className="pt-8 pb-16 md:pt-12 md:pb-24 max-w-5xl mx-auto px-6 w-full flex flex-col items-center text-center gap-10 md:gap-12">
            <div className="space-y-6 max-w-3xl flex flex-col items-center">
                <div style={{ width: '100%', height: '160px', position: 'relative' }} className="flex justify-center items-center -mt-4">
                    <TechText
                        text="PRism"
                        fontWeight={800}
                        fontSize={150}
                        reveal="letter"
                        dashLength={4}
                        dashGap={2}
                        specks={15}
                        letterSpacing={0.15}
                    />
                </div>
                <h1 className="font-heading font-bold tracking-tight text-foreground leading-tight w-full flex flex-col items-center gap-2 md:gap-4 -mt-2">
                    <div className="w-full max-w-[500px] md:max-w-[700px] flex justify-center">
                        <StrokeText
                            text="Code review that fixes"
                            strokeColor="var(--primary)"
                            fillColor="currentColor"
                            strokeWidth={2}
                            drawDuration={1.2}
                            fillDelay={0.1}
                            stagger={0.05}
                            ease="power2.out"
                            trigger="mount"
                            fillMode="wipe"
                            fontSize={64}
                            fontWeight={800}
                            letterSpacing={-1}
                        />
                    </div>
                    <div className="w-full max-w-[550px] md:max-w-[750px] flex justify-center">
                        <StrokeText
                            text="what it finds."
                            strokeColor="var(--primary)"
                            fillColor="currentColor"
                            strokeWidth={2}
                            drawDuration={1.2}
                            fillDelay={0.1}
                            stagger={0.05}
                            ease="power2.out"
                            trigger="mount"
                            fillMode="wipe"
                            fontSize={64}
                            fontWeight={800}
                            letterSpacing={-1}
                        />
                    </div>
                </h1>
                <p className="text-xl text-muted-foreground leading-relaxed">
                    PRism scans every pull request with Semgrep and ESLint, sets the noise aside, and proposes fixes it has already tested in an isolated sandbox. You decide what gets applied.
                </p>
                <div className="flex flex-col sm:flex-row gap-4 items-center justify-center pt-4">
                    <GithubSignInButton
                        size="lg"
                        label="Sign in with GitHub"
                        className="w-full sm:w-auto text-base bg-foreground text-background hover:bg-foreground/90"
                    />
                    <Button asChild variant="link" size="lg" className="w-full sm:w-auto text-base text-muted-foreground hover:text-foreground">
                        <a href="#how-it-works">See how it works &rarr;</a>
                    </Button>
                </div>
                <p className="text-sm text-muted-foreground">For JavaScript and TypeScript repositories on GitHub.</p>
            </div>

            <div className="w-full">
                <ReviewPreview />
            </div>
        </section>
    );
}
