"use client";

import { useState, type ComponentProps } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/authClient";
import { Button } from "@/components/ui/button";
import { GithubLight } from "@/components/ui/svgs/githubLight";

type Props = Omit<ComponentProps<typeof Button>, "onClick" | "onError" | "children"> & {
    label?: string;
    /** Called with a message when sign-in could not start. Without it, a toast is shown. */
    onError?: (message: string) => void;
};

const START_ERROR = "Couldn't start GitHub sign-in. Please try again.";

export default function GithubSignInButton({ label = "Sign in with GitHub", onError, disabled, ...props }: Props) {
    const [isLoading, setIsLoading] = useState(false);

    const handleClick = async () => {
        setIsLoading(true);
        try {
            // errorCallbackURL brings the user back to /login?error=... if GitHub sign-in fails or is cancelled.
            const res = await authClient.signIn.social({ provider: "github", errorCallbackURL: "/login" });
            if (res.error) throw new Error(res.error.message);
        } catch {
            setIsLoading(false);
            if (onError) onError(START_ERROR);
            else toast.error(START_ERROR);
        }
    };

    return (
        <Button {...props} onClick={handleClick} disabled={disabled || isLoading} aria-busy={isLoading}>
            <span className="flex h-4 w-4 items-center justify-center mr-2">
                <GithubLight className="h-full w-full" />
            </span>
            {isLoading ? "Redirecting to GitHub…" : label}
        </Button>
    );
}
