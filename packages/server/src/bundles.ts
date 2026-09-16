import path from 'node:path';

export const MAX_BUNDLE_FILES = 256;
export const MAX_BUNDLE_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_BUNDLE_REQUEST_BYTES = 100 * 1024 * 1024;
export const MAX_BUNDLE_PATH_LENGTH = 512;
export const MAX_BUNDLE_SEGMENT_LENGTH = 128;

export const BUNDLE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export interface BundleFile {
  path: string;
  bytes: Uint8Array;
}

export class BundleInputError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 415) {
    super(message);
  }
}

export function validateBundlePath(relativePath: string) {
  if (relativePath.length === 0 || relativePath.length > MAX_BUNDLE_PATH_LENGTH) {
    throw new BundleInputError('invalid bundle path length', 400);
  }
  if (path.posix.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.includes('\\')) {
    throw new BundleInputError(`unsafe bundle path: ${relativePath}`, 400);
  }
  if (/[\0-\x1f\x7f?#]/.test(relativePath)) {
    throw new BundleInputError(`unsafe bundle path: ${relativePath}`, 400);
  }
  const segments = relativePath.split('/');
  if (segments[0].toLowerCase() === '_history' || segments.some(segment =>
    segment.length === 0 ||
    segment.length > MAX_BUNDLE_SEGMENT_LENGTH ||
    segment === '.' ||
    segment === '..' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    throw new BundleInputError(`unsafe bundle path: ${relativePath}`, 400);
  }
}

export function bundleContentType(relativePath: string) {
  validateBundlePath(relativePath);
  const contentType = BUNDLE_CONTENT_TYPES[path.posix.extname(relativePath).toLowerCase()];
  if (!contentType) throw new BundleInputError(`unsupported bundle file: ${relativePath}`, 415);
  return contentType;
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

export async function parseBundleFiles(body: Record<string, unknown>, primaryName: string): Promise<BundleFile[] | null> {
  const manifestValues = values(body.bundle_manifest);
  const assetFields = Object.keys(body).filter(key => key.startsWith('asset_'));
  if (manifestValues.length === 0) {
    if (assetFields.length) throw new BundleInputError(`undeclared bundle field: ${assetFields[0]}`, 400);
    return null;
  }
  if (manifestValues.length !== 1 || typeof manifestValues[0] !== 'string') {
    throw new BundleInputError('bundle_manifest must appear exactly once as text', 400);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestValues[0]);
  } catch {
    throw new BundleInputError('invalid bundle_manifest JSON', 400);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new BundleInputError('invalid bundle_manifest shape', 400);
  }
  const record = manifest as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.files)) {
    throw new BundleInputError('unsupported bundle_manifest version or shape', 400);
  }
  if (record.files.length > MAX_BUNDLE_FILES) {
    throw new BundleInputError(`bundle exceeds ${MAX_BUNDLE_FILES} companion files`, 413);
  }

  const declaredFields = new Set<string>();
  const declaredPaths = new Set<string>();
  const parsed: BundleFile[] = [];
  for (const item of record.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new BundleInputError('invalid bundle_manifest file entry', 400);
    }
    const { field, path: relativePath, size } = item as Record<string, unknown>;
    if (typeof field !== 'string' || !/^asset_[0-9]+$/.test(field) ||
        typeof relativePath !== 'string' || !Number.isSafeInteger(size) || Number(size) < 0) {
      throw new BundleInputError('invalid bundle_manifest file entry', 400);
    }
    if (declaredFields.has(field)) throw new BundleInputError(`duplicate bundle field: ${field}`, 400);
    declaredFields.add(field);
    validateBundlePath(relativePath);
    bundleContentType(relativePath);
    const foldedPath = relativePath.toLowerCase();
    if (declaredPaths.has(foldedPath)) throw new BundleInputError(`duplicate bundle path: ${relativePath}`, 400);
    if (foldedPath === primaryName.toLowerCase()) throw new BundleInputError(`bundle path collides with primary document: ${relativePath}`, 400);
    declaredPaths.add(foldedPath);
    if (Number(size) > MAX_BUNDLE_FILE_BYTES) {
      throw new BundleInputError(`bundle file exceeds ${MAX_BUNDLE_FILE_BYTES} bytes: ${relativePath}`, 413);
    }

    const fieldValues = values(body[field]);
    if (fieldValues.length !== 1 || !(fieldValues[0] instanceof File)) {
      throw new BundleInputError(`bundle field must contain exactly one file: ${field}`, 400);
    }
    const file = fieldValues[0];
    if (file.size !== Number(size)) throw new BundleInputError(`bundle size mismatch: ${relativePath}`, 400);
    parsed.push({ path: relativePath, bytes: new Uint8Array(await file.arrayBuffer()) });
  }

  for (const field of assetFields) {
    if (!declaredFields.has(field)) throw new BundleInputError(`undeclared bundle field: ${field}`, 400);
  }
  return parsed;
}
