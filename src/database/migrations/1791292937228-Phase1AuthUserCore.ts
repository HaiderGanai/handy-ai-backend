import { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase1AuthUserCore1791292937228 implements MigrationInterface {
  name = 'Phase1AuthUserCore1791292937228';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "user_sessions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" character varying NOT NULL, "refreshTokenHash" character varying NOT NULL, "userAgent" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_e93e031a5fed190d4789b6bfd83" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."users_role_enum" AS ENUM('CUSTOMER', 'PROVIDER', 'ADMIN')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."users_otppurpose_enum" AS ENUM('SIGNUP', 'RESET_PASSWORD')`,
    );
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "password" character varying NOT NULL, "role" "public"."users_role_enum" NOT NULL DEFAULT 'CUSTOMER', "isEmailVerified" boolean NOT NULL DEFAULT false, "otpCode" character varying, "otpExpiresAt" TIMESTAMP WITH TIME ZONE, "otpPurpose" "public"."users_otppurpose_enum", "resetToken" character varying, "resetTokenExpiresAt" TIMESTAMP WITH TIME ZONE, "fullName" character varying, "address" character varying, "postcode" character varying, "photoUrl" character varying, "householdNotes" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "public"."users_otppurpose_enum"`);
    await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
    await queryRunner.query(`DROP TABLE "user_sessions"`);
  }
}
