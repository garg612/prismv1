import BrandLogo from "./BrandLogo";

export default function Footer() {
    return (
        <footer className="w-full border-t py-8">
            <div className="max-w-5xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-muted-foreground">
                <div className="flex items-center gap-3">
                    <BrandLogo className="h-6 w-auto" />
                    <span>© {new Date().getFullYear()}</span>
                </div>
                <nav aria-label="Footer" className="flex items-center gap-6">
                    <a href="#how-it-works" className="hover:text-foreground">How it works</a>
                    <a href="#control" className="hover:text-foreground">Control &amp; access</a>
                    <a href="#sign-in" className="hover:text-foreground">Sign in</a>
                </nav>
            </div>
        </footer>
    );
}
