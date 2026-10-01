import { createGoogleGenerativeAI } from "@ai-sdk/google";

export const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
});

export const getReviewModel = () => {
    const modelName = process.env.GEMINI_MODEL || "gemini-3.6-flash";
    return google(modelName);
};

export const getEmbeddingModel = () => {
    const modelName = process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004";
    return google.textEmbeddingModel(modelName);
};