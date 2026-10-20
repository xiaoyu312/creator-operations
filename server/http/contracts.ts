import type { IncomingHttpHeaders } from 'node:http';
import type { PlatformIdentityContext } from '../runtime/config.ts';

/** App-owned transport seam. Platform middleware must supply verified userContext. */
export interface Request {
  headers: IncomingHttpHeaders;
  userContext?: PlatformIdentityContext;
}

export interface Response {
  cookie(name: string, value: string, options: {
    httpOnly: boolean;
    sameSite: 'strict';
    path: string;
    maxAge: number;
  }): unknown;
}
