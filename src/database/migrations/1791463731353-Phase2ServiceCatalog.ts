import { MigrationInterface, QueryRunner } from 'typeorm';

// Launch catalog from spec §2. Prices (USD cents) and durations are placeholder
// flat rates - the spec doesn't price them. Edit here before launch.
const CATALOG: Record<
  string,
  { name: string; subServices: [string, number, number][] }
> = {
  cleaning: {
    name: 'Cleaning',
    subServices: [
      ['Regular home clean', 8000, 120],
      ['Deep clean', 15000, 240],
      ['One-off clean', 10000, 150],
      ['End of tenancy clean', 22000, 300],
    ],
  },
  handyman: {
    name: 'Handyman',
    subServices: [
      ['Furniture assembly', 7000, 90],
      ['TV and shelf mounting', 8000, 60],
      ['Minor repairs', 9000, 90],
      ['Basic maintenance', 7500, 60],
    ],
  },
  electrical: {
    name: 'Electrical',
    subServices: [
      ['Light fixture installation', 9500, 60],
      ['Socket repairs', 8500, 60],
      ['Minor wiring fixes', 12000, 90],
      ['Switch replacements', 7500, 45],
    ],
  },
  plumbing: {
    name: 'Plumbing',
    subServices: [
      ['Leak repairs', 11000, 90],
      ['Blocked drains', 10000, 60],
      ['Tap replacement', 9000, 60],
      ['Toilet repairs', 10500, 90],
    ],
  },
};

const toSlug = (name: string) => name.toLowerCase().replace(/\s+/g, '-');

export class Phase2ServiceCatalog1791463731353 implements MigrationInterface {
  name = 'Phase2ServiceCatalog1791463731353';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."service_categories_name_enum" AS ENUM('Cleaning', 'Handyman', 'Electrical', 'Plumbing')`,
    );
    await queryRunner.query(
      `CREATE TABLE "service_categories" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" "public"."service_categories_name_enum" NOT NULL, "slug" character varying NOT NULL, "sortOrder" integer NOT NULL, CONSTRAINT "UQ_7ef2e28b495d09a4eb28997c653" UNIQUE ("name"), CONSTRAINT "UQ_88a33271b3d94a0c4bc14db3b76" UNIQUE ("slug"), CONSTRAINT "PK_fe4da5476c4ffe5aa2d3524ae68" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "sub_services" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "categoryId" uuid NOT NULL, "name" character varying NOT NULL, "slug" character varying NOT NULL, "basePriceCents" integer NOT NULL, "baseDurationMinutes" integer NOT NULL, "sortOrder" integer NOT NULL, CONSTRAINT "PK_8d0808cbbab4fad02bc41183a70" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "sub_services" ADD CONSTRAINT "FK_563b66279afb696b0c37e521176" FOREIGN KEY ("categoryId") REFERENCES "service_categories"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    let categoryOrder = 0;
    for (const [slug, category] of Object.entries(CATALOG)) {
      const [{ id }] = (await queryRunner.query(
        `INSERT INTO "service_categories" ("name", "slug", "sortOrder") VALUES ($1, $2, $3) RETURNING "id"`,
        [category.name, slug, categoryOrder++],
      )) as { id: string }[];
      for (const [
        index,
        [name, price, minutes],
      ] of category.subServices.entries()) {
        await queryRunner.query(
          `INSERT INTO "sub_services" ("categoryId", "name", "slug", "basePriceCents", "baseDurationMinutes", "sortOrder") VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, name, toSlug(name), price, minutes, index],
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sub_services" DROP CONSTRAINT "FK_563b66279afb696b0c37e521176"`,
    );
    await queryRunner.query(`DROP TABLE "sub_services"`);
    await queryRunner.query(`DROP TABLE "service_categories"`);
    await queryRunner.query(
      `DROP TYPE "public"."service_categories_name_enum"`,
    );
  }
}
