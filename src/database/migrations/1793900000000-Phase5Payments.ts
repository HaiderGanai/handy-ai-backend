import { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase5Payments1793900000000 implements MigrationInterface {
  name = 'Phase5Payments1793900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."bookings_status_enum" ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT' BEFORE 'PENDING_PROVIDER'`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "stripeCustomerId" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "providers" ADD "stripeOnboarded" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_status_enum" AS ENUM('HELD', 'CAPTURED', 'RELEASED', 'CANCELLED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "transactions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "bookingId" uuid NOT NULL, "stripeCheckoutSessionId" character varying NOT NULL, "stripePaymentIntentId" character varying NOT NULL, "stripeChargeId" character varying, "amountCents" integer NOT NULL, "commissionCents" integer NOT NULL, "providerPayoutCents" integer NOT NULL, "status" "public"."transactions_status_enum" NOT NULL DEFAULT 'HELD', "stripeTransferId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_transactions_bookingId" UNIQUE ("bookingId"), CONSTRAINT "PK_transactions_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "FK_f9ea0e567005f90669eff3ceded" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP CONSTRAINT "FK_f9ea0e567005f90669eff3ceded"`,
    );
    await queryRunner.query(`DROP TABLE "transactions"`);
    await queryRunner.query(`DROP TYPE "public"."transactions_status_enum"`);
    await queryRunner.query(
      `ALTER TABLE "providers" DROP COLUMN "stripeOnboarded"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "stripeCustomerId"`,
    );
    // ponytail: Postgres can't drop an enum value; the unused 'PENDING_PAYMENT' is harmless to leave
  }
}
