import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { DocumentStatus } from '../enums/document-status.enum';
import { DocumentType } from '../enums/document-type.enum';
import { Provider } from './provider.entity';

@Entity('provider_documents')
@Unique(['provider', 'type'])
export class ProviderDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Provider, (provider) => provider.documents, {
    onDelete: 'CASCADE',
  })
  provider: Provider;

  @Column({ type: 'enum', enum: DocumentType })
  type: DocumentType;

  @Column()
  fileUrl: string;

  @Column({
    type: 'enum',
    enum: DocumentStatus,
    default: DocumentStatus.PENDING,
  })
  status: DocumentStatus;

  @CreateDateColumn()
  createdAt: Date;
}
