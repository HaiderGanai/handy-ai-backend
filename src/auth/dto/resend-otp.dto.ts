import { IsEmail, IsEnum } from 'class-validator';
import { OtpPurpose } from '../../user/enums/otp-purpose.enum';

export class ResendOtpDto {
  @IsEmail()
  email: string;

  @IsEnum(OtpPurpose)
  purpose: OtpPurpose;
}
