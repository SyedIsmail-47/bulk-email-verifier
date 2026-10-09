/**
 * Expand the emails input into one string per address.
 * Blank entries are kept so they are reported as invalid instead of dropped.
 *
 * String forms, for the input editor:
 *   dataset:DATASET_ID
 *   dataset:DATASET_ID#field
 *   kv:STORE_ID/RECORD_KEY
 *   kv:STORE_ID/RECORD_KEY#field
 *
 * Object forms, for API calls:
 *   { datasetId, field? }
 *   { keyValueStoreId, key, field? }
 *
 * @param {unknown[] | unknown} sources
 * @param {{
 *   openDataset?: (id: string) => Promise<{ getData: (opts: { offset: number, limit: number }) => Promise<{ items?: unknown[] }> }>,
 *   openKeyValueStore?: (id: string) => Promise<{ getValue: (key: string) => Promise<unknown> }>,
 * }} deps
 */
export async function loadEmails(sources, deps) {
    const list = Array.isArray(sources) ? sources : [sources];
    /** @type {string[]} */
    const emails = [];
    for (const source of list) {
        if (typeof source === 'string') {
            emails.push(...await expandString(source, deps));
            continue;
        }
        if (source && typeof source === 'object') {
            if (typeof source.datasetId === 'string') {
                emails.push(...await readDataset(deps, source.datasetId, fieldName(source.field)));
                continue;
            }
            if (typeof source.keyValueStoreId === 'string') {
                emails.push(...await readKeyValue(deps, source.keyValueStoreId, source.key, fieldName(source.field)));
                continue;
            }
        }
        emails.push(source == null ? '' : String(source).trim());
    }
    return emails;
}

/**
 * @param {string} source
 * @param {Parameters<typeof loadEmails>[1]} deps
 */
async function expandString(source, deps) {
    const trimmed = source.trim();
    if (trimmed.startsWith('dataset:')) {
        const { datasetId, field } = parseDatasetRef(trimmed);
        return readDataset(deps, datasetId, field);
    }
    if (trimmed.startsWith('kv:')) {
        const { keyValueStoreId, key, field } = parseKvRef(trimmed);
        return readKeyValue(deps, keyValueStoreId, key, field);
    }
    return stringsFrom(source);
}

/**
 * @param {string} value
 */
function parseDatasetRef(value) {
    const body = value.slice('dataset:'.length).trim();
    const hash = body.indexOf('#');
    const datasetId = (hash === -1 ? body : body.slice(0, hash)).trim();
    const field = hash === -1 ? 'email' : fieldName(body.slice(hash + 1));
    if (!datasetId) throw new Error('Dataset reference is missing a dataset id. Use dataset:DATASET_ID#email.');
    return { datasetId, field };
}

/**
 * @param {string} value
 */
function parseKvRef(value) {
    const body = value.slice('kv:'.length).trim();
    const hash = body.indexOf('#');
    const path = (hash === -1 ? body : body.slice(0, hash)).trim();
    const field = hash === -1 ? 'email' : fieldName(body.slice(hash + 1));
    const slash = path.indexOf('/');
    if (slash === -1) {
        throw new Error(`Key-value reference "${value}" must look like kv:STORE_ID/RECORD_KEY.`);
    }
    const keyValueStoreId = path.slice(0, slash).trim();
    const key = path.slice(slash + 1).trim();
    if (!keyValueStoreId || !key) {
        throw new Error(`Key-value reference "${value}" must look like kv:STORE_ID/RECORD_KEY.`);
    }
    return { keyValueStoreId, key, field };
}

/**
 * @param {unknown} field
 */
function fieldName(field) {
    return typeof field === 'string' && field.trim() ? field.trim() : 'email';
}

/**
 * @param {Parameters<typeof loadEmails>[1]} deps
 * @param {string} datasetId
 * @param {string} field
 */
async function readDataset(deps, datasetId, field) {
    if (typeof deps.openDataset !== 'function') {
        throw new Error('Cannot open a dataset from this run.');
    }
    const dataset = await deps.openDataset(datasetId);
    /** @type {string[]} */
    const emails = [];
    const limit = 1000;
    let offset = 0;
    for (;;) {
        const page = await dataset.getData({ offset, limit });
        const items = page?.items ?? [];
        for (const item of items) emails.push(...stringsFrom(emailText(item, field)));
        if (items.length < limit) break;
        offset += items.length;
    }
    return emails;
}

/**
 * @param {Parameters<typeof loadEmails>[1]} deps
 * @param {string} storeId
 * @param {unknown} key
 * @param {string} field
 */
async function readKeyValue(deps, storeId, key, field) {
    if (typeof key !== 'string' || !key.trim()) {
        throw new Error('Key-value reference is missing a record key.');
    }
    if (typeof deps.openKeyValueStore !== 'function') {
        throw new Error('Cannot open a key-value store from this run.');
    }
    const store = await deps.openKeyValueStore(storeId);
    const value = await store.getValue(key.trim());
    if (value == null) {
        throw new Error(`Key-value store "${storeId}" has no record "${key.trim()}".`);
    }
    return collectStoredValue(value, field);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]}
 */
function collectStoredValue(value, field) {
    if (typeof value === 'string') return stringsFrom(value);
    if (Array.isArray(value)) return value.flatMap((item) => collectStoredValue(item, field));
    if (value && typeof value === 'object') {
        if (Array.isArray(value.emails)) return collectStoredValue(value.emails, field);
        return stringsFrom(emailText(value, field));
    }
    throw new Error('Stored email list must be text, an array, or objects with an email field.');
}

/**
 * @param {unknown} item
 * @param {string} field
 */
function emailText(item, field) {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
        if (typeof item[field] === 'string') return item[field];
        if (field !== 'email' && typeof item.email === 'string') return item.email;
    }
    return '';
}

/**
 * Split a pasted list. A blank string stays as one empty entry so an
 * explicit empty address is reported instead of dropped. Blank lines
 * between addresses are separators and are not separate results.
 * @param {string} text
 * @returns {string[]}
 */
export function stringsFrom(text) {
    const raw = typeof text === 'string' ? text : '';
    const parts = raw.split(/[\n,;]+/).map((part) => part.trim()).filter((part) => part.length > 0);
    if (parts.length > 0) return parts;
    return [raw.trim()];
}
