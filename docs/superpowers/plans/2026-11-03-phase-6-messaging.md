# Phase 6 — In-App Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The customer and assigned provider of a booking can message each other via REST; nobody else can.

**Architecture:** New `MessagingModule` (`src/messaging/`) with a `Message` entity, `MessagingService` and `MessagingController` mounted at `bookings/:id/messages`. Access is decided by one private helper that loads the booking and checks the caller is its customer or assigned provider (404 otherwise). Polling via an `after` message-id cursor.

**Tech Stack:** NestJS 11, TypeORM 0.3.x, class-validator, Jest. Follow `GUIDE.md` (controller method name == service method name; DTOs; short lowercase step comments; errors end with `!`).

**Spec:** `docs/superpowers/specs/2026-11-03-phase-6-messaging-design.md`

## Global Constraints

- Routes: `POST /bookings/:id/messages`, `GET /bookings/:id/messages`; roles `CUSTOMER` and `PROVIDER` only; JWT guard + `RolesGuard` as in `src/booking/booking.controller.ts`.
- Non-participants (incl. admins) and providers on `PENDING_PAYMENT` bookings -> `NotFoundException('Booking not found!')`.
- Write allowed only in `PENDING_PROVIDER`, `CONFIRMED`, `IN_PROGRESS`; otherwise `ConflictException('Messaging is closed for this booking!')`. Read allowed in every status.
- Body: trimmed, 1-1000 chars. `limit`: 1-100, default 50.
- Response message shape exactly `{ id, bookingId, senderId, sender: 'CUSTOMER' | 'PROVIDER', body, createdAt }` - never user email/phone/address.
- After a send call `notificationsService.notify(otherUserId, 'MESSAGE_RECEIVED', { bookingId })` (no body in the payload).
- Migrations only (no `synchronize`); run `npm run migration:run` locally and verify the table exists.

## Review Focus

- Customer of a *different* booking tries to read/write -> 404 (Task 2, 3 tests).
- Provider reads a `PENDING_PAYMENT` booking's thread -> 404 (Task 2).
- Writing to a CANCELLED/COMPLETED/DECLINED/PENDING_PAYMENT booking -> 409 (Task 2).
- Whitespace-only or 1001-char body -> 400 (Task 2 DTO test).
- `after` id that isn't in this booking (e.g. from another booking) -> 400, not a data leak (Task 3).

## File structure

```
src/messaging/entities/message.entity.ts        Message entity
src/messaging/dto/send-message.dto.ts           SendMessageDto
src/messaging/dto/list-messages-query.dto.ts    ListMessagesQueryDto
src/messaging/messaging.service.ts (+ .spec.ts) access check, send, list
src/messaging/messaging.controller.ts           thin routes
src/messaging/messaging.module.ts
src/database/migrations/1793900000002-Phase6Messages.ts
modified: src/app.module.ts, demo seed, docs, Postman, PLAN.md, CLAUDE.md
```

---

### Task 1: Message entity, migration, module wiring

**Files:**
- Create: `src/messaging/entities/message.entity.ts`, `src/messaging/messaging.module.ts`, `src/database/migrations/1793900000002-Phase6Messages.ts`
- Modify: `src/app.module.ts` (import `MessagingModule`)

**Interfaces:**
- Produces: `Message` entity `{ id: string; bookingId: string; senderId: string; body: string; createdAt: Date }` with `@Index(['bookingId', 'createdAt'])`; relations to `Booking` and `User`, both `onDelete: 'CASCADE'`.
- Produces: `MessagingModule` importing `TypeOrmModule.forFeature([Message, Booking])` and `NotificationsModule`; controllers/providers added in Task 2.

- [ ] **Step 1: Create the entity** following `src/payments/entities/transaction.entity.ts` style (`@PrimaryGeneratedColumn('uuid')`, `@CreateDateColumn`). `body` is `@Column({ type: 'text' })`.
- [ ] **Step 2: Generate the migration**: `npm run migration:generate -- src/database/migrations/Phase6Messages`, then rename the file/class to `Phase6Messages1793900000002` (same `name = '...'` pattern as `Phase5CheckoutSession1793900000001`). Check it creates `messages`, the two FKs with `ON DELETE CASCADE`, and the `(bookingId, createdAt)` index, and that `down()` drops them.
- [ ] **Step 3: Create `MessagingModule` and import it in `AppModule`.**
- [ ] **Step 4: Run** `npm run migration:run` against the **local** DB (check `.env` `DATABASE_URL` host first - it may point at the server) then `\d messages` via psql. Expected: table, FKs and index present. `npm run build` passes.
- [ ] **Step 5: Commit** `git commit -m "Phase 6: message entity, migration, module"`.

---

### Task 2: Send a message

**Files:**
- Create: `src/messaging/dto/send-message.dto.ts`, `src/messaging/messaging.service.ts`, `src/messaging/messaging.service.spec.ts`, `src/messaging/messaging.controller.ts`
- Modify: `src/messaging/messaging.module.ts` (register service + controller)

**Interfaces:**
- Consumes: `Message`, `MessagingModule` (Task 1); `NotificationsService.notify(userId, event, payload)`; `Role`, `BookingStatus`.
- Produces: `SendMessageDto { body: string }` (`@IsString() @Transform(trim) @MinLength(1) @MaxLength(1000)`).
- Produces: `MessagingService.sendMessage(userId: string, role: Role, bookingId: string, data: SendMessageDto): Promise<MessageView>` where `MessageView = { id; bookingId; senderId; sender: 'CUSTOMER' | 'PROVIDER'; body; createdAt }` (export the type from the service file).
- Produces (private, used by Task 3): `getParticipantBooking(userId: string, role: Role, bookingId: string): Promise<Booking>` - loads the booking with `relations: { provider: true }`; returns it iff `booking.userId === userId` (role CUSTOMER) or `role === PROVIDER && booking.provider.userId === userId && booking.status !== PENDING_PAYMENT`; else `NotFoundException('Booking not found!')`. Plus a private `toView(message: Message, booking: Booking): MessageView`.
- Controller: `@Controller('bookings')`, `@Post('/:id/messages') @Roles(Role.CUSTOMER, Role.PROVIDER) sendMessage(@Req() req, @Param('id', ParseUUIDPipe) id, @Body() body: SendMessageDto)` calling `messagingService.sendMessage(req.user.id, req.user.role, id, body)`.

- [ ] **Step 1: Write failing service tests** (mock `bookingRepo.findOne`, `messageRepo.save`/`create`, `notifications.notify`; pattern: `booking.service.spec.ts`):
  - `sendMessage saves the message and returns the view with sender CUSTOMER` (customer, `CONFIRMED`; assert returned keys are exactly `id, bookingId, senderId, sender, body, createdAt`).
  - `provider send returns sender PROVIDER and notifies the customer` (`notify(booking.userId, 'MESSAGE_RECEIVED', { bookingId })`); customer send notifies `booking.provider.userId`.
  - `throws NotFoundException for a user who is neither party` and `for an admin`.
  - `throws NotFoundException for the provider while PENDING_PAYMENT`.
  - `throws ConflictException when the status is each of PENDING_PAYMENT, DECLINED, CANCELLED, COMPLETED` (`it.each`).
- [ ] **Step 2: Write failing DTO test** in the same spec file (or `send-message.dto.spec.ts`) using `validate(plainToInstance(SendMessageDto, ...))`: `'   '` fails, 1001 chars fails, `'  hi  '` passes and transforms to `'hi'`.
- [ ] **Step 3: Run** `npx jest src/messaging` -> FAIL (files missing).
- [ ] **Step 4: Implement** the DTO, `MessagingService` (inject `Repository<Message>`, `Repository<Booking>`, `NotificationsService`), controller, and register both in the module. Open statuses live in one `const MESSAGING_OPEN_STATUSES` in the service file.
- [ ] **Step 5: Run** `npx jest src/messaging` -> PASS; `npm run build`.
- [ ] **Step 6: Commit** `git commit -m "Phase 6: send booking messages"`.

---

### Task 3: List messages with polling cursor

**Files:**
- Create: `src/messaging/dto/list-messages-query.dto.ts`
- Modify: `src/messaging/messaging.service.ts`, `src/messaging/messaging.service.spec.ts`, `src/messaging/messaging.controller.ts`

**Interfaces:**
- Consumes: `getParticipantBooking`, `toView`, `MessageView` (Task 2).
- Produces: `ListMessagesQueryDto { after?: string /* @IsOptional @IsUUID */; limit?: number /* @IsOptional @Type(() => Number) @IsInt @Min(1) @Max(100) */ }`.
- Produces: `MessagingService.listMessages(userId: string, role: Role, bookingId: string, query: ListMessagesQueryDto): Promise<{ messages: MessageView[] }>`.
- Controller: `@Get('/:id/messages') @Roles(Role.CUSTOMER, Role.PROVIDER) listMessages(@Req() req, @Param('id', ParseUUIDPipe) id, @Query() query: ListMessagesQueryDto)`.

- [ ] **Step 1: Write failing tests:**
  - `lists in any booking status including COMPLETED` (no 409 on read).
  - `without after returns the latest limit messages oldest-first` (repo returns newest-first rows; assert service reverses them; default take is 50; `limit: 2` -> `take: 2`).
  - `with after returns only messages created after that message, oldest-first` (assert the `findOne` for the cursor is scoped `{ id: after, bookingId }` and the list query uses `createdAt: MoreThan(cursor.createdAt)` with `order: { createdAt: 'ASC' }`).
  - `throws BadRequestException('Unknown message cursor!') when after is not in this booking`.
  - `throws NotFoundException for a non-participant`.
- [ ] **Step 2: Run** `npx jest src/messaging` -> FAIL on the new tests.
- [ ] **Step 3: Implement** `listMessages` and the query DTO; wire the controller route. `// ponytail: cursor is createdAt (microsecond precision); two messages in the same microsecond could be skipped, add a sequence column if it ever shows up.`
- [ ] **Step 4: Run** `npx jest src/messaging` -> PASS; `npm test` whole suite and `npm run build` green.
- [ ] **Step 5: Commit** `git commit -m "Phase 6: list booking messages with polling cursor"`.

---

### Task 4: Live check, demo data, docs, Postman, status

**Files:**
- Modify: `src/database/seeds/demo-data.seed.ts`, `PLAN.md`, `CLAUDE.md`, `postman/Handy-AI.postman_collection.json`
- Create: `PHASE_6_API.md`, `PHASE_6_MODULE_GUIDE.md`

- [ ] **Step 1: Live verification** against a **local** DB (confirm `DATABASE_URL` host is not the server): run the app; as a demo customer and the demo provider on a `CONFIRMED` booking, `POST` a message each way, `GET` with and without `after`; as a third demo customer `GET` -> 404; on a `COMPLETED` booking `GET` works and `POST` -> 409. Record the results in the module guide.
- [ ] **Step 2: Demo seed:** add a few messages (both directions) to two seeded bookings (one `CONFIRMED`, one `COMPLETED`). Messages need no cleanup code: deleting demo users cascades. Run `npm run seed:demo` locally and confirm rows exist.
- [ ] **Step 3: Docs:** `PHASE_6_API.md` (Postman-style examples for both endpoints incl. error cases) and `PHASE_6_MODULE_GUIDE.md` (how it works, the access rule, known gaps from the spec). Add a Postman "Messaging" folder with both requests.
- [ ] **Step 4: Status:** `PLAN.md` Phase 6 -> Done with a one-line pointer; `CLAUDE.md` phase table row 6 -> Done plus a dated decisions-log entry (decisions 1-7 from the spec, the known gaps, and that the migration must be run on the server DB).
- [ ] **Step 5: Commit** `git commit -m "Phase 6: demo messages, docs, Postman, project context"`.
