import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Put,
  Post,
  Query,
  Redirect,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, MinRole, Public } from '../auth/decorators';
import {
  clientMeta,
  readNamedCookie,
  setSessionCookie,
} from '../auth/session-cookie';
import { AppConfig } from '../config/app-config';
import {
  SSO_COOKIE,
  SSO_COOKIE_MAX_AGE_MS,
  SSO_COOKIE_PATH,
  SsoService,
  type SsoCheck,
  type SsoView,
} from './sso.service';

@ApiTags('sso')
@Controller('sso')
@MinRole('admin')
export class SsoController {
  constructor(private readonly sso: SsoService) {}

  @Get()
  @ApiOperation({
    summary: 'Single sign-on settings of the active organization',
  })
  view(@CurrentAuth() auth: AuthContext): Promise<SsoView> {
    return this.sso.view(auth);
  }

  @Put()
  @MinRole('owner')
  @HttpCode(200)
  @ApiOperation({ summary: 'Save single sign-on settings (OpenID Connect)' })
  save(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<SsoView> {
    return this.sso.save(auth, body);
  }

  @Delete()
  @MinRole('owner')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove single sign-on' })
  remove(@CurrentAuth() auth: AuthContext): Promise<void> {
    return this.sso.remove(auth);
  }

  @Post('test')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Check that an identity provider can be reached and is usable',
  })
  test(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<SsoCheck> {
    return this.sso.check(auth, body);
  }
}

@ApiTags('sso')
@Controller('auth/sso')
export class SsoSignInController {
  constructor(
    private readonly sso: SsoService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('lookup')
  @ApiOperation({
    summary: 'Which organizations use single sign-on for this email address',
  })
  lookup(@Query('email') email: string | undefined, @Req() request: Request) {
    return this.sso.lookup(email ?? '', request.ip ?? 'unknown');
  }

  @Public()
  @Get('start')
  @Redirect()
  @ApiOperation({ summary: 'Send the browser to the identity provider' })
  async start(
    @Query('org') org: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ url: string; statusCode: number }> {
    const result = await this.sso.begin(org ?? '', request.ip ?? 'unknown');
    if ('code' in result) return this.failure(result.code);
    response.cookie(SSO_COOKIE, result.cookie, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get('COOKIE_SECURE'),
      path: SSO_COOKIE_PATH,
      maxAge: SSO_COOKIE_MAX_AGE_MS,
    });
    return { url: result.url, statusCode: 302 };
  }

  @Public()
  @Get('callback')
  @Redirect()
  @ApiOperation({
    summary: 'Where the identity provider sends the browser back',
  })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ url: string; statusCode: number }> {
    const cookie = readNamedCookie(request, SSO_COOKIE);
    response.clearCookie(SSO_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get('COOKIE_SECURE'),
      path: SSO_COOKIE_PATH,
    });
    const result = await this.sso.finish(
      { code, state, error },
      cookie,
      clientMeta(request),
    );
    if (!result.ok) return this.failure(result.code);
    setSessionCookie(
      response,
      result.token,
      result.expiresAt,
      this.config.get('COOKIE_SECURE'),
    );
    return { url: `${this.web()}/dashboard`, statusCode: 302 };
  }

  private failure(code: string): { url: string; statusCode: number } {
    return {
      url: `${this.web()}/login?sso_error=${encodeURIComponent(code)}`,
      statusCode: 302,
    };
  }

  private web(): string {
    return this.config.get('WEB_URL').replace(/\/+$/, '');
  }
}
