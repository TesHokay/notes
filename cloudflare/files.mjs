import { DurableObject } from 'cloudflare:workers';
import repository from './file-repository.cjs';
export class CrmFiles extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.queue = Promise.resolve();
    this.repository = new repository.FileRepository(ctx.storage, {
      filesBytes: env.FILES_MAX_BYTES, backupBytes: env.BACKUP_MAX_BYTES, backupCount: env.BACKUP_MAX_COUNT,
    });
    ctx.blockConcurrencyWhile(async () => this.repository.initialize());
  }
  fetch(request) {
    const result = this.queue.then(() => this.handle(request)).catch(error => {
      if (!error.status) console.error('[file-storage]', error.message);
      return Response.json({ error: error.message }, { status: error.status || 500 });
    });
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  async upload(request, key) {
    const maximum = this.repository.maxObjectBytes(key);
    if (Number(request.headers.get('Content-Length') || 0) > maximum) throw new repository.StorageError('Файл превышает допустимый размер.', 413);
    const version = this.repository.begin();
    const reader = request.body?.getReader();
    let size = 0, index = 0, filled = 0;
    let buffer = new Uint8Array(repository.CHUNK_BYTES);
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum) throw new repository.StorageError('Файл превышает допустимый размер.', 413);
        for (let offset = 0; offset < value.byteLength;) {
          const length = Math.min(buffer.byteLength - filled, value.byteLength - offset);
          buffer.set(value.subarray(offset, offset + length), filled); filled += length; offset += length;
          if (filled === buffer.byteLength) {
            this.repository.append(version, index++, buffer);
            buffer = new Uint8Array(repository.CHUNK_BYTES); filled = 0;
          }
        }
      }
      if (filled) this.repository.append(version, index, buffer.subarray(0, filled));
      return Response.json(this.repository.commit(key, version, size, request.headers.get('Content-Type')), { status: 201 });
    } catch (error) {
      this.repository.discard(version);
      if (reader) await reader.cancel().catch(() => {});
      throw error;
    } finally { reader?.releaseLock(); }
  }
  async handle(request) {
    const url = new URL(request.url);
    if (url.pathname === '/stats' && request.method === 'GET') return Response.json(this.repository.stats());
    if (url.pathname === '/objects' && request.method === 'GET') return Response.json({ objects: this.repository.list(url.searchParams.get('prefix') || '') });
    if (url.pathname === '/objects' && request.method === 'DELETE') {
      const keys = await request.json();
      if (!Array.isArray(keys) || keys.length > 1000) throw new repository.StorageError('Некорректный список файлов.', 400);
      this.repository.delete(keys);
      return new Response(null, { status: 204 });
    }
    if (url.pathname !== '/object') return new Response('Not found', { status: 404 });
    const key = url.searchParams.get('key');
    this.repository.scope(key);
    if (request.method === 'PUT') return this.upload(request, key);
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const object = this.repository.get(key);
    if (!object) return new Response('Not found', { status: 404 });
    let index = 0;
    const body = new ReadableStream({ pull(controller) {
      if (index < object.chunks.length) controller.enqueue(object.chunks[index++]);
      else controller.close();
    } });
    return new Response(body, { headers: {
      'Content-Type': object.content_type, 'Content-Length': String(object.size),
      'X-CRM-Uploaded': String(object.uploaded), 'ETag': '"' + object.version + '"',
    } });
  }
}
