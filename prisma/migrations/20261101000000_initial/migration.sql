CREATE TABLE "Employee"("id" UUID PRIMARY KEY,"tenantId" UUID NOT NULL,"userId" UUID NOT NULL,"name" TEXT NOT NULL,"email" TEXT NOT NULL,"phone" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "Employee_tenantId_userId_key" ON "Employee"("tenantId","userId");
CREATE UNIQUE INDEX "Employee_tenantId_email_key" ON "Employee"("tenantId","email");
CREATE TABLE "Announcement"("id" UUID PRIMARY KEY,"tenantId" UUID NOT NULL,"authorId" UUID NOT NULL,"title" TEXT NOT NULL,"body" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "Notification"("id" UUID PRIMARY KEY,"tenantId" UUID NOT NULL,"userId" UUID NOT NULL,"announcementId" UUID NOT NULL,"title" TEXT NOT NULL,"phone" TEXT,"status" TEXT NOT NULL DEFAULT 'pending',"attempts" INTEGER NOT NULL DEFAULT 0,"nextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"deliveredAt" TIMESTAMP(3));
CREATE UNIQUE INDEX "Notification_announcementId_userId_key" ON "Notification"("announcementId","userId");
