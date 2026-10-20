import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { DomainError } from '../../domain/errors.ts';

@Catch()
export class DaboErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof DomainError) {
      const code = exception.code;
      const status = code === 'UNAUTHENTICATED' ? 401 : code === 'FORBIDDEN' ? 403 : code === 'NOT_FOUND' ? 404 : ['VERSION_CONFLICT', 'IDENTITY_CONFLICT', 'DUPLICATE', 'IMPORT_CONFLICT'].includes(code) ? 409 : 422;
      response.status(status).json({ error: { code, message: exception.message, details: exception.details } });
      return;
    }
    if (exception instanceof ZodError) {
      response.status(422).json({ error: { code: 'VALIDATION_ERROR', message: '输入不符合要求，请检查标记字段。', details: exception.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } });
      return;
    }
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json({ error: { code: 'HTTP_ERROR', message: exception.message } });
      return;
    }
    // Do not log request bodies, SQL, addresses, or platform headers.
    Logger.error(`Request failed: ${exception instanceof Error ? exception.name : 'UnknownError'}`, 'Dabo');
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，操作未完成。请稍后重试。' } });
  }
}
