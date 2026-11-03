import type { Request } from 'express';
import type { Role } from '../orgs/roles';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  scopes: string[];
}

export interface AuthContext {
  sessionId: string;
  user: AuthUser;
  orgId: string;
  role: Role;
  apiKey?: ApiKeyInfo;
  ssoOrgId?: string;
}

export interface AuthedRequest extends Request {
  auth?: AuthContext;
}

export interface ClientMeta {
  ip: string;
  userAgent?: string;
}
