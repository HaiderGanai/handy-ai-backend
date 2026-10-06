import { Request } from 'express';
import { Role } from '../user/enums/role.enum';

export interface AuthenticatedRequest extends Request {
  user: { id: string; role: Role };
}
