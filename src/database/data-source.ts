import 'dotenv/config';
import { DataSource } from 'typeorm';

// ponytail: used only by the TypeORM CLI for migrations (npm run migration:*).
// The running app gets its connection from DatabaseModule/ConfigService instead.
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/*.ts'],
});
