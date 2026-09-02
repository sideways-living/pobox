ALTER TABLE "Mailbox" ADD COLUMN "parcelWaiting" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Mailbox" ADD COLUMN "latestParcelNotificationAt" TIMESTAMP(3);
ALTER TABLE "MailEvent" ADD COLUMN "notificationType" TEXT NOT NULL DEFAULT 'MAIL';
