import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Booking } from '../../booking/entities/booking.entity';
import { TransactionStatus } from '../enums/transaction-status.enum';

@Entity('transactions')
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', unique: true })
  bookingId: string;

  @OneToOne(() => Booking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bookingId' })
  booking: Booking;

  @Column({ type: 'varchar' })
  stripeCheckoutSessionId: string;

  @Column({ type: 'varchar' })
  stripePaymentIntentId: string;

  // set at capture; the payout Transfer uses it as source_transaction
  @Column({ type: 'varchar', nullable: true })
  stripeChargeId: string | null;

  @Column({ type: 'int' })
  amountCents: number;

  @Column({ type: 'int' })
  commissionCents: number;

  @Column({ type: 'int' })
  providerPayoutCents: number;

  @Column({
    type: 'enum',
    enum: TransactionStatus,
    default: TransactionStatus.HELD,
  })
  status: TransactionStatus;

  @Column({ type: 'varchar', nullable: true })
  stripeTransferId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
