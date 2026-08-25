import { Router, type IRouter, type RequestHandler } from 'express';

/**
 * A Router whose handlers can be async.
 *
 * Express 5 forwards a rejected handler promise to the error middleware on its
 * own, and this repo depends on Express 5. The wrapper is here anyway because
 * the failure mode when that assumption breaks is not a 500 - it is the whole
 * API process exiting on an unhandled rejection, taking every in-flight run
 * with it. That happened once during development, when a hoisting conflict
 * quietly installed Express 4 instead. Fifteen lines is a cheap price for the
 * tier not depending on which major version resolved.
 */
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const wrap =
  (handler: RequestHandler): RequestHandler =>
  (request, response, next) => {
    try {
      const result = handler(request, response, next) as unknown;
      if (result instanceof Promise) result.catch(next);
    } catch (error) {
      next(error);
    }
  };

export function asyncRouter(): IRouter {
  const router = Router();

  for (const method of METHODS) {
    const original = router[method].bind(router) as (
      path: string,
      ...handlers: RequestHandler[]
    ) => unknown;

    Object.defineProperty(router, method, {
      value: (path: string, ...handlers: RequestHandler[]) =>
        original(path, ...handlers.map(wrap)),
    });
  }

  return router;
}
