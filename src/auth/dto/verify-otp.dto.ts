import { IsEmail, IsEnum, Length } from 'class-validator';
import { OtpPurpose } from '../../user/enums/otp-purpose.enum';

export class VerifyOtpDto {
  @IsEmail()
  email: string;

  @Length(5, 5)
  code: string;

  @IsEnum(OtpPurpose)
  purpose: OtpPurpose;
}
