import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import type { Cache } from 'cache-manager';
import { createHash, randomBytes, randomInt, randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { CacheKeys } from '../common/cache-keys';
import { MailService } from '../mail/mail.service';
import { RedisService } from '../redis/redis.service';
import { OtpPurpose } from '../user/enums/otp-purpose.enum';
import { Role } from '../user/enums/role.enum';
import { User } from '../user/entities/user.entity';
import { UserSession } from '../user/entities/user-session.entity';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SignInDto } from './dto/sign-in.dto';
import { SignUpDto } from './dto/sign-up.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import {
  AuthResponse,
  AuthResponseService,
} from './services/auth-response.service';

const OTP_TTL_MINUTES = 10;
const RESET_TOKEN_TTL_MINUTES = 15;
const MAX_OTP_ATTEMPTS = 5;
const OTP_ATTEMPTS_TTL_SECONDS = 15 * 60;

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly userRepository: Repository<User>,
    @InjectRepository(UserSession)
    private readonly userSessionRepository: Repository<UserSession>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly mailService: MailService,
    private readonly redisService: RedisService,
    private readonly authResponseService: AuthResponseService,
  ) {}

  async signUp(data: SignUpDto): Promise<{ message: string }> {
    const email = data.email.trim().toLowerCase();

    //check if email already exists
    const existing = await this.userRepository.findOne({ where: { email } });
    if (existing) {
      throw new ConflictException('User Already Exists!');
    }

    //hash the password
    const hashedPassword = await bcrypt.hash(data.password, 10);

    const user = this.userRepository.create({
      email,
      password: hashedPassword,
      fullName: data.fullName,
      role: data.role ?? Role.CUSTOMER,
    });
    await this.userRepository.save(user);

    await this.generateAndSendOtp(user, OtpPurpose.SIGNUP);
    return { message: 'Verification code sent to your email!' };
  }

  async verifyOtp(
    data: VerifyOtpDto,
  ): Promise<{ message: string; resetToken?: string }> {
    const email = data.email.trim().toLowerCase();

    //cap verify attempts so a code can't be brute-forced
    const attempts = await this.redisService.incrementWithExpiry(
      CacheKeys.otpAttempts(email),
      OTP_ATTEMPTS_TTL_SECONDS,
    );
    if (attempts > MAX_OTP_ATTEMPTS) {
      throw new BadRequestException(
        'Too many attempts. Please request a new code!',
      );
    }

    const user = await this.userRepository.findOne({ where: { email } });
    const isValid =
      user &&
      user.otpCode === data.code &&
      user.otpPurpose === data.purpose &&
      user.otpExpiresAt &&
      user.otpExpiresAt.getTime() > Date.now();

    if (!user || !isValid) {
      throw new BadRequestException('Invalid or Expired OTP!');
    }

    //one-time code is used — clear it immediately and reset the attempt counter
    user.otpCode = null;
    user.otpExpiresAt = null;
    user.otpPurpose = null;
    await this.redisService.delete(CacheKeys.otpAttempts(email));

    if (data.purpose === OtpPurpose.SIGNUP) {
      user.isEmailVerified = true;
      await this.userRepository.save(user);
      return { message: 'Email verified successfully!' };
    }

    //RESET_PASSWORD: issue a short-lived reset token, store only its hash
    const resetToken = randomBytes(32).toString('hex');
    user.resetToken = createHash('sha256').update(resetToken).digest('hex');
    user.resetTokenExpiresAt = new Date(
      Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000,
    );
    await this.userRepository.save(user);

    return { message: 'OTP verified!', resetToken };
  }

  async resendOtp(data: ResendOtpDto): Promise<{ message: string }> {
    const email = data.email.trim().toLowerCase();

    //same response whether or not the email exists / needs a code — no enumeration
    const user = await this.userRepository.findOne({ where: { email } });
    const alreadyVerifiedSignup =
      data.purpose === OtpPurpose.SIGNUP && user?.isEmailVerified;
    if (user && !alreadyVerifiedSignup) {
      await this.generateAndSendOtp(user, data.purpose);
    }

    return {
      message: 'If an account exists, a verification code has been sent!',
    };
  }

  async signIn(data: SignInDto, userAgent?: string): Promise<AuthResponse> {
    const user = await this.verifyCredentials(data);

    //admins sign in through their own endpoint only
    if (user.role === Role.ADMIN) {
      throw new UnauthorizedException('Invalid credentials!');
    }

    return this.createSession(user, userAgent);
  }

  async adminSignIn(
    data: SignInDto,
    userAgent?: string,
  ): Promise<AuthResponse> {
    const user = await this.verifyCredentials(data);

    if (user.role !== Role.ADMIN) {
      throw new UnauthorizedException('Invalid credentials!');
    }

    return this.createSession(user, userAgent);
  }

  async forgotPassword(data: ForgotPasswordDto): Promise<{ message: string }> {
    const email = data.email.trim().toLowerCase();

    //same response whether or not the email exists — no enumeration
    const user = await this.userRepository.findOne({ where: { email } });
    if (user) {
      await this.generateAndSendOtp(user, OtpPurpose.RESET_PASSWORD);
    }

    return {
      message: 'If an account exists, a verification code has been sent!',
    };
  }

  async resetPassword(data: ResetPasswordDto): Promise<{ message: string }> {
    const tokenHash = createHash('sha256')
      .update(data.resetToken)
      .digest('hex');

    //look up by the hashed token; never store or compare the raw token
    const user = await this.userRepository.findOne({
      where: { resetToken: tokenHash },
    });
    const isValid =
      user &&
      user.resetTokenExpiresAt &&
      user.resetTokenExpiresAt.getTime() > Date.now();
    if (!user || !isValid) {
      throw new BadRequestException('Invalid or Expired Reset Token!');
    }

    //clear the one-time token immediately and invalidate any existing session
    user.password = await bcrypt.hash(data.newPassword, 10);
    user.resetToken = null;
    user.resetTokenExpiresAt = null;
    await this.userRepository.save(user);
    await this.invalidateSessions(user.id);

    return { message: 'Password reset successfully!' };
  }

  async logout(userId: string): Promise<{ message: string }> {
    await this.invalidateSessions(userId);
    return { message: 'Logged out successfully!' };
  }

  private async generateAndSendOtp(
    user: User,
    purpose: OtpPurpose,
  ): Promise<void> {
    //full 5-digit range, cryptographically secure — never Math.random()
    const code = randomInt(10000, 100000).toString();

    user.otpCode = code;
    user.otpExpiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    user.otpPurpose = purpose;
    await this.userRepository.save(user);

    //a freshly issued code gets a fresh attempt budget
    await this.redisService.delete(CacheKeys.otpAttempts(user.email));

    const subject =
      purpose === OtpPurpose.SIGNUP
        ? 'Verify your Handy AI account'
        : 'Reset your Handy AI password';
    const html = `<p>Your Handy AI verification code is <strong>${code}</strong>. It expires in ${OTP_TTL_MINUTES} minutes.</p>`;
    await this.mailService.sendMail(user.email, subject, html);
  }

  private async verifyCredentials(data: SignInDto): Promise<User> {
    const email = data.email.trim().toLowerCase();

    //check credentials
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials!');
    }
    if (!user.isEmailVerified) {
      throw new ForbiddenException('Please verify your email first!');
    }

    const passwordMatches = await bcrypt.compare(data.password, user.password);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials!');
    }
    return user;
  }

  private async createSession(
    user: User,
    userAgent?: string,
  ): Promise<AuthResponse> {
    //single active session per user — a new sign-in retires the previous one
    await this.invalidateSessions(user.id);

    const sessionId = randomUUID();
    const expiresInSeconds = Number(this.config.get<number>('JWT_EXPIRES_IN'));
    const accessToken = this.jwtService.sign(
      { sub: user.id, sid: sessionId, role: user.role },
      { expiresIn: expiresInSeconds },
    );

    const session = this.userSessionRepository.create({
      userId: user.id,
      refreshTokenHash: createHash('sha256').update(sessionId).digest('hex'),
      userAgent: userAgent ?? null,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    });
    await this.userSessionRepository.save(session);
    await this.cache.set(
      CacheKeys.userSession(user.id),
      sessionId,
      expiresInSeconds * 1000,
    );

    return this.authResponseService.build(user, accessToken);
  }

  private async invalidateSessions(userId: string): Promise<void> {
    await this.userSessionRepository.delete({ userId });
    await this.cache.del(CacheKeys.userSession(userId));
  }
}
