-- CreateIndex
CREATE UNIQUE INDEX "findingFeedback_findingId_userId_kind_key" ON "findingFeedback"("findingId", "userId", "kind");

-- CreateIndex
CREATE INDEX "findingFeedback_userId_kind_idx" ON "findingFeedback"("userId", "kind");
