import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { API_SCOPES, type ScopeInfo } from './api-keys';
import {
  ApiKeysService,
  type ApiKeyView,
  type CreatedApiKey,
} from './api-keys.service';
import type { AuthContext } from './auth.types';
import { CurrentAuth, MinRole } from './decorators';

@ApiTags('api-keys')
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get('scopes')
  @MinRole('viewer')
  @ApiOperation({ summary: 'Scopes an API key can have' })
  scopes(): readonly ScopeInfo[] {
    return API_SCOPES;
  }

  @Get()
  @MinRole('admin')
  @ApiOperation({ summary: 'API keys of the active organization' })
  list(@CurrentAuth() auth: AuthContext): Promise<ApiKeyView[]> {
    return this.keys.list(auth);
  }

  @Post()
  @MinRole('admin')
  @ApiOperation({
    summary: 'Create an API key. The key is shown once in the response.',
  })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<CreatedApiKey> {
    return this.keys.create(auth, body);
  }

  @Delete(':id')
  @HttpCode(200)
  @MinRole('admin')
  @ApiOperation({ summary: 'Revoke an API key' })
  revoke(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ApiKeyView> {
    return this.keys.revoke(auth, id);
  }
}
