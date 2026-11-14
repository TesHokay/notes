class FileStore {
  constructor(namespace) { this.namespace = namespace; }
  async request(path, options) {
    const stub = this.namespace.get(this.namespace.idFromName('files'));
    const response = await stub.fetch(new Request('https://crm-files.internal' + path, options));
    if (!response.ok && response.status !== 404) {
      const detail = await response.json().catch(() => ({}));
      const error = new Error(response.status < 500 || response.status === 507 ? detail.error || 'Ошибка хранилища файлов.' : 'Не удалось обратиться к хранилищу файлов.');
      error.status = response.status; error.userFacing = true; throw error;
    }
    return response;
  }
  async put(key, body, options = {}) {
    const response = await this.request('/object?key=' + encodeURIComponent(key), {
      method: 'PUT', body, headers: { 'Content-Type': options.httpMetadata?.contentType || 'application/octet-stream' },
    });
    return response.json();
  }
  async get(key) {
    const response = await this.request('/object?key=' + encodeURIComponent(key));
    if (response.status === 404) { await response.body?.cancel(); return null; }
    return { key, size: Number(response.headers.get('Content-Length')), uploaded: new Date(Number(response.headers.get('X-CRM-Uploaded'))),
      httpMetadata: { contentType: response.headers.get('Content-Type') }, arrayBuffer: () => response.arrayBuffer() };
  }
  async list({ prefix = '' } = {}) {
    const response = await this.request('/objects?prefix=' + encodeURIComponent(prefix));
    const list = await response.json();
    return { objects: list.objects.map(object => ({ ...object, uploaded: new Date(object.uploaded) })) };
  }
  async delete(keys) {
    const response = await this.request('/objects', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Array.isArray(keys) ? keys : [keys]) });
    await response.text();
  }
  async stats() { return (await this.request('/stats')).json(); }
}
module.exports = { FileStore };
