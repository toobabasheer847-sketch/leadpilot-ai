import { Request } from 'express';

export interface JwtPayload {
  userId: string;
  organizationId: string;
  role: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  organizationId: string;
  organizationName: string;
  role: string;
}

export type AuthenticatedRequest = Request & {
  user?: AuthenticatedUser;
};
