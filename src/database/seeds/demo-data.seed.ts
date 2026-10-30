import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { SubService } from '../../catalog/entities/sub-service.entity';
import { ServiceCategory } from '../../catalog/entities/service-category.entity';
import { ServiceCategoryName } from '../../catalog/enums/service-category-name.enum';
import { Booking } from '../../booking/entities/booking.entity';
import { TrustedProvider } from '../../booking/entities/trusted-provider.entity';
import { BookingStatus } from '../../booking/enums/booking-status.enum';
import { ACTIVE_BOOKING_STATUSES } from '../../booking/enums/booking-status.enum';
import { coversPostcode, overlaps } from '../../booking/eligibility';
import { ProviderDocument } from '../../provider/entities/provider-document.entity';
import { Transaction } from '../../payments/entities/transaction.entity';
import { TransactionStatus } from '../../payments/enums/transaction-status.enum';
import { splitAmount } from '../../payments/money';
import { Provider } from '../../provider/entities/provider.entity';
import { DocumentStatus } from '../../provider/enums/document-status.enum';
import { DocumentType } from '../../provider/enums/document-type.enum';
import { ProviderStatus } from '../../provider/enums/provider-status.enum';
import { User } from '../../user/entities/user.entity';
import { Role } from '../../user/enums/role.enum';

// Dev/demo data for frontend testing. Re-runnable: it first removes its own rows
// (emails ending DEMO_DOMAIN) and never touches anything else.
//   npm run seed:demo          create / reset the demo data
//   npm run seed:demo:remove   remove it
const DEMO_DOMAIN = '@handyai-demo.dev';
const PASSWORD = 'Demo@1234';

// the one demo provider who skipped Stripe: her completed jobs show as "awaiting payout"
const UNCONNECTED = 'grace';

const C = ServiceCategoryName;
const POSTCODES = ['SW1A 1AA', 'SW3 4HN', 'E1 6AN', 'N1 9GU', 'W1D 3QU'];

const CUSTOMERS = [
  {
    key: 'olivia',
    name: 'Olivia Bennett',
    address: '12 Eccleston Sq, London',
    postcode: POSTCODES[0],
    notes: 'Key safe 4821 by the front door',
  },
  {
    key: 'liam',
    name: 'Liam Carter',
    address: '88 Fulham Rd, London',
    postcode: POSTCODES[1],
    notes: 'Ring the bell twice, the dog is friendly',
  },
  {
    key: 'emma',
    name: 'Emma Davies',
    address: '5 Brick Ln, London',
    postcode: POSTCODES[2],
    notes: 'Visitor parking permit is on the dashboard',
  },
  {
    key: 'noah',
    name: 'Noah Evans',
    address: '27 Upper St, London',
    postcode: POSTCODES[3],
    notes: 'Concierge holds the spare key',
  },
  {
    key: 'ava',
    name: 'Ava Foster',
    address: '14 Wardour St, London',
    postcode: POSTCODES[4],
    notes: 'Second floor, no lift',
  },
];

const PROVIDERS = [
  {
    key: 'marcus',
    name: 'Marcus Reed',
    bio: '12 years of professional home cleaning.',
    cats: [C.CLEANING],
    coverage: [POSTCODES[0], POSTCODES[1], POSTCODES[2]],
  },
  {
    key: 'sofia',
    name: 'Sofia Alvarez',
    bio: 'Deep cleans and end-of-tenancy specialist.',
    cats: [C.CLEANING],
    coverage: [POSTCODES[3], POSTCODES[4], POSTCODES[2], POSTCODES[0]],
  },
  {
    key: 'daniel',
    name: 'Daniel Brooks',
    bio: 'Flat-pack, shelving and general handyman jobs.',
    cats: [C.HANDYMAN],
    coverage: POSTCODES,
  },
  {
    key: 'priya',
    name: 'Priya Shah',
    bio: 'NICEIC-registered electrician, 9 years.',
    cats: [C.ELECTRICAL],
    coverage: POSTCODES,
  },
  {
    key: 'tom',
    name: 'Tom Hughes',
    bio: 'Gas-safe plumber for leaks, drains and taps.',
    cats: [C.PLUMBING],
    coverage: POSTCODES,
  },
  {
    key: 'grace',
    name: 'Grace Liu',
    bio: 'Handyman and cleaner, reliable and tidy.',
    cats: [C.HANDYMAN, C.CLEANING],
    coverage: POSTCODES,
  },
];

type Spec = {
  customer: string;
  provider: string;
  category: ServiceCategoryName;
  sub: number; // index within the category's sub-services (by sortOrder)
  status: BookingStatus;
  day?: number; // days from today (UTC); skips Sundays
  hour?: number; // hour of day (UTC)
  minutesAgo?: number; // IN_PROGRESS: started this long ago
  notes?: string;
};
const S = BookingStatus;
const BOOKINGS: Spec[] = [
  // completed (history)
  {
    customer: 'olivia',
    provider: 'marcus',
    category: C.CLEANING,
    sub: 0,
    status: S.COMPLETED,
    day: -45,
    hour: 10,
  },
  {
    customer: 'olivia',
    provider: 'marcus',
    category: C.CLEANING,
    sub: 1,
    status: S.COMPLETED,
    day: -14,
    hour: 9,
    notes: 'Please focus on the kitchen',
  },
  {
    customer: 'liam',
    provider: 'daniel',
    category: C.HANDYMAN,
    sub: 0,
    status: S.COMPLETED,
    day: -30,
    hour: 14,
  },
  {
    customer: 'emma',
    provider: 'priya',
    category: C.ELECTRICAL,
    sub: 1,
    status: S.COMPLETED,
    day: -21,
    hour: 11,
  },
  {
    customer: 'noah',
    provider: 'tom',
    category: C.PLUMBING,
    sub: 0,
    status: S.COMPLETED,
    day: -9,
    hour: 15,
  },
  {
    customer: 'ava',
    provider: 'sofia',
    category: C.CLEANING,
    sub: 2,
    status: S.COMPLETED,
    day: -6,
    hour: 10,
  },
  {
    customer: 'liam',
    provider: 'grace',
    category: C.HANDYMAN,
    sub: 2,
    status: S.COMPLETED,
    day: -3,
    hour: 13,
  },
  {
    customer: 'emma',
    provider: 'marcus',
    category: C.CLEANING,
    sub: 0,
    status: S.COMPLETED,
    day: -2,
    hour: 16,
  },
  // in progress right now
  {
    customer: 'olivia',
    provider: 'priya',
    category: C.ELECTRICAL,
    sub: 2,
    status: S.IN_PROGRESS,
    minutesAgo: 40,
  },
  {
    customer: 'noah',
    provider: 'sofia',
    category: C.CLEANING,
    sub: 1,
    status: S.IN_PROGRESS,
    minutesAgo: 90,
  },
  {
    customer: 'ava',
    provider: 'tom',
    category: C.PLUMBING,
    sub: 3,
    status: S.IN_PROGRESS,
    minutesAgo: 20,
  },
  // confirmed, coming up (provider can press start)
  {
    customer: 'liam',
    provider: 'marcus',
    category: C.CLEANING,
    sub: 0,
    status: S.CONFIRMED,
    day: 1,
    hour: 10,
  },
  {
    customer: 'emma',
    provider: 'daniel',
    category: C.HANDYMAN,
    sub: 1,
    status: S.CONFIRMED,
    day: 2,
    hour: 12,
  },
  {
    customer: 'olivia',
    provider: 'grace',
    category: C.HANDYMAN,
    sub: 3,
    status: S.CONFIRMED,
    day: 3,
    hour: 9,
  },
  {
    customer: 'ava',
    provider: 'priya',
    category: C.ELECTRICAL,
    sub: 3,
    status: S.CONFIRMED,
    day: 5,
    hour: 15,
  },
  // waiting for the provider to accept / decline
  {
    customer: 'noah',
    provider: 'daniel',
    category: C.HANDYMAN,
    sub: 2,
    status: S.PENDING_PROVIDER,
    day: 4,
    hour: 11,
  },
  {
    customer: 'liam',
    provider: 'tom',
    category: C.PLUMBING,
    sub: 2,
    status: S.PENDING_PROVIDER,
    day: 6,
    hour: 14,
  },
  {
    customer: 'emma',
    provider: 'sofia',
    category: C.CLEANING,
    sub: 0,
    status: S.PENDING_PROVIDER,
    day: 7,
    hour: 10,
  },
  // declined by the provider
  {
    customer: 'olivia',
    provider: 'tom',
    category: C.PLUMBING,
    sub: 1,
    status: S.DECLINED,
    day: 2,
    hour: 16,
  },
  {
    customer: 'noah',
    provider: 'sofia',
    category: C.CLEANING,
    sub: 3,
    status: S.DECLINED,
    day: 8,
    hour: 9,
  },
  // cancelled by the customer
  {
    customer: 'ava',
    provider: 'daniel',
    category: C.HANDYMAN,
    sub: 0,
    status: S.CANCELLED,
    day: 3,
    hour: 10,
  },
  {
    customer: 'liam',
    provider: 'priya',
    category: C.ELECTRICAL,
    sub: 0,
    status: S.CANCELLED,
    day: 9,
    hour: 13,
  },
];

// customer -> provider pairs marked trusted (each has a COMPLETED job above)
const TRUSTED: [string, string][] = [
  ['olivia', 'marcus'],
  ['liam', 'daniel'],
  ['noah', 'tom'],
  ['ava', 'sofia'],
];

const email = (kind: 'customer' | 'provider', key: string) =>
  `${kind}.${key}${DEMO_DOMAIN}`;

async function removeDemoData(dataSource: DataSource): Promise<void> {
  await dataSource.transaction(async (manager) => {
    // bookings reference providers with RESTRICT, so they go first
    await manager.query(
      `DELETE FROM bookings WHERE "userId" IN (SELECT id FROM users WHERE email LIKE $1)
         OR "providerId" IN (SELECT p.id FROM providers p JOIN users u ON u.id = p."userId" WHERE u.email LIKE $1)`,
      [`%${DEMO_DOMAIN}`],
    );
    await manager.query(`DELETE FROM users WHERE email LIKE $1`, [
      `%${DEMO_DOMAIN}`,
    ]);
  });
}

function slot(dayOffset: number, hour: number): Date {
  const date = new Date();
  date.setUTCHours(hour, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  // providers don't work Sundays
  if (date.getUTCDay() === 0) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date;
}

async function seed(dataSource: DataSource): Promise<void> {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const categories = await dataSource.getRepository(ServiceCategory).find();
  const subServices = await dataSource
    .getRepository(SubService)
    .find({ order: { sortOrder: 'ASC' } });
  const categoryByName = new Map(categories.map((c) => [c.name, c]));
  const subsOf = (name: ServiceCategoryName) =>
    subServices.filter((s) => s.categoryId === categoryByName.get(name)!.id);

  await dataSource.transaction(async (manager) => {
    const users = new Map<string, User>();
    const providers = new Map<string, Provider>();

    let photo = 1;
    for (const c of CUSTOMERS) {
      users.set(
        c.key,
        await manager.save(
          manager.create(User, {
            email: email('customer', c.key),
            password: passwordHash,
            role: Role.CUSTOMER,
            isEmailVerified: true,
            fullName: c.name,
            address: c.address,
            postcode: c.postcode,
            photoUrl: `https://i.pravatar.cc/300?img=${photo++}`,
            householdNotes: c.notes,
          }),
        ),
      );
    }

    for (const p of PROVIDERS) {
      const user = await manager.save(
        manager.create(User, {
          email: email('provider', p.key),
          password: passwordHash,
          role: Role.PROVIDER,
          isEmailVerified: true,
          fullName: p.name,
          address: 'London',
          postcode: p.coverage[0],
          photoUrl: `https://i.pravatar.cc/300?img=${photo++ + 10}`,
        }),
      );
      const provider = await manager.save(
        manager.create(Provider, {
          userId: user.id,
          bio: p.bio,
          postcodeCoverage: p.coverage,
          status: ProviderStatus.APPROVED,
          stripeAccountId: p.key === UNCONNECTED ? null : `acct_demo_${p.key}`,
          stripeOnboarded: p.key !== UNCONNECTED,
          categories: p.cats.map((name) => categoryByName.get(name)!),
          // Mon-Sat 08:00-20:00 (UTC)
          availability: [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
            dayOfWeek,
            startTime: '08:00',
            endTime: '20:00',
          })) as Provider['availability'],
        }),
      );
      await manager.save(
        Object.values(DocumentType).map((type) =>
          manager.create(ProviderDocument, {
            provider,
            type,
            fileUrl: `https://placehold.co/800x600?text=${p.key}+${type}`,
            status: DocumentStatus.APPROVED,
          }),
        ),
      );
      users.set(p.key, user);
      providers.set(p.key, provider);
    }

    const now = Date.now();
    const placed: Booking[] = [];
    for (const spec of BOOKINGS) {
      const customerSeed = CUSTOMERS.find((c) => c.key === spec.customer)!;
      const provider = providers.get(spec.provider)!;
      const sub = subsOf(spec.category)[spec.sub];
      const scheduledAt =
        spec.minutesAgo !== undefined
          ? new Date(now - spec.minutesAgo * 60_000)
          : slot(spec.day!, spec.hour!);

      // the same rules the plan endpoint enforces, so the dataset stays valid
      if (
        !provider.categories.some((c) => c.id === sub.categoryId) ||
        !coversPostcode(provider.postcodeCoverage, customerSeed.postcode)
      ) {
        throw new Error(
          `Bad seed row: ${spec.customer} -> ${spec.provider} (${spec.category})`,
        );
      }
      if (
        ACTIVE_BOOKING_STATUSES.includes(spec.status) &&
        placed.some(
          (other) =>
            other.providerId === provider.id &&
            ACTIVE_BOOKING_STATUSES.includes(other.status) &&
            overlaps(
              other.scheduledAt,
              other.durationMinutes,
              scheduledAt,
              sub.baseDurationMinutes,
            ),
        )
      ) {
        throw new Error(
          `Overlap for ${spec.provider} at ${scheduledAt.toISOString()}`,
        );
      }

      const createdAt = new Date(
        Math.min(now, scheduledAt.getTime() - 3 * 24 * 3600_000),
      );
      const booking = await manager.save(
        manager.create(Booking, {
          userId: users.get(spec.customer)!.id,
          providerId: provider.id,
          subServiceId: sub.id,
          scheduledAt,
          durationMinutes: sub.baseDurationMinutes,
          priceCents: sub.basePriceCents,
          status: spec.status,
          notes: spec.notes ?? null,
          createdAt,
        }),
      );
      placed.push(booking);

      // payment record (fake Stripe ids): paid bookings hold the card, finished ones are captured
      const n = placed.length;
      const { commissionCents, providerPayoutCents } = splitAmount(
        booking.priceCents,
      );
      const txStatus =
        spec.status === S.COMPLETED
          ? provider.stripeOnboarded
            ? TransactionStatus.RELEASED
            : TransactionStatus.CAPTURED
          : spec.status === S.DECLINED || spec.status === S.CANCELLED
            ? TransactionStatus.CANCELLED
            : TransactionStatus.HELD; // PENDING_PROVIDER, CONFIRMED, IN_PROGRESS
      const captured =
        txStatus === TransactionStatus.RELEASED ||
        txStatus === TransactionStatus.CAPTURED;
      await manager.save(
        manager.create(Transaction, {
          bookingId: booking.id,
          stripeCheckoutSessionId: `cs_demo_${n}`,
          stripePaymentIntentId: `pi_demo_${n}`,
          stripeChargeId: captured ? `ch_demo_${n}` : null,
          amountCents: booking.priceCents,
          commissionCents,
          providerPayoutCents,
          status: txStatus,
          stripeTransferId:
            txStatus === TransactionStatus.RELEASED ? `tr_demo_${n}` : null,
        }),
      );
    }

    await manager.save(
      TRUSTED.map(([customer, provider]) =>
        manager.create(TrustedProvider, {
          userId: users.get(customer)!.id,
          providerId: providers.get(provider)!.id,
        }),
      ),
    );
  });
}

async function main(): Promise<void> {
  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities: ['src/**/*.entity.ts'],
  });
  await dataSource.initialize();
  const host = new URL(process.env.DATABASE_URL!).host;
  const removeOnly = process.argv.includes('--remove');
  console.log(`Target database: ${host}`);
  try {
    await removeDemoData(dataSource);
    if (removeOnly) {
      console.log('Demo data removed.');
      return;
    }
    await seed(dataSource);
    const count = async (table: string, where = 'TRUE'): Promise<number> => {
      const rows: { n: number }[] = await dataSource.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      );
      return rows[0].n;
    };
    console.log(
      `Seeded: ${CUSTOMERS.length} customers, ${PROVIDERS.length} providers, ` +
        `${await count('bookings', `"userId" IN (SELECT id FROM users WHERE email LIKE '%${DEMO_DOMAIN}')`)} bookings, ` +
        `${await count('transactions', `"bookingId" IN (SELECT id FROM bookings WHERE "userId" IN (SELECT id FROM users WHERE email LIKE '%${DEMO_DOMAIN}'))`)} payment records, ` +
        `${TRUSTED.length} trusted-provider links.`,
    );
    console.log(`Password for every demo account: ${PASSWORD}`);
  } finally {
    await dataSource.destroy();
  }
}

void main().catch((error) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
