import { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase9HandyChat1793900000003 implements MigrationInterface {
  name = 'Phase9HandyChat1793900000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."handy_messages_role_enum" AS ENUM('USER', 'ASSISTANT')`,
    );
    await queryRunner.query(
      `CREATE TABLE "handy_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "role" "public"."handy_messages_role_enum" NOT NULL, "content" text NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_handy_messages_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_handy_messages_userId_createdAt" ON "handy_messages" ("userId", "createdAt")`,
    );
    await queryRunner.query(
      `ALTER TABLE "handy_messages" ADD CONSTRAINT "FK_handy_messages_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "handy_messages" DROP CONSTRAINT "FK_handy_messages_userId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_handy_messages_userId_createdAt"`,
    );
    await queryRunner.query(`DROP TABLE "handy_messages"`);
    await queryRunner.query(`DROP TYPE "public"."handy_messages_role_enum"`);
  }
}
