export class PathError extends Error { status: number; constructor(message: string, status?: number); }
export function resolveInRoot(roots: string[], root: string, rel: string, opts?: { mode?: 'follow' | 'entry'; mustExist?: boolean }): Promise<{ rootReal: string; target: string; real: string | null; exists: boolean }>;
export function validName(name: unknown): boolean;
export function readFolders(file: string, fallback: string): Promise<string[]>;
