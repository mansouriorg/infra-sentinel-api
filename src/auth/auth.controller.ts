import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AppConfig } from '../config/app-config';
import type { AuthContext } from './auth.types';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  LoginTwoFactorDto,
  RegisterDto,
  ResetPasswordDto,
  TokenDto,
  UpdateProfileDto,
} from './auth.dto';
import {
  AuthService,
  isChallenge,
  type LoginResult,
  type MeResponse,
  type SessionResult,
  type TwoFactorChallenge,
} from './auth.service';
import { CurrentAuth, Public } from './decorators';
import {
  clearSessionCookie,
  clientMeta,
  readSessionToken,
  setSessionCookie,
} from './session-cookie';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Create an account and a first organization' })
  async register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MeResponse> {
    return this.startSession(
      response,
      await this.auth.register(dto, clientMeta(request)),
    );
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with email and password' })
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MeResponse | TwoFactorChallenge> {
    const result: LoginResult = await this.auth.login(dto, clientMeta(request));
    if (isChallenge(result)) return result;
    return this.startSession(response, result);
  }

  @Public()
  @Post('login/2fa')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Finish signing in with a code from your authenticator app or a recovery code',
  })
  async loginTwoFactor(
    @Body() dto: LoginTwoFactorDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MeResponse> {
    return this.startSession(
      response,
      await this.auth.loginTwoFactor(dto, clientMeta(request)),
    );
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out and revoke the current session' })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(readSessionToken(request));
    clearSessionCookie(response, this.config.get('COOKIE_SECURE'));
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user and their organizations' })
  me(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    return this.auth.me(auth);
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update your display name' })
  updateProfile(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: UpdateProfileDto,
  ): Promise<MeResponse> {
    return this.auth.updateProfile(auth, dto.name);
  }

  @Patch('password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Change your password and sign out other devices' })
  changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    return this.auth.changePassword(auth, dto.currentPassword, dto.newPassword);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Email a password reset link' })
  forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.auth.forgotPassword(dto.email, clientMeta(request));
  }

  @Public()
  @Post('reset-password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Set a new password using an emailed token' })
  resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.auth.resetPassword(
      dto.token,
      dto.password,
      clientMeta(request),
    );
  }

  @Public()
  @Post('verify-email')
  @HttpCode(204)
  @ApiOperation({ summary: 'Confirm an email address using an emailed token' })
  verifyEmail(@Body() dto: TokenDto): Promise<void> {
    return this.auth.verifyEmail(dto.token);
  }

  @Post('resend-verification')
  @HttpCode(204)
  @ApiOperation({ summary: 'Send the confirmation email again' })
  resendVerification(@CurrentAuth() auth: AuthContext): Promise<void> {
    return this.auth.resendVerification(auth);
  }

  private startSession(response: Response, result: SessionResult): MeResponse {
    setSessionCookie(
      response,
      result.token,
      result.expiresAt,
      this.config.get('COOKIE_SECURE'),
    );
    return result.me;
  }
}
