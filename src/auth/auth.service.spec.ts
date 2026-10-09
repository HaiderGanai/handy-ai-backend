import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { MailService } from '../mail/mail.service';
import { RedisService } from '../redis/redis.service';
import { OtpPurpose } from '../user/enums/otp-purpose.enum';
import { Role } from '../user/enums/role.enum';
import { User } from '../user/entities/user.entity';
import { UserSession } from '../user/entities/user-session.entity';
import { AuthResponseService } from './services/auth-response.service';

describe('AuthService', () => {
  let service: AuthService;
  let userRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let userSessionRepository: {
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let redisService: { incrementWithExpiry: jest.Mock; delete: jest.Mock };
  let mailService: { sendMail: jest.Mock };

  beforeEach(async () => {
    userRepository = {
      findOne: jest.fn(),
      create: jest.fn((data: Partial<User>) => ({ ...data })),
      save: jest.fn((user) => Promise.resolve(user)),
    };
    userSessionRepository = {
      create: jest.fn((data: Partial<UserSession>) => ({ ...data })),
      save: jest.fn((session) => Promise.resolve(session)),
      delete: jest.fn(),
    };
    cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
    redisService = {
      incrementWithExpiry: jest.fn().mockResolvedValue(1),
      delete: jest.fn(),
    };
    mailService = { sendMail: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        AuthResponseService,
        { provide: getRepositoryToken(User), useValue: userRepository },
        {
          provide: getRepositoryToken(UserSession),
          useValue: userSessionRepository,
        },
        { provide: CACHE_MANAGER, useValue: cache },
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('signed.jwt.token') },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(86400) },
        },
        { provide: MailService, useValue: mailService },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  describe('signUp', () => {
    it('creates an unverified user and emails an OTP', async () => {
      userRepository.findOne.mockResolvedValue(null);

      const result = await service.signUp({
        email: 'New@Example.com',
        password: 'password123',
        fullName: 'New User',
      });

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { email: 'new@example.com' },
      });
      expect(userRepository.save).toHaveBeenCalled();
      expect(mailService.sendMail).toHaveBeenCalledWith(
        'new@example.com',
        expect.any(String),
        expect.stringContaining('verification code'),
      );
      expect(result).toEqual({
        message: 'Verification code sent to your email!',
      });
    });

    it('rejects sign-up for an email that already exists', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'existing-id',
        email: 'new@example.com',
      });

      await expect(
        service.signUp({
          email: 'new@example.com',
          password: 'password123',
          fullName: 'New User',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('verifyOtp', () => {
    it('marks a SIGNUP user verified on a correct code', async () => {
      userRepository.findOne.mockResolvedValue({
        email: 'new@example.com',
        otpCode: '12345',
        otpPurpose: OtpPurpose.SIGNUP,
        otpExpiresAt: new Date(Date.now() + 60_000),
        isEmailVerified: false,
      });

      const result = await service.verifyOtp({
        email: 'new@example.com',
        code: '12345',
        purpose: OtpPurpose.SIGNUP,
      });

      expect(result).toEqual({ message: 'Email verified successfully!' });
      expect(redisService.delete).toHaveBeenCalled();
    });

    it('rejects an incorrect code', async () => {
      userRepository.findOne.mockResolvedValue({
        email: 'new@example.com',
        otpCode: '12345',
        otpPurpose: OtpPurpose.SIGNUP,
        otpExpiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        service.verifyOtp({
          email: 'new@example.com',
          code: '99999',
          purpose: OtpPurpose.SIGNUP,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('locks out verification after too many attempts', async () => {
      redisService.incrementWithExpiry.mockResolvedValue(6);
      userRepository.findOne.mockResolvedValue({
        email: 'new@example.com',
        otpCode: '12345',
        otpPurpose: OtpPurpose.SIGNUP,
        otpExpiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        service.verifyOtp({
          email: 'new@example.com',
          code: '12345',
          purpose: OtpPurpose.SIGNUP,
        }),
      ).rejects.toThrow('Too many attempts. Please request a new code!');
    });
  });

  describe('signIn', () => {
    it('rejects an unverified user', async () => {
      userRepository.findOne.mockResolvedValue({
        email: 'new@example.com',
        isEmailVerified: false,
      });

      await expect(
        service.signIn({ email: 'new@example.com', password: 'password123' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects an incorrect password', async () => {
      const hashed = await bcrypt.hash('correct-password', 10);
      userRepository.findOne.mockResolvedValue({
        email: 'new@example.com',
        isEmailVerified: true,
        password: hashed,
      });

      await expect(
        service.signIn({
          email: 'new@example.com',
          password: 'wrong-password',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('issues a session and access token on correct credentials', async () => {
      const hashed = await bcrypt.hash('correct-password', 10);
      userRepository.findOne.mockResolvedValue({
        id: 'user-id',
        email: 'new@example.com',
        role: Role.CUSTOMER,
        isEmailVerified: true,
        password: hashed,
      });

      const result = await service.signIn({
        email: 'new@example.com',
        password: 'correct-password',
      });

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(cache.set).toHaveBeenCalled();
      expect(userSessionRepository.save).toHaveBeenCalled();
    });
  });

  describe('admin sign-in separation', () => {
    const adminUser = async (role: Role) => ({
      id: 'user-id',
      email: 'a@example.com',
      role,
      isEmailVerified: true,
      password: await bcrypt.hash('correct-password', 10),
    });
    const credentials = {
      email: 'a@example.com',
      password: 'correct-password',
    };

    it('blocks an admin from the regular sign-in', async () => {
      userRepository.findOne.mockResolvedValue(await adminUser(Role.ADMIN));
      await expect(service.signIn(credentials)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('blocks a non-admin from the admin sign-in', async () => {
      userRepository.findOne.mockResolvedValue(await adminUser(Role.PROVIDER));
      await expect(service.adminSignIn(credentials)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('signs an admin in through the admin sign-in', async () => {
      userRepository.findOne.mockResolvedValue(await adminUser(Role.ADMIN));
      const result = await service.adminSignIn(credentials);
      expect(result.accessToken).toBe('signed.jwt.token');
    });
  });

  describe('forgotPassword', () => {
    it('returns the same message whether or not the email exists', async () => {
      userRepository.findOne.mockResolvedValue(null);
      const resultForUnknown = await service.forgotPassword({
        email: 'ghost@example.com',
      });

      userRepository.findOne.mockResolvedValue({ email: 'new@example.com' });
      const resultForKnown = await service.forgotPassword({
        email: 'new@example.com',
      });

      expect(resultForUnknown).toEqual(resultForKnown);
      expect(mailService.sendMail).toHaveBeenCalledTimes(1);
    });
  });

  describe('resetPassword', () => {
    it('rejects an invalid or expired token', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.resetPassword({
          resetToken: 'bad-token',
          newPassword: 'new-password123',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
