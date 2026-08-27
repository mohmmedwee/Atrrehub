import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { AppError } from '../errors/app-error';
import { AppLogger } from '../logger/logger.service';

export interface StoredObject {
  key: string;
  size: number;
  checksum: string;
  contentType: string;
}

export interface StorageConfig {
  driver: 'local' | 's3';
  localPath: string;
  s3: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
  };
}

/** Uploads are restricted to formats the platform can safely serve or ingest. */
const ALLOWED_CONTENT_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/html',
  'application/json',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
]);

const MAX_SIZE_BYTES = 25 * 1024 * 1024;

/**
 * Object storage with a filesystem driver for development and private-cloud
 * installs, and an S3-compatible driver for SaaS. Keys are always prefixed with
 * the owning organization so a path traversal cannot escape the tenant.
 */
@Injectable()
export class StorageService {
  constructor(
    private readonly config: StorageConfig,
    private readonly logger: AppLogger,
  ) {}

  /** `org/{orgId}/{scope}/{yyyy}/{mm}/{name}` — tenant-prefixed and time-partitioned. */
  buildKey(organizationId: string, scope: string, filename: string): string {
    const now = new Date();
    const safe = filename.replace(/[^\w.-]/g, '_').slice(-120);
    return [
      'org',
      organizationId,
      scope,
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      `${Date.now()}-${safe}`,
    ].join('/');
  }

  /**
   * Store an artefact the platform generated itself — a database backup, an
   * export archive.
   *
   * Deliberately separate from `put`, which guards *uploads*: its content-type
   * allow-list and 25 MB ceiling exist because that body came from a user, and
   * neither makes sense for a dump this process just produced. Nothing
   * reachable from a request may call this.
   */
  async putInternal(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const checksum = createHash('sha256').update(body).digest('hex');

    if (this.config.driver === 'local') {
      const path = this.localPath(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    } else {
      await this.s3Request('PUT', key, body, contentType);
    }
    return { key, size: body.byteLength, checksum, contentType };
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    if (body.byteLength > MAX_SIZE_BYTES) {
      throw AppError.badRequest(`File exceeds the ${MAX_SIZE_BYTES / 1024 / 1024} MB limit`);
    }
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw AppError.badRequest(`Content type ${contentType} is not allowed`);
    }

    const checksum = createHash('sha256').update(body).digest('hex');
    if (this.config.driver === 'local') {
      const path = this.localPath(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    } else {
      await this.s3Request('PUT', key, body, contentType);
    }
    return { key, size: body.byteLength, checksum, contentType };
  }

  async get(key: string): Promise<Buffer> {
    if (this.config.driver === 'local') {
      try {
        return await readFile(this.localPath(key));
      } catch {
        throw AppError.notFound('File', key);
      }
    }
    const response = await this.s3Request('GET', key);
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    if (this.config.driver === 'local') {
      await rm(this.localPath(key), { force: true });
      return;
    }
    await this.s3Request('DELETE', key);
  }

  async exists(key: string): Promise<boolean> {
    if (this.config.driver === 'local') {
      return stat(this.localPath(key))
        .then(() => true)
        .catch(() => false);
    }
    try {
      await this.s3Request('HEAD', key);
      return true;
    } catch {
      return false;
    }
  }

  /** Everything an authorized client needs to fetch the object through the API. */
  publicUrl(key: string, apiBaseUrl: string): string {
    return `${apiBaseUrl}/api/v1/files/${encodeURIComponent(key)}`;
  }

  private localPath(key: string): string {
    const root = resolve(this.config.localPath);
    const path = resolve(join(root, normalize(key)));
    // Reject anything that escapes the storage root, whatever the key contained.
    if (!path.startsWith(root + '/') && path !== root) {
      throw AppError.badRequest('Invalid storage key');
    }
    return path;
  }

  /**
   * Minimal SigV4-free S3 access: most S3-compatible endpoints used for private
   * deployments (MinIO, Ceph) accept presigned or path-style requests with a
   * bearer credential. Deployments needing full SigV4 supply a gateway in front.
   */
  private async s3Request(
    method: string,
    key: string,
    body?: Buffer,
    contentType?: string,
  ): Promise<Response> {
    const { endpoint, bucket, forcePathStyle } = this.config.s3;
    if (!endpoint) throw AppError.dependency('Object storage endpoint is not configured');
    const url = forcePathStyle
      ? `${endpoint}/${bucket}/${key}`
      : `${endpoint.replace('://', `://${bucket}.`)}/${key}`;

    const response = await fetch(url, {
      method,
      body: body ? new Uint8Array(body) : undefined,
      headers: {
        ...(contentType ? { 'content-type': contentType } : {}),
        ...(this.config.s3.accessKeyId
          ? {
              authorization: `Bearer ${this.config.s3.accessKeyId}:${this.config.s3.secretAccessKey}`,
            }
          : {}),
      },
    });

    if (!response.ok) {
      this.logger.error('Object storage request failed', undefined, {
        method,
        key,
        status: response.status,
      });
      throw AppError.dependency('Object storage');
    }
    return response;
  }
}
