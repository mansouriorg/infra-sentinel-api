import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { DomainService } from './domain.service';
import { PublicStatusService } from './public.service';
import {
  renderMessagePage,
  renderRss,
  renderStatusPage,
  summaryJson,
  PAGE_CSP,
  STATIC_CSP,
  type RenderContext,
} from './status.render';
import { toPublicInfo, type PageRow } from './status.rows';
import type { StatusRequest } from './status.routing';

@Public()
@Controller('public')
export class PublicStatusController {
  constructor(
    private readonly status: PublicStatusService,
    private readonly domains: DomainService,
  ) {}

  private context(request: StatusRequest, page: PageRow): RenderContext {
    const base = request.statusBase ?? `/api/v1/public/status/${page.slug}`;
    return { base, publicUrl: this.status.baseUrl(page) };
  }

  private html(response: Response, csp: string, status = 200): void {
    response.status(status);
    response.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'Cache-Control': status === 200 ? 'public, max-age=15' : 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
  }

  private missing(response: Response): string {
    this.html(response, STATIC_CSP, 404);
    return renderMessagePage({
      page: null,
      title: 'Page not found',
      message: 'This status page does not exist or is not public.',
      base: '',
      back: false,
    });
  }

  private message(
    response: Response,
    request: StatusRequest,
    page: PageRow,
    title: string,
    text: string,
    code = 200,
    form?: { token: string; button: string },
  ): string {
    this.html(response, STATIC_CSP, code);
    response.set('Cache-Control', 'no-store');
    const base = this.context(request, page).base;
    return renderMessagePage({
      page: toPublicInfo(page),
      title,
      message: text,
      base,
      form: form
        ? {
            action: `${base}/unsubscribe`,
            token: form.token,
            button: form.button,
          }
        : undefined,
    });
  }

  @Get('domains/allowed')
  async allowed(
    @Query('domain') domain: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const ok = await this.domains.allowed(domain ?? '');
    response.status(ok ? 200 : 404).set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return ok ? 'ok' : 'unknown domain';
  }

  @Get('status/:slug')
  async page(
    @Param('slug') slug: string,
    @Req() request: StatusRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const page = await this.status.findPublished(slug);
    if (!page) return this.missing(response);
    const model = await this.status.model(page);
    this.html(response, PAGE_CSP);
    return renderStatusPage(model, this.context(request, page));
  }

  @Get('status/:slug/rss.xml')
  async rss(
    @Param('slug') slug: string,
    @Req() request: StatusRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const page = await this.status.findPublished(slug);
    if (!page) return this.missing(response);
    const model = await this.status.model(page);
    response.set({
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    });
    return renderRss(model, this.context(request, page));
  }

  @Get('status/:slug/summary.json')
  async summary(
    @Param('slug') slug: string,
    @Req() request: StatusRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const page = await this.status.findPublished(slug);
    if (!page) {
      response.status(404);
      return { error: 'Not found' };
    }
    const model = await this.status.model(page);
    response.set({
      'Cache-Control': 'public, max-age=15',
      'Access-Control-Allow-Origin': '*',
    });
    return summaryJson(model, this.context(request, page));
  }

  @Post('status/:slug/subscribe')
  @HttpCode(200)
  async subscribe(
    @Param('slug') slug: string,
    @Body() body: Record<string, unknown> | undefined,
    @Req() request: StatusRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const page = await this.status.findPublished(slug);
    if (!page) return this.missing(response);
    if (
      typeof body?.company_url === 'string' &&
      body.company_url.trim() !== ''
    ) {
      return this.message(
        response,
        request,
        page,
        'Check your inbox',
        'If that address is valid, we sent a link to confirm your subscription.',
      );
    }
    const outcome = await this.status.subscribe(
      page,
      body?.email,
      request.ip ?? '',
    );
    if (outcome === 'invalid') {
      return this.message(
        response,
        request,
        page,
        'Check the email address',
        'Enter a valid email address and try again.',
        400,
      );
    }
    if (outcome === 'rate_limited') {
      return this.message(
        response,
        request,
        page,
        'Too many attempts',
        'Please wait a while before trying again.',
        429,
      );
    }
    return this.message(
      response,
      request,
      page,
      'Check your inbox',
      'If that address is valid, we sent a link to confirm your subscription.',
    );
  }

  @Get('status/:slug/confirm')
  async confirm(
    @Param('slug') slug: string,
    @Query('token') token: string | undefined,
    @Req() request: StatusRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const page = await this.status.findPublished(slug);
    if (!page) return this.missing(response);
    if (!(await this.status.confirm(page, token))) {
      return this.message(
        response,
        request,
        page,
        'This link is not valid',
        'The confirmation link is invalid or the subscription was removed. You can subscribe again from the status page.',
        400,
      );
    }
    return this.message(
      response,
      request,
      page,
      'You are subscribed',
      `You will get an email when an incident is created, updated or resolved on ${page.name}.`,
    );
  }

  @Get('status/:slug/unsubscribe')
  async unsubscribePage(
    @Param('slug') slug: string,
    @Query('token') token: string | undefined,
    @Req() request: StatusRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const page = await this.status.findPublished(slug);
    if (!page) return this.missing(response);
    if (!(await this.status.knowsToken(page, token))) {
      return this.message(
        response,
        request,
        page,
        'Already unsubscribed',
        'This address is not subscribed to updates.',
      );
    }
    return this.message(
      response,
      request,
      page,
      'Unsubscribe',
      `Stop emails about incidents on ${page.name}?`,
      200,
      {
        token: token as string,
        button: 'Unsubscribe',
      },
    );
  }

  @Post('status/:slug/unsubscribe')
  @HttpCode(200)
  async unsubscribe(
    @Param('slug') slug: string,
    @Query('token') queryToken: string | undefined,
    @Body() body: Record<string, unknown> | undefined,
    @Req() request: StatusRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const page = await this.status.findPublished(slug);
    if (!page) return this.missing(response);
    const token =
      queryToken ?? (typeof body?.token === 'string' ? body.token : undefined);
    await this.status.unsubscribe(page, token);
    return this.message(
      response,
      request,
      page,
      'You are unsubscribed',
      'You will not get any more emails about incidents on this page.',
    );
  }
}
