import { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase5CheckoutSession1793900000001 implements MigrationInterface {
  name = 'Phase5CheckoutSession1793900000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bookings" ADD "checkoutSessionId" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bookings" DROP COLUMN "checkoutSessionId"`,
    );
  }
}
