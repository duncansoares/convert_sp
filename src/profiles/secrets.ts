import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface SecretStore {
  get(id: string): Promise<string | null>;
  set(id: string, value: string): Promise<void>;
  remove(id: string): Promise<void>;
  readonly mode: string;
}

export function appDataDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'convert-sp');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'convert-sp');
}

interface SecretsFile {
  version: 1;
  salt: string;
  entries: Record<string, { iv: string; tag: string; data: string }>;
}

const KEY_FILE = 'secret.key';
const SECRETS_FILE = 'secrets.json';

async function readJson<T>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(target, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Secrets are encrypted with AES-256-GCM.
 *
 * With CONVERT_SP_PASSPHRASE set, the key is derived with scrypt and the passphrase is
 * never stored. Without it, a random key file is created next to the secrets. That
 * protects against accidental disclosure (logs, backups of config files) but not against
 * someone who can read the whole configuration directory. Use the passphrase for that.
 */
export async function createSecretStore(): Promise<SecretStore> {
  const directory = appDataDir();
  const secretsPath = path.join(directory, SECRETS_FILE);
  const keyPath = path.join(directory, KEY_FILE);
  await mkdir(directory, { recursive: true });

  const passphrase = process.env.CONVERT_SP_PASSPHRASE;
  const existing = await readJson<SecretsFile>(secretsPath);
  const salt = existing?.salt ?? randomBytes(16).toString('hex');

  let key: Buffer;
  let mode: string;
  if (passphrase) {
    key = scryptSync(passphrase, salt, 32);
    mode = 'passphrase';
  } else {
    let keyHex: string | null = null;
    try {
      keyHex = (await readFile(keyPath, 'utf8')).trim();
    } catch {
      keyHex = null;
    }
    if (!keyHex) {
      keyHex = randomBytes(32).toString('hex');
      await writeFile(keyPath, `${keyHex}\n`, { mode: 0o600 });
    }
    key = Buffer.from(keyHex, 'hex');
    mode = 'local-key-file';
  }

  const read = async (): Promise<SecretsFile> =>
    (await readJson<SecretsFile>(secretsPath)) ?? { version: 1, salt, entries: {} };

  return {
    mode,
    async get(id) {
      const file = await read();
      const entry = file.entries[id];
      if (!entry) {
        return null;
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'hex'));
        decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
        const plain = Buffer.concat([
          decipher.update(Buffer.from(entry.data, 'hex')),
          decipher.final(),
        ]);
        return plain.toString('utf8');
      } catch {
        return null;
      }
    },
    async set(id, value) {
      const file = await read();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      file.entries[id] = {
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
        data: encrypted.toString('hex'),
      };
      file.salt = salt;
      await writeJson(secretsPath, file);
    },
    async remove(id) {
      const file = await read();
      if (file.entries[id]) {
        delete file.entries[id];
        await writeJson(secretsPath, file);
      }
    },
  };
}
