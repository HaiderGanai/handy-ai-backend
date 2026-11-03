import { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase6Messages1793900000002 implements MigrationInterface {
  name = 'Phase6Messages1793900000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "bookingId" uuid NOT NULL, "senderId" uuid NOT NULL, "body" text NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_messages_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_bookingId_createdAt" ON "messages" ("bookingId", "createdAt")`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "FK_messages_bookingId" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "FK_messages_senderId" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_messages_senderId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_messages_bookingId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_messages_bookingId_createdAt"`,
    );
    await queryRunner.query(`DROP TABLE "messages"`);
  }
}
