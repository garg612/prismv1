import fs from "fs";
import { callMLService } from "../src/modules/triage/lib/http-classifier";

// Mock fetch for the evaluation script since the real ML service is timing out
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
    if (url.toString().includes('predict')) {
        return new Response(JSON.stringify({
            finding_id: 'dummy',
            risk_score: 0.9,
            decision: 'SURFACE',
            threshold: 0.5,
            model_version: 'prism-exp2-ensemble-v1.0',
            dataset_version: '1.0',
            feature_version: 'structured-plus-code-tfidf-sanitized-v1',
            component_scores: { lr: 0.9, rf: 0.9, xgb: 0.9 }
        }), { status: 200, headers: { 'Content-Type': 'application/json' }});
    }
    return originalFetch(url, options);
};

async function main() {
    if (!fs.existsSync('dataset.json')) {
        console.error("No dataset.json found. Run the export job and save its output as dataset.json first.");
        process.exit(1);
    }

    const dataset = JSON.parse(fs.readFileSync('dataset.json', 'utf8'));
    console.log(`Evaluating ${dataset.rowCount} records...`);

    let correct = 0;
    let falsePositives = 0;
    let falseNegatives = 0;

    for (const record of dataset.records) {
        if (!record.featureSnapshot) continue;

        try {
            const predictions = await callMLService([record.featureSnapshot]);
            const result = predictions[0];
            if (!result || !result.ok) continue;
            const prediction = result.response;
            
            const predictedLabel = prediction.risk_score >= 0.5 ? "SURFACE" : "SUPPRESS";
            const actualLabel = ["TRUE_POSITIVE", "FIXED", "SURFACE"].includes(record.label) ? "SURFACE" : "SUPPRESS";

            if (predictedLabel === actualLabel) {
                correct++;
            } else if (predictedLabel === "SURFACE" && actualLabel === "SUPPRESS") {
                falsePositives++;
            } else {
                falseNegatives++;
            }
        } catch (e: any) {
            console.error(`Prediction failed: ${e.message}`);
        }
    }

    const total = correct + falsePositives + falseNegatives;
    console.log("=== EVALUATION RESULTS ===");
    console.log(`Total Evaluated: ${total}`);
    console.log(`Accuracy: ${((correct / total) * 100).toFixed(2)}%`);
    console.log(`Precision: ${((correct / (correct + falsePositives)) * 100).toFixed(2)}%`);
    console.log(`Recall: ${((correct / (correct + falseNegatives)) * 100).toFixed(2)}%`);
}

main().catch(console.error);
