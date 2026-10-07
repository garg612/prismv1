/** Turns the `?error=` code better-auth adds to /login after a failed GitHub sign-in into a message. */
export function getAuthErrorMessage(code: string | undefined): string | null {
    if (!code) return null;
    if (code === "access_denied") {
        return "GitHub sign-in was cancelled. You can try again whenever you're ready.";
    }
    return "GitHub sign-in didn't complete. Please try again.";
}
