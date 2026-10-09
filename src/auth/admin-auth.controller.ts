import { Body, Controller, Headers, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SignInDto } from './dto/sign-in.dto';

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('/sign-in')
  async adminSignIn(
    @Body() body: SignInDto,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.authService.adminSignIn(body, userAgent);
  }
}
