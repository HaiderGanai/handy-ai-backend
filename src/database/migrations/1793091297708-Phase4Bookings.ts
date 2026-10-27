import { MigrationInterface, QueryRunner } from "typeorm";

export class Phase4Bookings1793091297708 implements MigrationInterface {
    name = 'Phase4Bookings1793091297708'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "trusted_providers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "providerId" uuid NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_8207d91e74b43bb7c9bc083ff9c" UNIQUE ("userId", "providerId"), CONSTRAINT "PK_10935843bc1ecc3719ceda14fd3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."bookings_status_enum" AS ENUM('PENDING_PROVIDER', 'CONFIRMED', 'DECLINED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')`);
        await queryRunner.query(`CREATE TABLE "bookings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "providerId" uuid NOT NULL, "subServiceId" uuid NOT NULL, "scheduledAt" TIMESTAMP WITH TIME ZONE NOT NULL, "durationMinutes" integer NOT NULL, "priceCents" integer NOT NULL, "status" "public"."bookings_status_enum" NOT NULL DEFAULT 'PENDING_PROVIDER', "notes" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_bee6805982cc1e248e94ce94957" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "trusted_providers" ADD CONSTRAINT "FK_abc5b2823506d29f9abee20cf86" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "trusted_providers" ADD CONSTRAINT "FK_9348d66e157133881aeb9d0a051" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "bookings" ADD CONSTRAINT "FK_38a69a58a323647f2e75eb994de" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "bookings" ADD CONSTRAINT "FK_4f8605bc996f6c39ebd7dbead7b" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "bookings" ADD CONSTRAINT "FK_b1deb397c84ba3f56403d6e0c16" FOREIGN KEY ("subServiceId") REFERENCES "sub_services"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bookings" DROP CONSTRAINT "FK_b1deb397c84ba3f56403d6e0c16"`);
        await queryRunner.query(`ALTER TABLE "bookings" DROP CONSTRAINT "FK_4f8605bc996f6c39ebd7dbead7b"`);
        await queryRunner.query(`ALTER TABLE "bookings" DROP CONSTRAINT "FK_38a69a58a323647f2e75eb994de"`);
        await queryRunner.query(`ALTER TABLE "trusted_providers" DROP CONSTRAINT "FK_9348d66e157133881aeb9d0a051"`);
        await queryRunner.query(`ALTER TABLE "trusted_providers" DROP CONSTRAINT "FK_abc5b2823506d29f9abee20cf86"`);
        await queryRunner.query(`DROP TABLE "bookings"`);
        await queryRunner.query(`DROP TYPE "public"."bookings_status_enum"`);
        await queryRunner.query(`DROP TABLE "trusted_providers"`);
    }

}
