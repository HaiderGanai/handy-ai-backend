import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ServiceCategoryName } from '../enums/service-category-name.enum';
import { SubService } from './sub-service.entity';

@Entity('service_categories')
export class ServiceCategory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: ServiceCategoryName, unique: true })
  name: ServiceCategoryName;

  @Column({ type: 'varchar', unique: true })
  slug: string;

  @Column({ type: 'int' })
  sortOrder: number;

  @OneToMany(() => SubService, (subService) => subService.category)
  subServices: SubService[];
}
