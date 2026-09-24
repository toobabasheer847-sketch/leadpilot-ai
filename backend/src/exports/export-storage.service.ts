import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

@Injectable()
export class ExportStorageService {
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('export.storagePath', './storage/exports'));
  }

  async save(fileName: string, content: Buffer) {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.safePath(fileName), content);
    return fileName;
  }

  async get(fileName: string) { return readFile(this.safePath(fileName)); }
  stream(fileName: string) { return createReadStream(this.safePath(fileName)); }
  async delete(fileName: string) { await unlink(this.safePath(fileName)).catch(() => undefined); }
  async exists(fileName: string) { try { await readFile(this.safePath(fileName)); return true; } catch { return false; } }

  private safePath(fileName: string) {
    const path = resolve(join(this.root, fileName));
    const childPath = relative(this.root, path);
    if (childPath.startsWith('..') || isAbsolute(childPath)) throw new Error('Invalid export file path');
    return path;
  }
}
