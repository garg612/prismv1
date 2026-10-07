"use client"

import { authClient } from "@/lib/authClient"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card"
import GithubSignInButton from "./GithubSignInButton"
import { Mascot } from 'page-mascot'

const DEMO_ERROR = "Failed to sign in with the demo account. Please try again."

const LoginUI = ({ initialError = null }: { initialError?: string | null }) => {
    const { signIn } = authClient
    const [error, setError] = useState<string | null>(initialError)
    const [isDemoLoading, setIsDemoLoading] = useState(false)
    const router = useRouter()

    const handleDemoLogin = async () => {
        setError(null)
        setIsDemoLoading(true)
        try {
            const res = await signIn.email({
                email: "demo@prism.local",
                password: "Demo@123"
            })
            if (res.error) {
                setError(DEMO_ERROR)
                setIsDemoLoading(false)
            } else {
                router.push("/dashboard")
            }
        } catch {
            setError(DEMO_ERROR)
            setIsDemoLoading(false)
        }
    }

    return (
        <div className="relative w-full max-w-sm mx-auto mt-20">
            <div className="absolute -top-[115px] left-1/2 -translate-x-1/2 z-20 drop-shadow-xl">
                <Mascot
                    directions="/mascots/cat-directions.webp"
                    reactions="/mascots/cat-reactions.webp"
                />
            </div>
            <Card className="w-full shadow-2xl border-primary/20 bg-background/60 backdrop-blur-xl relative z-10 pt-2">
                <CardHeader className="text-center">
                    <h2 className="font-heading text-3xl font-semibold leading-snug tracking-tight">Welcome back</h2>
                    <CardDescription className="text-base">
                        Sign in with GitHub to connect your first repository.
                    </CardDescription>
                </CardHeader>
            <CardContent className="space-y-4">
                {error && (
                    <Alert variant="destructive">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}

                <GithubSignInButton variant="outline" className="w-full font-medium" onError={setError} />

                {process.env.NEXT_PUBLIC_DEMO_MODE === "true" && (
                    <Button
                        variant="secondary"
                        className="w-full font-medium border-border/50"
                        onClick={handleDemoLogin}
                        disabled={isDemoLoading}
                    >
                        {isDemoLoading ? "Signing in…" : "Sign in with Demo Account"}
                    </Button>
                )}
            </CardContent>
            <CardFooter className="justify-center text-center text-sm text-muted-foreground pb-6">
                <p>
                    PRism asks GitHub for the repo permission so it can read your pull requests and push fixes you approve.{" "}
                    <a href="#control" className="underline underline-offset-4 hover:text-foreground transition-colors">Details</a>
                </p>
            </CardFooter>
            </Card>
        </div>
    )
}

export default LoginUI
