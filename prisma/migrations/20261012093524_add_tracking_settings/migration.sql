-- CreateTable
CREATE TABLE "TrackingSetting" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "gtmId" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL
);
