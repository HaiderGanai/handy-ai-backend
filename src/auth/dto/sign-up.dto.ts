import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { Role } from '../../user/enums/role.enum';

export class SignUpDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  fullName: string;

  // ADMIN is never self-assignable; admins are promoted directly in the database
  @IsOptional()
  @IsIn([Role.CUSTOMER, Role.PROVIDER])
  role?: Role;
}
