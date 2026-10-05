import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { indexRepo, indexRepoV2 } from "@/inngest/functions/index";
import { generateReview } from "@/inngest/functions/review";
import { reviewRunOrchestrator } from "@/inngest/functions/review-run";
import { reindexIncremental } from "@/inngest/functions/reindex-incremental";
import { processFinding } from "@/inngest/functions/process-finding";
import { generateReport } from "@/inngest/functions/generate-report";
import { validateCombined } from "@/inngest/functions/validate-combined";
import { exportDataset } from "@/inngest/functions/export-dataset";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [indexRepo, indexRepoV2, generateReview, reviewRunOrchestrator, reindexIncremental, processFinding, generateReport, validateCombined, exportDataset],
});