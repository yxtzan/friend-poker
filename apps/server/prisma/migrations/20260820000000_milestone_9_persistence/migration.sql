-- CreateTable
CREATE TABLE "ApplicationState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "snapshotSchema" INTEGER NOT NULL,
    "runtimeVersion" INTEGER NOT NULL,
    "identityGeneration" INTEGER NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Identity" (
    "playerId" TEXT NOT NULL PRIMARY KEY,
    "nickname" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "credentialDigest" TEXT,
    "generation" INTEGER NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProcessedCommand" (
    "commandId" TEXT NOT NULL PRIMARY KEY,
    "principalKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "originalVersion" INTEGER NOT NULL,
    "originalStatus" TEXT NOT NULL,
    "dataJson" TEXT NOT NULL,
    "sitInitialGrant" BOOLEAN,
    "committedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Identity_credentialDigest_key" ON "Identity"("credentialDigest");

-- CreateIndex
CREATE INDEX "Identity_generation_nickname_idx" ON "Identity"("generation", "nickname");

-- CreateIndex
CREATE INDEX "ProcessedCommand_originalVersion_idx" ON "ProcessedCommand"("originalVersion");
