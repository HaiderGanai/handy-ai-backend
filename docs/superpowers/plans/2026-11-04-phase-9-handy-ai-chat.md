# Phase 9 — Handy AI Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer chats with Handy in free text; Handy proposes a booking plan via tools, and a separate Confirm call (not the model) places the booking and returns the Stripe checkout link.

**Architecture:** New `HandyModule` (`src/handy/`). `LlmService` wraps the OpenAI SDK (the only file that touches it). `HandyToolsService` holds the three tools and runs them as the logged-in user by calling existing services directly. `HandyChatService` runs the bounded tool loop, stores history, enforces the usage limit and owns plan storage/confirmation. The model has no booking-creating tool.

**Tech Stack:** NestJS 11, TypeORM 0.3.x, `openai` SDK (verify it loads under Jest/CommonJS first, as with `stripe`), cache-manager (plan store), `RedisService.incrementWithExpiry` (usage limit), class-validator, Jest.

**Spec:** `docs/superpowers/specs/2026-11-04-phase-9-handy-ai-chat-design.md`

## Global Constraints

- Routes (CUSTOMER role, JWT + `RolesGuard`): `POST /handy/chat`, `GET /handy/chat`, `POST /handy/plans/:planId/confirm`.
- The acting user id is always `req.user.id`. No tool schema has a user/customer id parameter.
- Tools exposed to the model: exactly `list_services`, `propose_plan`, `get_my_bookings`. **No** create/edit/cancel tool.
- Plan store key `handy_plan:<userId>:<planId>` (add a builder next to the existing cache-key helpers), TTL 1800 s, deleted on confirm (single use).
- Message: trimmed, 1-1000 chars. History `limit` 1-100, default 50. LLM context: last 20 stored messages. Tool loop max 5 rounds.
- Usage limit: `HANDY_CHAT_LIMIT` (default 30) per `HANDY_CHAT_WINDOW_SECONDS` (default 3600) per user -> `HttpException('You are chatting too fast, please try again shortly!', 429)`.
- Errors: missing `OPENAI_API_KEY` -> `ServiceUnavailableException('Handy is not configured!')`; any LLM failure -> `BadGatewayException('Handy is unavailable, please retry!')` with the real error logged. Messages end with `!` (GUIDE.md).
- `timezone`: optional IANA name, default `UTC`, invalid -> 400.
- Migration only (`handy_messages`); run locally and verify; the server DB needs it before deploy.
- Env: `OPENAI_API_KEY`, `OPENAI_MODEL` (no default - not chosen yet; chat is 503 until set), `HANDY_CHAT_LIMIT`, `HANDY_CHAT_WINDOW_SECONDS` in `.env.example`.

## Review Focus

- A customer message that tries to make the model book / use another user's id ("book it now", "act as user X") cannot create a booking or read other data: no such tool, ids never taken from args (Task 2, 3 tests).
- Confirming a plan that belongs to another user, is expired, or was already confirmed -> 404, and no second booking is created (Task 4).
- The model returns a tool call with garbage arguments (bad UUID, non-date `scheduledAt`) -> the tool returns an error result to the model instead of throwing a 500 (Task 2).
- Model loops on tool calls forever -> stops at 5 rounds with the fixed reply (Task 3).
- LLM throws / key missing -> 502 / 503 and no half-stored turn (Task 3).
- `propose_plan` for a customer without a postcode or with no provider available -> the model gets a readable error result and can explain it (Task 2).

## File structure

```
src/handy/entities/handy-message.entity.ts          HandyMessage entity + HandyMessageRole enum
src/handy/dto/chat.dto.ts                           ChatDto { message, timezone? }
src/handy/dto/list-chat-query.dto.ts                ListChatQueryDto { limit? }
src/handy/llm.service.ts (+ .spec.ts)               the only OpenAI SDK user
src/handy/handy.prompt.ts (+ .spec.ts)              buildSystemPrompt()
src/handy/handy-tools.service.ts (+ .spec.ts)       tool definitions + executors
src/handy/handy-chat.service.ts (+ .spec.ts)        loop, history, limit, plan store, confirm
src/handy/handy.controller.ts
src/handy/handy.module.ts
src/database/migrations/<ts>-Phase9HandyChat.ts
modified: src/booking/booking.module.ts (export BookingService, BookingPlanService),
          src/app.module.ts, src/cache key helpers, .env.example, docs, Postman, PLAN.md, CLAUDE.md
```

---

### Task 1: SDK, `LlmService`, entity, migration, module skeleton

**Files:**
- Create: `src/handy/llm.service.ts`, `src/handy/llm.service.spec.ts`, `src/handy/entities/handy-message.entity.ts`, `src/handy/handy.module.ts`, `src/database/migrations/<ts>-Phase9HandyChat.ts`
- Modify: `package.json`, `.env.example`, `src/app.module.ts`

**Interfaces:**
- Produces: `type LlmMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCalls?: LlmToolCall[]; toolCallId?: string }`, `type LlmToolCall = { id: string; name: string; arguments: string }`, `type LlmToolDefinition = { name: string; description: string; parameters: Record<string, unknown> }`.
- Produces: `LlmService.complete(messages: LlmMessage[], tools: LlmToolDefinition[]): Promise<{ content: string | null; toolCalls: LlmToolCall[] }>` - throws `ServiceUnavailableException('Handy is not configured!')` without a key; wraps any SDK error in `BadGatewayException('Handy is unavailable, please retry!')` after logging it.
- Produces: `HandyMessage { id; userId; role: HandyMessageRole; content; createdAt }`, `enum HandyMessageRole { USER = 'USER', ASSISTANT = 'ASSISTANT' }`.

- [ ] **Step 1: Install `openai`** and prove it loads under Jest: `npm install openai && npx jest --testPathPattern llm.service` (after Step 2's test exists). If the newest major can't be unit-tested under this CommonJS/Jest setup (the Phase 1 lesson in `CLAUDE.md`), pin the last major that can and ledger why.
- [ ] **Step 2: Write failing tests** in `llm.service.spec.ts` with the SDK mocked: `throws 503 when OPENAI_API_KEY is missing`; `maps messages/tools to the SDK request and returns content + toolCalls`; `wraps SDK errors as 502`.
- [ ] **Step 3: Run** `npx jest src/handy/llm.service` -> FAIL.
- [ ] **Step 4: Implement** `LlmService` (build the client lazily from `ConfigService`, like `StripeService.client()`), the entity (`@Index(['userId','createdAt'])`, FK to `User` cascade), the module (TypeOrmModule feature `HandyMessage`), env vars in `.env.example`, `AppModule` import.
- [ ] **Step 5: Migration** hand-written in the Phase 5/6 style (`Phase9HandyChat<ts>`, enum type `handy_messages_role_enum`, table, index, FK). Run it on the **local** DB only (use the commented-out local `DATABASE_URL` from `.env` as an env override; `.env` points at the server) and `\d handy_messages`.
- [ ] **Step 6: Run** `npx jest src/handy && npm run build` -> PASS.
- [ ] **Step 7: Commit** `Phase 9: LLM service, handy message entity, migration`.

---

### Task 2: System prompt and tools

**Files:**
- Create: `src/handy/handy.prompt.ts`, `src/handy/handy.prompt.spec.ts`, `src/handy/handy-tools.service.ts`, `src/handy/handy-tools.service.spec.ts`
- Modify: `src/booking/booking.module.ts` (add `exports: [BookingService, BookingPlanService]`), `src/handy/handy.module.ts` (import `BookingModule`, `CatalogModule`; provide the tools service), cache-key helpers (add `handyPlan(userId, planId)`)

**Interfaces:**
- Produces: `buildSystemPrompt(ctx: { now: Date; timezone: string; fullName: string | null; postcode: string | null }): string` - Handy's calm/warm/refined persona; asks at most one or two follow-ups; states the current local date/time and timezone; instructs "pass scheduledAt as a full ISO-8601 instant with offset", "never claim a booking is made - the customer confirms with the button", "only the three tools exist", "tell the customer to add a postcode if missing".
- Produces: `HandyToolsService.definitions: LlmToolDefinition[]` (the three tools only) and `execute(userId: string, name: string, rawArguments: string): Promise<{ result: unknown; plan?: PlanCard }>` - never throws; bad JSON / unknown tool / invalid arguments / service errors (`NotFoundException`, `BadRequestException`, ...) become `{ result: { error: '<message>' } }`.
- Produces: `type PlanCard = { planId: string; provider: { id: string; fullName: string | null; bio: string | null }; subService: { id: string; name: string }; scheduledAt: Date; durationMinutes: number; priceCents: number; isTrustedProvider: boolean; expiresAt: Date }`. `propose_plan` calls `BookingPlanService.planBooking(userId, { subServiceId, scheduledAt, notes })`, stores `{ subServiceId, providerId, scheduledAt, notes }` in the cache under the plan key with TTL 1800 s, and returns the card as `plan` plus a model-safe summary as `result`.
- Consumes: `CatalogService.getServiceCategories()`, `BookingService.listBookings(userId, Role.CUSTOMER, query)`.

- [ ] **Step 1: Write failing tests.** Prompt: `contains today's date in the given timezone`, `mentions the customer's name and postcode when known`, `says to ask for a postcode when missing`. Tools: `definitions lists exactly list_services, propose_plan, get_my_bookings`; `no definition has a userId/customerId parameter`; `propose_plan stores the plan under handy_plan:<userId>:<planId> with TTL 1800 and returns a card`; `propose_plan with a non-UUID subServiceId returns an error result, not a throw`; `propose_plan with scheduledAt "tomorrow" returns an error result`; `propose_plan surfaces NotFound('No provider available for that time!') as an error result`; `unknown tool and malformed JSON arguments return error results`; `get_my_bookings only queries with the given userId` (assert the argument, ignoring any userId inside the model's arguments).
- [ ] **Step 2: Run** `npx jest src/handy` -> FAIL.
- [ ] **Step 3: Implement** prompt and tools. Validate arguments with `class-validator` on small private classes (`plainToInstance` + `validate`); strip provider data to `{ id, fullName, bio }`; `get_my_bookings` returns `{ id, status, scheduledAt, priceCents, serviceName }[]`.
- [ ] **Step 4: Run** `npx jest src/handy && npm run build` -> PASS.
- [ ] **Step 5: Commit** `Phase 9: Handy prompt and booking tools`.

---

### Task 3: Chat loop, history, usage limit, endpoints

**Files:**
- Create: `src/handy/handy-chat.service.ts`, `src/handy/handy-chat.service.spec.ts`, `src/handy/handy.controller.ts`, `src/handy/dto/chat.dto.ts`, `src/handy/dto/list-chat-query.dto.ts`
- Modify: `src/handy/handy.module.ts` (controller, service, `RedisModule`, `User` entity feature)

**Interfaces:**
- Consumes: `LlmService.complete`, `HandyToolsService.definitions/execute`, `buildSystemPrompt`, `RedisService.incrementWithExpiry`.
- Produces: `ChatDto { message: string /* trim, 1-1000 */; timezone?: string /* valid IANA */ }`, `ListChatQueryDto { limit?: number /* 1-100 */ }`.
- Produces: `HandyChatService.chat(userId: string, data: ChatDto): Promise<{ reply: string; plan?: PlanCard }>` and `HandyChatService.getChat(userId: string, query: ListChatQueryDto): Promise<{ messages: { id: string; role: HandyMessageRole; content: string; createdAt: Date }[] }>`.
- Controller: `@Controller('handy')`, `@Post('/chat') chat(...)`, `@Get('/chat') getChat(...)`, both `@Roles(Role.CUSTOMER)`, names equal to the service methods.

- [ ] **Step 1: Write failing tests** with a fake `LlmService` (scripted replies): `plain reply: stores user + assistant messages and returns the reply`; `tool round: LLM requests propose_plan, the service executes it for the caller's id, feeds the result back and returns the final text with the plan card`; `last proposed plan wins when several are proposed`; `stops after 5 tool rounds with the fixed reply "I'm sorry, I couldn't finish that - could you rephrase?"`; `429 on the 31st message in the window (limit from config)`; `LLM failure -> the 502 propagates and nothing is stored`; `only the last 20 stored messages are sent to the LLM`; `getChat returns oldest-first, default 50`; `invalid timezone -> 400` (DTO validation); `tool arguments containing a userId never change which user the tool runs for`.
- [ ] **Step 2: Run** `npx jest src/handy` -> FAIL.
- [ ] **Step 3: Implement.** Order inside `chat`: usage check -> load context (user name/postcode, last 20 messages) -> loop -> store both messages in one `save` after success -> return. Timezone validated with a custom `@IsTimeZone`-style check using `Intl.DateTimeFormat(undefined, { timeZone })` in try/catch.
- [ ] **Step 4: Run** `npx jest src/handy && npm run build` -> PASS.
- [ ] **Step 5: Commit** `Phase 9: Handy chat loop, history and usage limit`.

---

### Task 4: Confirm a plan

**Files:**
- Modify: `src/handy/handy-chat.service.ts`, `src/handy/handy-chat.service.spec.ts`, `src/handy/handy.controller.ts`

**Interfaces:**
- Consumes: plan store key from Task 2, `BookingService.createBooking(userId, CreateBookingDto)`.
- Produces: `HandyChatService.confirmPlan(userId: string, planId: string): Promise<{ booking: Booking; checkoutUrl: string }>` and `@Post('/plans/:planId/confirm') confirmPlan(...)` (`ParseUUIDPipe` on `planId`, CUSTOMER only).

- [ ] **Step 1: Write failing tests:** `creates the booking with the stored plan for the caller and returns booking + checkoutUrl`; `deletes the plan so a second confirm 404s and createBooking ran once`; `404 for another user's planId` (key includes the caller's id); `404 for an expired/unknown plan`; `appends an assistant message about completing payment`; `a booking error (e.g. slot taken -> 409) propagates and the plan is kept for retry`.
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement** (delete the plan only after `createBooking` succeeds). **Step 4: Run** `npx jest src/handy && npm test && npm run build` -> PASS.
- [ ] **Step 5: Commit** `Phase 9: confirm a Handy plan`.

---

### Task 5: Manual script, docs, Postman, status

**Files:**
- Create: `scripts/handy-sample-conversations.ts` (or `.md` list if scripting is overkill), `PHASE_9_API.md`, `PHASE_9_MODULE_GUIDE.md`
- Modify: `postman/Handy-AI.postman_collection.json`, `PLAN.md`, `CLAUDE.md`, `.env.example`

- [ ] **Step 1: Sample-conversation checklist** (`PHASE_9_MODULE_GUIDE.md` section): ~8 scripted customer messages to run once a real `OPENAI_API_KEY` exists ("clean my flat tomorrow morning", "sometime this week", missing postcode, no provider free, "just book it for me" -> must not book, injection attempt in notes, adjust time). Expected behaviour per line. State clearly that the live model behaviour is **unverified until a key is provided**.
- [ ] **Step 2: Docs + Postman** "Handy" folder (chat, history, confirm), request/response examples with the `PlanCard`, error table (400/404/429/502/503).
- [ ] **Step 3: Status:** `PLAN.md` Phase 9 -> Done (keep the "unverified live" note); `CLAUDE.md` phase table + dated decisions-log entry (decisions 1-9, known gaps, migration must run on the server DB, new env vars); update the scope-cuts table row for GPT-4 to say it is now built (Phase 9).
- [ ] **Step 4: Commit** `Phase 9: docs, Postman, project context`.
