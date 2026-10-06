# CLAUDE.md — Backend Conventions (NestJS + TypeORM)

Follow these norms when writing or changing code in this repo. When existing code contradicts this file, **this file wins**. Do not copy a pattern just because it already exists somewhere (see "Legacy patterns — do not replicate").

Stack: NestJS, TypeScript, PostgreSQL, TypeORM, Redis (cache-manager), Passport JWT.

---

## 1. Global setup already exists — don't duplicate it

These are configured once in `main.ts`. Do not re-add them per module, controller, or route.

| Concern | Where it lives | What NOT to do |
|---|---|---|
| Route prefix `api/v1` | Global prefix | Don't write `@Controller('api/v1/auth')` or `/api/v1/...` in routes. Use `@Controller('auth')`. |
| Validation | Global `ValidationPipe({ whitelist: true, transform: true })` | Don't add `@UsePipes(new ValidationPipe())` on routes. Put all validation in DTOs with `class-validator`. |
| Serialization | Global `ClassSerializerInterceptor` | Use `@Exclude()` on entity fields (password, otp, resetToken, etc.) instead of manually deleting them from responses. |
| CORS | `app.enableCors()` | Don't configure CORS anywhere else. |
| Process-level errors | `unhandledRejection` / `uncaughtException` handlers | Don't add `process.on(...)` handlers elsewhere. These are a last-resort safety net, **not** error handling — still await every promise and let errors surface properly. |
| Static files | `/uploads` served from `uploads/` | Don't add another static handler. |

Because `transform: true` is on, DTO fields arrive with correct types — don't manually `parseInt` DTO values in controllers.

---

## 2. Naming

### 2.1 Controller method name = service method name (hard rule)

```ts
// controller
@Post('/login')
async signIn(@Body() body: SignInDto) {
  return this.authService.signIn(body);
}

// service
async signIn(data: SignInDto) { ... }
```

Never let them drift (e.g. controller `forgotPassword` → service `forgetPassword` is wrong). If you rename one, rename the other in the same change.

### 2.2 Routes

- kebab-case, leading slash: `@Post('/forgot-password')`, `@Post('/resend-code')`.
- Controller prefix is the resource/module name, singular or as the module is named: `@Controller('auth')`.
- Nested actions use segments: `@Post('/phone/send-otp')`, `@Get('/google/callback')`.
- Route names describe the action in plain words. No cryptic suffixes or abbreviations (`-wr`, `WRT`, etc.).

### 2.3 Methods and variables

- camelCase, verb-first, full words: `signUp`, `verifyOtp`, `resetPassword`, `getUsersByIds`.
- No abbreviations that need explaining (`WRT`, `WR`). If a method exists for a specific caller, name what it does, not who asked for it.
- Booleans read as questions: `isEmailVerified`, `isPhoneVerified`, `isPasswordConfirm`.

### 2.4 DTOs

- Class: `PascalCase` + `Dto`, named after the action it carries: `SignInDto`, `ForgotPasswordDto`, `VerifyOtpDto`, `SocialLoginDto`.
- File: kebab-case + `.dto.ts`, matching the class: `sign-in.dto.ts`, `forgot-password.dto.ts`, `verify-otp.dto.ts`, `social-login.dto.ts`.
- Location: `<module>/dto/`.
- Every `@Body()` has a DTO. **Never** `@Body() body: any` and never an inline type like `@Body() body: { myId: string }`.
- Every DTO field has `class-validator` decorators (`@IsEmail()`, `@IsString()`, `@IsEnum(Purpose)`, `@Length()` …).

### 2.5 Other files

- Entities: `<name>.entity.ts`, class in PascalCase (`user.entity.ts` → `User`, `user-session.entity.ts` → `UserSession`).
- Services: `<name>.service.ts`; sub-services under `<module>/services/` (`google.service.ts` → `GoogleAuthService`).
- Guards: `<module>/guards/<name>.guard.ts`.
- Enums live next to the entity that owns them and are always used by reference (`Purpose.PHONE`), never by string literal (`'phone verify'`).

### 2.6 Cache keys

`<entity>_<thing>:<id>` — e.g. `user_session:${userId}`. Define key builders in one place instead of retyping template strings.

---

## 3. Controllers — thin

- A controller method: receive DTO / `req.user`, call **one** service method with the same name, return its result. No business logic, no DB access, no JWT signing, no encryption.
- Current user comes from the guard: `@UseGuards(AuthGuard('jwt'))` + `req.user.id`. **Never** accept the acting user's id from the body or query.
- Pass the whole DTO when the service needs most of it (`signUp(body)`); destructure and pass primitives only when the service signature genuinely takes primitives. Don't mix both styles for the same service method.
- Don't inject `JwtService`, repositories, or utils into controllers.
- No `try/catch` in controllers — let Nest's exception layer handle `HttpException`s.
- Remove unused params (`@Req() req` that isn't used).

---

## 4. Services

### 4.1 Structure

- Inject repositories with `@InjectRepository(Entity) private readonly xRepository: Repository<Entity>`; other services as `private readonly`.
- Use short lowercase step comments above each logical step — this is the house style:

```ts
//check if email already exists
const userExists = await this.userRepository.findOne({ where: { email } });
if (userExists) {
  throw new ConflictException('User Already Exists!');
}

//hash the password
const hashedPassword = await bcrypt.hash(data.password, 10);
```

- Repeated logic (OTP generation, OTP issuing + emailing) goes into a single private helper, not copy-pasted across `signUp`, `signIn`, `forgotPassword`, `resendOtp`.
- Return plain objects. Action endpoints return `{ message: '...' }`; auth endpoints return `AuthResponse` from `AuthResponseService.build(user)`.
- Every async call is `await`ed. Don't `await` synchronous calls (`repository.create(...)` is sync).

### 4.2 Errors

- Throw Nest built-ins: `NotFoundException`, `ConflictException`, `UnauthorizedException`, `ForbiddenException`, `BadRequestException`.
- Pick the semantically right one (invalid OTP → `BadRequestException`/`UnauthorizedException`, not `NotFoundException`).
- Messages: short, user-facing, sentence case, ending with `!` — e.g. `'User not found!'`, `'Invalid or Expired OTP!'`. Spell-check them.
- Don't return `{ message: 'error ...' }` with a 200 on failure — throw.

### 4.3 Data handling

- Normalize emails everywhere they're read or written: `email.trim().toLowerCase()`.
- Read config via `ConfigService`, not `process.env`, inside modules.
- Simple lookups: `repository.findOne({ where })`. Joins / filtered projections: `createQueryBuilder` with an explicit `.select([...])` list.
- Multi-step writes that must succeed together go in a transaction (`dataSource.transaction`).

---

## 5. Auth & security rules (non-negotiable)

- Any route that reads or mutates a specific user's data is guarded and uses `req.user.id`.
- Password change requires the authenticated user **and** their current password, or a valid one-time reset token. Never by email alone.
- OTPs: generate with `crypto.randomInt(10000, 100000)` (full 5-digit range, cryptographically secure). Never `Math.random()`.
- OTP verification is rate-limited / attempt-capped (e.g. counter in Redis, lock after N failures).
- One-time tokens (reset tokens, OTPs) are cleared immediately after successful use.
- Forgot-password / resend endpoints return the same response whether or not the email exists (no user enumeration).
- Sensitive entity fields carry `@Exclude()`.
- Imports use package names: `import * as bcrypt from 'bcryptjs'`, never `'node_modules/...'`.
- Session invalidation (logout) deletes both the DB session state and the Redis cache key.

---

## 6. Housekeeping

- No commented-out code blocks in new or edited code. Use git history.
- No unused imports or variables.
- No people's names or ad-hoc request notes in comments; describe the behavior and why.
- When touching a file, fix violations of this guide in the lines you touch; don't rewrite unrelated code without being asked.

---

## 7. Legacy patterns — do not replicate

Existing code contains these; treat them as debt, not examples:

- Controller/service name mismatch (`forgotPassword` / `forgetPassword`).
- DTO file name typos and mixed casing (`signIn.to.ts`, `social-loin.dto.ts`, `forgotPassword.dto.ts` vs `resend-otp.dto.ts`).
- `@Body() body: any` and inline body types.
- Unauthenticated routes that take a user id or email from the body to act on that user (`/users-by-ids`, `/change-password-wr`).
- `Math.floor(10000 + Math.random() * 9000)` OTPs.
- Enum compared to string literal (`purpose === 'phone verify'`).
- Business logic (JWT signing, encryption) inside controllers.
- Copy-pasted OTP generation blocks.
