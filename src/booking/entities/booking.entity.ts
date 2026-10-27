import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SubService } from '../../catalog/entities/sub-service.entity';
import { Provider } from '../../provider/entities/provider.entity';
import { User } from '../../user/entities/user.entity';
import { BookingStatus } from '../enums/booking-status.enum';

@Entity('bookings')
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid' })
  providerId: string;

  @ManyToOne(() => Provider, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'providerId' })
  provider: Provider;

  @Column({ type: 'uuid' })
  subServiceId: string;

  @ManyToOne(() => SubService, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'subServiceId' })
  subService: SubService;

  @Column({ type: 'timestamptz' })
  scheduledAt: Date;

  @Column({ type: 'int' })
  durationMinutes: number;

  // flat-rate price in USD cents, copied from the sub-service at confirm time
  @Column({ type: 'int' })
  priceCents: number;

  @Column({
    type: 'enum',
    enum: BookingStatus,
    default: BookingStatus.PENDING_PROVIDER,
  })
  status: BookingStatus;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
