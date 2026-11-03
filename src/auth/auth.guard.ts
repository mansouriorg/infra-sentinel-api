import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { RateLimits, rateHeaders } from '../common/rate-limits';
import { AppConfig } from '../config/app-config';
import { hasRole, type Role } from '../orgs/roles';
import { isApiKeyToken, type ApiScope } from './api-keys';
import { ApiKeysService } from './api-keys.service';
import type { AuthedRequest } from './auth.types';
import { IS_PUBLIC, MIN_ROLE, SCOPE } from './decorators';
import { readSessionToken } from './session-cookie';
import { SessionsService } from './sessions.service';

type Targets = Parameters<Reflector['getAllAndOverride']>[1];

const MINUTE = 60_000;
const BAD_KEYS_PER_MINUTE = 30;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
    private readonly apiKeys: ApiKeysService,
    private readonly limits: RateLimits,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets)
    ) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = readSessionToken(request);
    if (token && isApiKeyToken(token))
      return this.withApiKey(context, request, token, targets);

    const auth = token ? await this.sessions.resolve(token) : null;
    if (!auth) throw new UnauthorizedException('Sign in required');
    request.auth = auth;
    this.requireRole(auth.role, targets);
    return true;
  }

  private async withApiKey(
    context: ExecutionContext,
    request: AuthedRequest,
    token: string,
    targets: Targets,
  ): Promise<boolean> {
    const ip = request.ip ?? 'unknown';
    const auth = await this.apiKeys.authenticate(token, ip);
    if (!auth || !auth.apiKey) {
      const bad = this.limits.hit(`bad-key:${ip}`, BAD_KEYS_PER_MINUTE, MINUTE);
      if (!bad.allowed)
        this.tooMany(context, bad.retryAfterSec, rateHeaders(bad));
      throw new UnauthorizedException(
        'This API key is not valid. It may have expired or been revoked.',
      );
    }

    const decision = this.limits.hit(
      `key:${auth.apiKey.id}`,
      this.config.get('API_RATE_LIMIT_PER_MINUTE'),
      MINUTE,
    );
    const headers = rateHeaders(decision);
    this.setHeaders(context, headers);
    if (!decision.allowed)
      this.tooMany(context, decision.retryAfterSec, headers);

    const scope = this.reflector.getAllAndOverride<ApiScope | undefined>(
      SCOPE,
      targets,
    );
    if (!scope)
      throw new ForbiddenException(
        'This endpoint cannot be used with an API key',
      );
    if (!auth.apiKey.scopes.includes(scope)) {
      throw new ForbiddenException(
        `This API key does not have the ${scope} scope`,
      );
    }

    request.auth = auth;
    this.requireRole(auth.role, targets);
    return true;
  }

  private requireRole(actual: Role, targets: Targets): void {
    const required = this.reflector.getAllAndOverride<Role | undefined>(
      MIN_ROLE,
      targets,
    );
    if (required && !hasRole(actual, required)) {
      throw new ForbiddenException(
        `This action needs the ${required} role or higher`,
      );
    }
  }

  private setHeaders(
    context: ExecutionContext,
    headers: Record<string, string>,
  ): void {
    const response = context.switchToHttp().getResponse<Response | undefined>();
    if (!response || typeof response.set !== 'function') return;
    response.set(headers);
  }

  private tooMany(
    context: ExecutionContext,
    retryAfterSec: number,
    headers: Record<string, string>,
  ): never {
    this.setHeaders(context, headers);
    throw new HttpException(
      `Too many requests. Try again in ${retryAfterSec} seconds.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
