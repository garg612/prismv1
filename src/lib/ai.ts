import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";

// Text generation (review, fix, report) runs on Groq.
// Embeddings stay on Google: Groq has no embedding model and the Pinecone index
// was built with the Google embedding dimensions.
export const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
});

const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

// The key is a Groq key (gsk_...). GROK_API_KEY is accepted because that is the
// name it was given in .env.
const getGroqApiKey = () => {
    const apiKey = (process.env.GROQ_API_KEY || process.env.GROK_API_KEY || "").trim();
    if (!apiKey) {
        throw new Error("GROQ_API_KEY (or GROK_API_KEY) is not configured");
    }
    return apiKey;
};

const groqModel = (modelName: string) => createGroq({ apiKey: getGroqApiKey() })(modelName);

export const getReviewModelName = () => process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
export const getFixModelName = () => process.env.GROQ_FIX_MODEL || process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
export const getReportModelName = () => process.env.GROQ_REPORT_MODEL || process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;

export const getReviewModel = () => groqModel(getReviewModelName());
export const getFixModel = () => groqModel(getFixModelName());
export const getReportModel = () => groqModel(getReportModelName());

export const getEmbeddingModel = () => {
    const modelName = process.env.EMBEDDING_MODEL;
    if (!modelName) {
        throw new Error("EMBEDDING_MODEL is not configured");
    }
    return google.textEmbeddingModel(modelName);
};
