import { IsOptional, IsString } from 'class-validator';

// account details editable from the provider profile; email is the sign-in identity and
// photoUrl is set by the photo upload, so neither is accepted here
export class UpdateProviderUserDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  postcode?: string;
}
