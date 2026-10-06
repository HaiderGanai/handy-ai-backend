import { Injectable } from '@nestjs/common';
import { User } from '../../user/entities/user.entity';

export interface AuthResponse {
  user: User;
  accessToken: string;
}

@Injectable()
export class AuthResponseService {
  // `user` stays a User instance (not spread into a plain object) so the global
  // ClassSerializerInterceptor still strips its @Exclude() fields.
  build(user: User, accessToken: string): AuthResponse {
    return { user, accessToken };
  }
}
