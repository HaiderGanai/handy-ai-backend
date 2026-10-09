import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ServiceCategory } from './service-category.entity';

@Entity('sub_services')
export class SubService {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  categoryId: string;

  @ManyToOne(() => ServiceCategory, (category) => category.subServices, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'categoryId' })
  category: ServiceCategory;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar' })
  slug: string;

  // flat-rate price in USD cents (matches Stripe's smallest-unit amounts)
  @Column({ type: 'int' })
  basePriceCents: number;

  @Column({ type: 'int' })
  baseDurationMinutes: number;

  @Column({ type: 'int' })
  sortOrder: number;
}
