export function isRedisOomError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return typeof error === 'string' && /\bOOM command not allowed\b/i.test(error);
  }
  const code = 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  const message = error instanceof Error ? error.message : '';
  return code.toUpperCase() === 'OOM' || /\bOOM command not allowed\b/i.test(message);
}