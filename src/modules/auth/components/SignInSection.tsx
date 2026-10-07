import LoginUI from "@/modules/auth/components/LoginUI";

export default function SignInSection({ authError }: { authError: string | null }) {
    return (
        <section id="sign-in" className="scroll-mt-20 py-24 md:py-32 border-t bg-gradient-to-b from-background to-muted/30 w-full flex items-center justify-center relative overflow-hidden">
            {/* Decorative background glow */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/10 rounded-full blur-[120px] pointer-events-none" />
            
            <div className="w-full max-w-6xl px-6 flex flex-col lg:flex-row items-center justify-center gap-16 lg:gap-24 relative z-10">
                {/* Left side text */}
                <div className="flex-1 text-center lg:text-left space-y-6 max-w-xl">
                    <h2 className="text-4xl md:text-5xl font-heading font-bold tracking-tight leading-tight">
                        Ready to elevate your workflow?
                    </h2>
                    <p className="text-xl text-muted-foreground leading-relaxed">
                        Join developers who are shipping faster and safer. Let PRism handle the noise, so you can focus on writing great code.
                    </p>
                </div>

                {/* Right side Login Card */}
                <div className="w-full max-w-md flex-shrink-0">
                    <LoginUI initialError={authError} />
                </div>
            </div>
        </section>
    );
}
