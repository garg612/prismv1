/**
 * Stage 5 RAG v2 - File Indexing Policy
 *
 * Deterministic allow/deny policy for which repository files to index.
 * Never index secrets, credentials, or binary content.
 */

/** Maximum file size to index in bytes (500 KB) */
export const MAX_FILE_SIZE_BYTES = 500 * 1024;

/** Skip reasons for audit/reporting */
export type SkipReason =
    | 'binary_extension'
    | 'excluded_directory'
    | 'excluded_filename'
    | 'secret_file'
    | 'credential_file'
    | 'lockfile'
    | 'generated_file'
    | 'minified_file'
    | 'over_size_limit'
    | 'build_output';

// ---- Excluded directories ----
const EXCLUDED_DIRS = new Set([
    'node_modules', 'vendor', '.git', '.hg', '.svn',
    'dist', 'build', 'out', 'output', '.next', '.nuxt',
    '__pycache__', '.pytest_cache', 'target', 'bin', 'obj',
    'coverage', '.nyc_output', '.turbo', '.cache', 'tmp', 'temp',
    '.idea', '.vscode', '.vs',
]);

// ---- Excluded file extensions (binary, media, archives) ----
const BINARY_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z', 'tgz',
    'mp3', 'mp4', 'wav', 'ogg', 'flac', 'mov', 'avi', 'mkv',
    'woff', 'woff2', 'ttf', 'eot', 'otf',
    'exe', 'dll', 'so', 'dylib', 'bin', 'obj', 'lib', 'a',
    'class', 'pyc', 'pyo', 'wasm',
    'pb', 'pkl', 'npy', 'npz', 'h5', 'pth', 'onnx',
    'db', 'sqlite', 'sqlite3',
    'DS_Store',
]);

// ---- Lockfiles (skip) ----
const LOCKFILE_NAMES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    'Gemfile.lock', 'Cargo.lock', 'poetry.lock', 'go.sum',
    'Pipfile.lock', 'composer.lock', 'mix.lock',
]);

// ---- Secret/credential patterns (filenames) ----
const SECRET_FILENAME_PATTERNS = [
    /^\.env/i,                          // .env, .env.local, .env.production
    /private[_-]?key/i,                 // private_key, privatekey
    /\.pem$/i,                          // PEM certificates
    /\.key$/i,                          // key files
    /\.p12$/i, /\.pfx$/i,              // PKCS12
    /\.crt$/i, /\.cer$/i,              // certificates
    /secrets\.(json|yaml|yml|toml)$/i, // secrets config
    /credentials\.(json|yaml|yml)$/i,  // credentials config
    /id_rsa$/i, /id_ed25519$/i,       // SSH private keys
    /\.secret$/i,
];

// ---- Generated/minified file patterns ----
const GENERATED_FILENAME_PATTERNS = [
    /\.min\.(js|css)$/i,               // minified
    /\.bundle\.(js)$/i,                // bundled
    /\.(generated|gen)\./i,            // explicit generated marker
    /\.pb\.go$/i,                      // protobuf Go generated
    /\.pb\.ts$/i,                      // protobuf TS generated
    /graphql\.schema\.ts$/i,           // generated schema
];

export interface FilterResult {
    allowed: boolean;
    reason?: SkipReason;
}

/**
 * Check if a repository file path is eligible for indexing.
 * Does NOT examine file content (content check is separate).
 */
export function isPathAllowed(filePath: string): FilterResult {
    // Normalize path separators
    const normPath = filePath.replace(/\\/g, '/').replace(/^\//, '');
    const segments = normPath.split('/');
    const filename = segments[segments.length - 1];

    // 1. Check excluded directories
    for (const seg of segments.slice(0, -1)) {
        if (EXCLUDED_DIRS.has(seg)) {
            return { allowed: false, reason: 'excluded_directory' };
        }
    }

    // 2. Check binary/media extensions
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    if (BINARY_EXTENSIONS.has(ext)) {
        return { allowed: false, reason: 'binary_extension' };
    }

    // 3. Check lockfiles
    if (LOCKFILE_NAMES.has(filename)) {
        return { allowed: false, reason: 'lockfile' };
    }

    // 4. Check secret/credential filenames — NEVER index these
    for (const pattern of SECRET_FILENAME_PATTERNS) {
        if (pattern.test(filename)) {
            return { allowed: false, reason: 'secret_file' };
        }
    }

    // 5. Check generated/minified files
    for (const pattern of GENERATED_FILENAME_PATTERNS) {
        if (pattern.test(filename)) {
            return { allowed: false, reason: 'generated_file' };
        }
    }

    return { allowed: true };
}

/**
 * Check raw content for size limit.
 * Never inspects content for secrets (secret filtering is path-based only to avoid
 * accidentally processing secrets during filter evaluation).
 */
export function isContentAllowed(sizeBytes: number): FilterResult {
    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
        return { allowed: false, reason: 'over_size_limit' };
    }
    return { allowed: true };
}
