import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Cache } from 'cache-manager';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { CacheKeys } from '../../common/cache-keys';
import { Role } from '../../user/enums/role.enum';

export interface JwtPayload {
  sub: string;
  sid: string;
  role: Role;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET')!,
    });
  }

  async validate(payload: JwtPayload) {
    //confirm this token's session is still the active one (covers logout + sign-in-elsewhere)
    const activeSessionId = await this.cache.get<string>(
      CacheKeys.userSession(payload.sub),
    );
    if (!activeSessionId || activeSessionId !== payload.sid) {
      throw new UnauthorizedException('Session expired. Please sign in again!');
    }

    return { id: payload.sub, role: payload.role };
  }
}
