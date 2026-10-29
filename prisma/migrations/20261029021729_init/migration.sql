-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "SyncMode" AS ENUM ('initial', 'incremental', 'backfill');

-- CreateEnum
CREATE TYPE "PrState" AS ENUM ('OPEN', 'MERGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "IssueState" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ReviewState" AS ENUM ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING');

-- CreateTable
CREATE TABLE "repositories" (
    "id" SERIAL NOT NULL,
    "githubId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "hasIssuesEnabled" BOOLEAN NOT NULL,
    "hasPullRequests" BOOLEAN NOT NULL DEFAULT true,
    "coveredFrom" TIMESTAMPTZ,
    "coveredTo" TIMESTAMPTZ,
    "lastSyncedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" TEXT NOT NULL,
    "repositoryId" INTEGER NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'queued',
    "mode" "SyncMode" NOT NULL,
    "requestedFrom" TIMESTAMPTZ NOT NULL,
    "requestedTo" TIMESTAMPTZ NOT NULL,
    "pullRequests" INTEGER NOT NULL DEFAULT 0,
    "reviews" INTEGER NOT NULL DEFAULT 0,
    "issues" INTEGER NOT NULL DEFAULT 0,
    "commits" INTEGER NOT NULL DEFAULT 0,
    "rateLimitRemaining" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ,
    "finishedAt" TIMESTAMPTZ,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "actors" (
    "id" SERIAL NOT NULL,
    "login" TEXT NOT NULL,
    "isBot" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "actors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pull_requests" (
    "id" SERIAL NOT NULL,
    "repositoryId" INTEGER NOT NULL,
    "githubId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "authorId" INTEGER,
    "mergedById" INTEGER,
    "state" "PrState" NOT NULL,
    "isDraft" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "mergedAt" TIMESTAMPTZ,
    "closedAt" TIMESTAMPTZ,
    "additions" INTEGER NOT NULL,
    "deletions" INTEGER NOT NULL,
    "changedFiles" INTEGER NOT NULL,
    "baseRef" TEXT NOT NULL,

    CONSTRAINT "pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" SERIAL NOT NULL,
    "pullRequestId" INTEGER NOT NULL,
    "githubId" TEXT NOT NULL,
    "authorId" INTEGER,
    "state" "ReviewState" NOT NULL,
    "submittedAt" TIMESTAMPTZ NOT NULL,
    "commentCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issues" (
    "id" SERIAL NOT NULL,
    "repositoryId" INTEGER NOT NULL,
    "githubId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "authorId" INTEGER,
    "state" "IssueState" NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "closedAt" TIMESTAMPTZ,
    "labels" TEXT[],

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commits" (
    "id" SERIAL NOT NULL,
    "repositoryId" INTEGER NOT NULL,
    "sha" TEXT NOT NULL,
    "authorId" INTEGER,
    "authorName" TEXT NOT NULL,
    "committedDate" TIMESTAMPTZ NOT NULL,
    "additions" INTEGER NOT NULL,
    "deletions" INTEGER NOT NULL,

    CONSTRAINT "commits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "narratives" (
    "id" SERIAL NOT NULL,
    "repositoryId" INTEGER NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "usage" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "narratives_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repositories_githubId_key" ON "repositories"("githubId");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_owner_name_key" ON "repositories"("owner", "name");

-- CreateIndex
CREATE INDEX "sync_jobs_repositoryId_status_idx" ON "sync_jobs"("repositoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "actors_login_key" ON "actors"("login");

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_githubId_key" ON "pull_requests"("githubId");

-- CreateIndex
CREATE INDEX "pull_requests_repositoryId_createdAt_idx" ON "pull_requests"("repositoryId", "createdAt");

-- CreateIndex
CREATE INDEX "pull_requests_repositoryId_mergedAt_idx" ON "pull_requests"("repositoryId", "mergedAt");

-- CreateIndex
CREATE INDEX "pull_requests_repositoryId_closedAt_idx" ON "pull_requests"("repositoryId", "closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_repositoryId_number_key" ON "pull_requests"("repositoryId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_githubId_key" ON "reviews"("githubId");

-- CreateIndex
CREATE INDEX "reviews_pullRequestId_submittedAt_idx" ON "reviews"("pullRequestId", "submittedAt");

-- CreateIndex
CREATE INDEX "reviews_authorId_submittedAt_idx" ON "reviews"("authorId", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "issues_githubId_key" ON "issues"("githubId");

-- CreateIndex
CREATE INDEX "issues_repositoryId_createdAt_idx" ON "issues"("repositoryId", "createdAt");

-- CreateIndex
CREATE INDEX "issues_repositoryId_closedAt_idx" ON "issues"("repositoryId", "closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "issues_repositoryId_number_key" ON "issues"("repositoryId", "number");

-- CreateIndex
CREATE INDEX "commits_repositoryId_committedDate_idx" ON "commits"("repositoryId", "committedDate");

-- CreateIndex
CREATE UNIQUE INDEX "commits_repositoryId_sha_key" ON "commits"("repositoryId", "sha");

-- CreateIndex
CREATE UNIQUE INDEX "narratives_cacheKey_key" ON "narratives"("cacheKey");

-- CreateIndex
CREATE INDEX "narratives_repositoryId_createdAt_idx" ON "narratives"("repositoryId", "createdAt");

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "actors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_mergedById_fkey" FOREIGN KEY ("mergedById") REFERENCES "actors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "actors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "actors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commits" ADD CONSTRAINT "commits_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commits" ADD CONSTRAINT "commits_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "actors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "narratives" ADD CONSTRAINT "narratives_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
