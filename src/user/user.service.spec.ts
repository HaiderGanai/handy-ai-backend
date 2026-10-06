import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { User } from './entities/user.entity';
import { UserService } from './user.service';

describe('UserService', () => {
  let service: UserService;
  let userRepository: { findOne: jest.Mock; save: jest.Mock };
  let cloudinaryService: { uploadBuffer: jest.Mock };

  beforeEach(async () => {
    userRepository = {
      findOne: jest.fn(),
      save: jest.fn((user) => Promise.resolve(user)),
    };
    cloudinaryService = { uploadBuffer: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: CloudinaryService, useValue: cloudinaryService },
      ],
    }).compile();

    service = module.get(UserService);
  });

  describe('getProfile', () => {
    it('throws when the user does not exist', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.getProfile('missing-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the user when found', async () => {
      const user = { id: 'user-id', fullName: 'Jane' };
      userRepository.findOne.mockResolvedValue(user);

      await expect(service.getProfile('user-id')).resolves.toEqual(user);
    });
  });

  describe('updateProfile', () => {
    it('merges only the provided fields onto the existing user', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'user-id',
        fullName: 'Old Name',
        postcode: 'E1 6AN',
      });

      // a real DTO instance, not a plain object literal: unset optional fields
      // (address, householdNotes) still exist as own `undefined` properties under
      // this project's ES2023 class-field semantics — the regression this guards.
      const dto = new UpdateProfileDto();
      dto.fullName = 'New Name';

      const result = await service.updateProfile('user-id', dto);

      expect(result).toEqual({
        id: 'user-id',
        fullName: 'New Name',
        postcode: 'E1 6AN',
      });
    });
  });

  describe('updatePhoto', () => {
    it('uploads to cloudinary and stores the returned secure url', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'user-id',
        photoUrl: null,
      });
      cloudinaryService.uploadBuffer.mockResolvedValue({
        secure_url: 'https://cloudinary/avatar.jpg',
      });

      const result = await service.updatePhoto('user-id', {
        buffer: Buffer.from('fake-image'),
      } as Express.Multer.File);

      expect(cloudinaryService.uploadBuffer).toHaveBeenCalledWith(
        Buffer.from('fake-image'),
        'handy-ai/avatars',
      );
      expect(result.photoUrl).toBe('https://cloudinary/avatar.jpg');
    });
  });
});
