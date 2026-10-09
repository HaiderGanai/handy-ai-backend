import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Provider } from './provider.entity';

@Entity('provider_availability')
export class ProviderAvailability {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Provider, (provider) => provider.availability, {
    onDelete: 'CASCADE',
    orphanedRowAction: 'delete',
  })
  provider: Provider;

  // 0 = Sunday ... 6 = Saturday
  @Column({ type: 'smallint' })
  dayOfWeek: number;

  @Column({ type: 'time' })
  startTime: string;

  @Column({ type: 'time' })
  endTime: string;
}
