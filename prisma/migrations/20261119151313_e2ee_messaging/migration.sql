-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('direct', 'group');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('admin', 'member');

-- CreateEnum
CREATE TYPE "EnvelopeType" AS ENUM ('prekey', 'whisper');

-- CreateTable
CREATE TABLE "device_keys" (
    "device_id" UUID NOT NULL,
    "registration_id" INTEGER NOT NULL,
    "identity_key" BYTEA NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "device_keys_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "signed_prekeys" (
    "device_id" UUID NOT NULL,
    "key_id" INTEGER NOT NULL,
    "public_key" BYTEA NOT NULL,
    "signature" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signed_prekeys_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "one_time_prekeys" (
    "device_id" UUID NOT NULL,
    "key_id" INTEGER NOT NULL,
    "public_key" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "one_time_prekeys_pkey" PRIMARY KEY ("device_id","key_id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "type" "ConversationType" NOT NULL,
    "direct_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_members" (
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("conversation_id","user_id")
);

-- CreateTable
CREATE TABLE "envelopes" (
    "id" UUID NOT NULL,
    "recipient_device_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_user_id" UUID NOT NULL,
    "sender_device_id" UUID NOT NULL,
    "type" "EnvelopeType" NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "server_timestamp" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_direct_key_key" ON "conversations"("direct_key");

-- CreateIndex
CREATE INDEX "conversation_members_user_id_idx" ON "conversation_members"("user_id");

-- CreateIndex
CREATE INDEX "envelopes_recipient_device_id_id_idx" ON "envelopes"("recipient_device_id", "id");

-- AddForeignKey
ALTER TABLE "device_keys" ADD CONSTRAINT "device_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signed_prekeys" ADD CONSTRAINT "signed_prekeys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "one_time_prekeys" ADD CONSTRAINT "one_time_prekeys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelopes" ADD CONSTRAINT "envelopes_recipient_device_id_fkey" FOREIGN KEY ("recipient_device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelopes" ADD CONSTRAINT "envelopes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
