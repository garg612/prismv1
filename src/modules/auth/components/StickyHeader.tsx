import Link from "next/link";
import { LoginThemeToggle } from "@/components/LoginThemeToggle";
import BrandLogo from "./BrandLogo";
import GithubSignInButton from "./GithubSignInButton";

export default function StickyHeader() {
    return (
        <header className="sticky top-0 z-50 w-full border-b bg-background">
            <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
                <Link href="/login" aria-label="PRism">
                    <BrandLogo priority />
                </Link>

                <nav aria-label="Page sections" className="hidden sm:flex items-center gap-6 text-sm text-muted-foreground">
                    <a href="#how-it-works" className="hover:text-foreground">How it works</a>
                    <a href="#control" className="hover:text-foreground">Control &amp; access</a>
                </nav>

                <div className="flex items-center gap-3">
                    <LoginThemeToggle />
                    <GithubSignInButton variant="outline" size="sm" label="Sign in with GitHub" />
                </div>
            </div>
        </header>
    );
}
