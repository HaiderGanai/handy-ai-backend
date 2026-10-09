import { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase3ProvidersVetting1791547812703 implements MigrationInterface {
  name = 'Phase3ProvidersVetting1791547812703';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "provider_availability" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "dayOfWeek" smallint NOT NULL, "startTime" TIME NOT NULL, "endTime" TIME NOT NULL, "providerId" uuid, CONSTRAINT "PK_b71cd0a5d4be0a7c6851c51a7b3" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."provider_documents_type_enum" AS ENUM('GOVERNMENT_ID', 'RIGHT_TO_WORK', 'LIABILITY_INSURANCE', 'REFERENCE', 'PROFILE_PHOTO')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."provider_documents_status_enum" AS ENUM('PENDING', 'APPROVED', 'REJECTED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "provider_documents" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" "public"."provider_documents_type_enum" NOT NULL, "fileUrl" character varying NOT NULL, "status" "public"."provider_documents_status_enum" NOT NULL DEFAULT 'PENDING', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "providerId" uuid, CONSTRAINT "UQ_8c7d41dbc767b30b236fa20a4e2" UNIQUE ("providerId", "type"), CONSTRAINT "PK_bc3bb226a18aa1bbae0baa7df15" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."providers_status_enum" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'DISABLED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "providers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "bio" text NOT NULL, "postcodeCoverage" text array NOT NULL, "status" "public"."providers_status_enum" NOT NULL DEFAULT 'PENDING', "rejectionReason" character varying, "stripeAccountId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_b0a257f97e76b698c4935b27d7d" UNIQUE ("userId"), CONSTRAINT "REL_b0a257f97e76b698c4935b27d7" UNIQUE ("userId"), CONSTRAINT "PK_af13fc2ebf382fe0dad2e4793aa" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "provider_service_categories" ("providersId" uuid NOT NULL, "serviceCategoriesId" uuid NOT NULL, CONSTRAINT "PK_009d0ff10fbe156fb8a4f5a4726" PRIMARY KEY ("providersId", "serviceCategoriesId"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6eb7cea06eff84e07c30176fa7" ON "provider_service_categories" ("providersId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_01690262564d6611f83e8f6a61" ON "provider_service_categories" ("serviceCategoriesId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "provider_availability" ADD CONSTRAINT "FK_fa92eee4165a2827afb5a7ea78b" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "provider_documents" ADD CONSTRAINT "FK_e52b33e718dd5d668ace46ab063" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "providers" ADD CONSTRAINT "FK_b0a257f97e76b698c4935b27d7d" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "provider_service_categories" ADD CONSTRAINT "FK_6eb7cea06eff84e07c30176fa7e" FOREIGN KEY ("providersId") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "provider_service_categories" ADD CONSTRAINT "FK_01690262564d6611f83e8f6a61a" FOREIGN KEY ("serviceCategoriesId") REFERENCES "service_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "provider_service_categories" DROP CONSTRAINT "FK_01690262564d6611f83e8f6a61a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "provider_service_categories" DROP CONSTRAINT "FK_6eb7cea06eff84e07c30176fa7e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "providers" DROP CONSTRAINT "FK_b0a257f97e76b698c4935b27d7d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "provider_documents" DROP CONSTRAINT "FK_e52b33e718dd5d668ace46ab063"`,
    );
    await queryRunner.query(
      `ALTER TABLE "provider_availability" DROP CONSTRAINT "FK_fa92eee4165a2827afb5a7ea78b"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_01690262564d6611f83e8f6a61"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_6eb7cea06eff84e07c30176fa7"`,
    );
    await queryRunner.query(`DROP TABLE "provider_service_categories"`);
    await queryRunner.query(`DROP TABLE "providers"`);
    await queryRunner.query(`DROP TYPE "public"."providers_status_enum"`);
    await queryRunner.query(`DROP TABLE "provider_documents"`);
    await queryRunner.query(
      `DROP TYPE "public"."provider_documents_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."provider_documents_type_enum"`,
    );
    await queryRunner.query(`DROP TABLE "provider_availability"`);
  }
}
