-- AlterTable
ALTER TABLE "review" ADD COLUMN     "headSha" TEXT;

-- CreateTable
CREATE TABLE "webhookEvent" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhookEvent_pkey" PRIMARY KEY ("id")
);
