import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res, UseFilters } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request, Response } from 'express';
import { DaboApiService } from './dabo-api.service.ts';
import { DaboErrorFilter } from './error.filter.ts';

@Controller('api')
@NeedLogin()
@UseFilters(DaboErrorFilter)
// Production and local demo have mutually exclusive application roots.
// eslint-disable-next-line @darraghor/nestjs-typed/injectable-should-be-provided
export class DaboController {
  constructor(@Inject(DaboApiService) private readonly service: DaboApiService) {}

  @Get('session')
  session(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.service.session(request, response);
  }

  @Post('demo/session')
  @HttpCode(200)
  selectDemo(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() input: unknown) {
    response.setHeader('Cache-Control', 'no-store');
    return this.service.selectDemo(request, response, input);
  }

  @Get('workspace')
  workspace(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Query() query: Record<string, unknown>) {
    response.setHeader('Cache-Control', 'no-store');
    return this.service.workspace(request, query);
  }

  @Post('commands')
  @HttpCode(200)
  command(@Req() request: Request, @Body() input: unknown) { return this.service.command(request, input); }

  @Post('imports/preview')
  @HttpCode(200)
  preview(@Req() request: Request, @Body() input: unknown) { return this.service.preview(request, input); }

  @Post('imports/commit')
  @HttpCode(200)
  commit(@Req() request: Request, @Body() input: unknown) { return this.service.commit(request, input); }

  @Get('imports/template/:kind')
  template(@Req() request: Request, @Param('kind') kind: string, @Res() response: Response) {
    const csv = this.service.template(request, kind);
    response.setHeader('Content-Disposition', `attachment; filename="dabo-${kind}-template.csv"`);
    response.type('text/csv; charset=utf-8').send(csv);
  }

  @Post('exports/:kind')
  @HttpCode(200)
  async export(@Req() request: Request, @Param('kind') kind: string, @Body() query: Record<string, unknown>, @Res() response: Response) {
    const csv = await this.service.export(request, kind, query);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Disposition', `attachment; filename="dabo-${kind}.csv"`);
    response.type('text/csv; charset=utf-8').send(csv);
  }
}
