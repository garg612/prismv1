import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

describe('Stage 9: Dataset Export & De-identification', () => {
    const datasetPath = path.resolve(process.cwd(), 'dataset.json');

    beforeAll(() => {
        // Clean up previous artifacts if any
        if (fs.existsSync(datasetPath)) {
            fs.unlinkSync(datasetPath);
        }
        // Run the seeding and export logic
        execSync('npx tsx scripts/seed-and-export.ts', { stdio: 'pipe' });
    }, 60000);

    it('generates a valid de-identified dataset artifact', () => {
        // Assert artifact exists
        expect(fs.existsSync(datasetPath)).toBe(true);
        
        const raw = fs.readFileSync(datasetPath, 'utf8');
        const dataset = JSON.parse(raw);
        
        // Assert row count > 0
        expect(dataset.rowCount).toBeGreaterThan(0);
        expect(dataset.records.length).toBeGreaterThan(0);
        expect(dataset.records.length).toBe(dataset.rowCount);
        
        // Assert checksum exists
        expect(dataset.checksum).toBeDefined();
        
        for (const record of dataset.records) {
            // Assert core fields exist
            expect(record.label).toBeDefined();
            expect(record.featureSnapshot).toBeDefined();
            expect(record.score).toBeDefined();
            expect(record.modelName).toBeDefined();
            
            // Assert forbidden PII and source code absent
            expect(record.filePath).toBeUndefined();
            expect(record.message).toBeUndefined();
            expect(record.rawCode).toBeUndefined();
            expect(record.githubUrl).toBeUndefined();
            expect(record.userId).toBeUndefined();
            expect(record.secrets).toBeUndefined();
            expect(record.repository).toBeUndefined();
            expect(record.githubId).toBeUndefined();
        }
    });
});
