import { randomUUID } from 'node:crypto';

export const newId = () => randomUUID();
export const nowIso = () => new Date().toISOString();

const ANSI = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (text: string) => text.replace(ANSI, '');

/** An HTTP error the error handler turns into { error } with a status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new ApiError(400, message);
export const notFound = (what: string) => new ApiError(404, `${what} not found.`);

/** Trimmed string from unknown input, or '' — used on every request body field. */
export function str(value: unknown, max = 4000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A filesystem-safe slug, for naming generated spec files readably. */
export function slug(text: string, fallback = 'test'): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}
