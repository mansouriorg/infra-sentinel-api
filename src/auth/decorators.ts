import {
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import type { Role } from '../orgs/roles';
import type { ApiScope } from './api-keys';
import type { AuthContext, AuthedRequest } from './auth.types';

export const IS_PUBLIC = 'auth:public';
export const MIN_ROLE = 'auth:min-role';
export const SCOPE = 'auth:scope';

export const Public = () => SetMetadata(IS_PUBLIC, true);
export const MinRole = (role: Role) => SetMetadata(MIN_ROLE, role);
export const Scope = (scope: ApiScope) => SetMetadata(SCOPE, scope);

export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (!request.auth) throw new Error('CurrentAuth used on a public route');
    return request.auth;
  },
);
