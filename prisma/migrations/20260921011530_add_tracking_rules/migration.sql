-- CreateTable
CREATE TABLE "TrackingRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "pageType" TEXT NOT NULL,
    "pageHandle" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "selector" TEXT,
    "urlPattern" TEXT,
    "matchMode" TEXT NOT NULL DEFAULT 'contains',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "parameters" TEXT NOT NULL DEFAULT '[]',
    "options" TEXT NOT NULL DEFAULT '{}',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "TrackingRule_shop_pageType_pageHandle_idx" ON "TrackingRule"("shop", "pageType", "pageHandle");
