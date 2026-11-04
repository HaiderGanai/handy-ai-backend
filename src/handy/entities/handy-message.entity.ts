import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';

export enum HandyMessageRole {
  USER = 'USER',
  ASSISTANT = 'ASSISTANT',
}

@Entity('handy_messages')
@Index(['userId', 'createdAt'])
export class HandyMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'enum', enum: HandyMessageRole })
  role: HandyMessageRole;

  @Column({ type: 'text' })
  content: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
