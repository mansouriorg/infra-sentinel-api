import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { tap, type Observable } from 'rxjs';
import type { AuthedRequest } from '../auth/auth.types';
import {
  actorOf,
  bodyFields,
  controllerSegment,
  deriveAction,
  isAuditable,
  pickSummary,
  pickTarget,
  takesOrgFromResult,
} from './audit.actions';
import { AuditService } from './audit.service';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly audit: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const controllerPath: unknown = this.reflector.get(
      PATH_METADATA,
      context.getClass(),
    );
    const action = deriveAction(controllerPath, context.getHandler().name);
    if (!isAuditable(request.method, action)) return next.handle();
    return next
      .handle()
      .pipe(
        tap((result) => this.write(request, action, controllerPath, result)),
      );
  }

  private write(
    request: AuthedRequest,
    action: string,
    controllerPath: unknown,
    result: unknown,
  ): void {
    const auth = request.auth;
    if (!auth) return;
    const actor = actorOf(auth);
    const fromResult = takesOrgFromResult(action);
    const resultId =
      typeof result === 'object' && result !== null
        ? (result as { id?: unknown }).id
        : undefined;
    const orgId =
      fromResult && typeof resultId === 'string' ? resultId : auth.orgId;
    const metadata: Record<string, unknown> = {
      fields: bodyFields(request.body),
    };
    if (auth.apiKey) metadata.onBehalfOf = auth.user.email;
    const agent = request.headers?.['user-agent'];
    void this.audit.record({
      orgId,
      ...actor,
      action,
      targetType: controllerSegment(controllerPath),
      targetId: pickTarget(request.params, result),
      summary: pickSummary(result, request.body),
      metadata,
      ip: request.ip ?? null,
      userAgent: typeof agent === 'string' ? agent : null,
    });
  }
}
