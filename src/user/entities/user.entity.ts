import { Exclude } from 'class-transformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { OtpPurpose } from '../enums/otp-purpose.enum';
import { Role } from '../enums/role.enum';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Exclude()
  @Column()
  password: string;

  @Column({ type: 'enum', enum: Role, default: Role.CUSTOMER })
  role: Role;

  @Column({ default: false })
  isEmailVerified: boolean;

  @Exclude()
  @Column({ type: 'varchar', nullable: true })
  otpCode: string | null;

  @Exclude()
  @Column({ type: 'timestamptz', nullable: true })
  otpExpiresAt: Date | null;

  @Exclude()
  @Column({ type: 'enum', enum: OtpPurpose, nullable: true })
  otpPurpose: OtpPurpose | null;

  @Exclude()
  @Column({ type: 'varchar', nullable: true })
  resetToken: string | null;

  @Exclude()
  @Column({ type: 'timestamptz', nullable: true })
  resetTokenExpiresAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  fullName: string | null;

  @Column({ type: 'varchar', nullable: true })
  address: string | null;

  @Column({ type: 'varchar', nullable: true })
  postcode: string | null;

  @Column({ type: 'varchar', nullable: true })
  photoUrl: string | null;

  @Column({ type: 'text', nullable: true })
  householdNotes: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
