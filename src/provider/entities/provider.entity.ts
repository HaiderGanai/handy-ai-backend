import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  JoinTable,
  ManyToMany,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ServiceCategory } from '../../catalog/entities/service-category.entity';
import { User } from '../../user/entities/user.entity';
import { ProviderStatus } from '../enums/provider-status.enum';
import { ProviderAvailability } from './provider-availability.entity';
import { ProviderDocument } from './provider-document.entity';

@Entity('providers')
export class Provider {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', unique: true })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'text' })
  bio: string;

  // ponytail: plain postcode list, no geo-radius matching yet
  @Column({ type: 'text', array: true })
  postcodeCoverage: string[];

  @Column({
    type: 'enum',
    enum: ProviderStatus,
    default: ProviderStatus.PENDING,
  })
  status: ProviderStatus;

  @Column({ type: 'varchar', nullable: true })
  rejectionReason: string | null;

  @Column({ type: 'varchar', nullable: true })
  stripeAccountId: string | null;

  @ManyToMany(() => ServiceCategory)
  @JoinTable({ name: 'provider_service_categories' })
  categories: ServiceCategory[];

  @OneToMany(() => ProviderAvailability, (slot) => slot.provider, {
    cascade: true,
  })
  availability: ProviderAvailability[];

  @OneToMany(() => ProviderDocument, (document) => document.provider)
  documents: ProviderDocument[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
