import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { User } from './entities/user.entity';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User) private readonly userRepository: Repository<User>,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async getProfile(userId: string): Promise<User> {
    //look up the authenticated user
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found!');
    }

    return user;
  }

  async updateProfile(userId: string, data: UpdateProfileDto): Promise<User> {
    const user = await this.getProfile(userId);

    //unset optional DTO fields still exist as own `undefined` properties (native ES
    //class field semantics), so only copy the ones the client actually sent
    const updates = Object.fromEntries(
      Object.entries(data).filter(([, value]) => value !== undefined),
    );
    Object.assign(user, updates);

    return this.userRepository.save(user);
  }

  async updatePhoto(userId: string, file: Express.Multer.File): Promise<User> {
    const user = await this.getProfile(userId);

    //upload to cloudinary and store the returned secure url
    const result = await this.cloudinaryService.uploadBuffer(
      file.buffer,
      'handy-ai/avatars',
    );
    user.photoUrl = result.secure_url;
    return this.userRepository.save(user);
  }
}
