import { NonRetriableError } from "inngest";

/**
 * A deterministic, explained pipeline failure. The run is marked FAILED with this
 * stage and code, is never billed, and is not retried (retrying cannot change it).
 */
export class PipelineFailure extends NonRetriableError {
    readonly stage: string;
    readonly code: string;

    constructor(stage: string, code: string, message: string) {
        super(message);
        this.name = "PipelineFailure";
        this.stage = stage;
        this.code = code;
    }
}
