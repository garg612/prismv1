/**
 * What to tell a person when accepting or rejecting a fix did not work. The actions return short
 * codes; a code on its own ("FIX_CONFLICT") explains nothing, so every one has a sentence here.
 */
const MESSAGES: Record<string, string> = {
    FIX_CONFLICT: "Another fix you already applied changed the same lines, so this change no longer fits. Nothing was changed. Once the fix pull request is merged, the pull request is reviewed again and this issue gets a fresh fix if it is still there.",
    FIX_TARGET_MISSING: "The file this fix changes is no longer in the pull request. Nothing was changed.",
    BLOB_MISMATCH: "The pull request changed after this fix was validated, so it no longer fits. PRism reviews the new commit and proposes a new fix.",
    FIX_ALREADY_PROCESSING: "This fix is already being applied. Wait a moment and reload the page.",
    FIX_NOT_READY: "This fix has already been decided or is no longer available.",
    FIX_NOT_FOUND: "This fix no longer exists. Reload the page.",
    INVALID_REVIEW_STATE: "This review is no longer the one waiting for your decision. Open the latest review of the pull request.",
    MISSING_REPORT: "The review has not finished writing its report yet. Try again in a moment.",
    UNAUTHORIZED: "Your session has ended. Sign in again.",
    FORBIDDEN: "Only the owner of this repository can decide on its fixes.",
    UNSUPPORTED_MODE: "This repository's fix delivery setting is not supported. Check it in Settings.",
    NO_READY_FIXES: "There is no validated fix left to apply.",
    NO_GITHUB_LINK: "PRism has no GitHub access for your account. Sign in with GitHub again.",
};

/** A sentence for a fix action error. Text that is already a sentence is passed through. */
export function fixErrorMessage(error: string | null | undefined): string {
    const text = String(error || "").trim();
    if (!text) return "Something went wrong. Nothing was changed.";
    if (MESSAGES[text]) return MESSAGES[text];
    // An unknown code (ALL_CAPS) tells the reader nothing; say what is safe to say and keep the code.
    if (/^[A-Z][A-Z0-9_]+$/.test(text)) return `The change could not be made (${text}). Nothing was changed.`;
    return text;
}
