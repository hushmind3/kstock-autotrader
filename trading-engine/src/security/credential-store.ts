import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  maskAccount,
  type AccountScope,
  type BrokerCredentials,
  type BrokerId,
  type CachedAccessToken,
  type TokenStore,
  type TradingEnvironment,
} from "@kstock/shared";

const SERVICE = "kstock-autotrader";

async function keyringEntry(name: string) {
  const { Entry } = await import("@napi-rs/keyring");
  return new Entry(SERVICE, name);
}

function credentialEntryName(brokerId: BrokerId, environment: TradingEnvironment): string {
  return `credentials:${brokerId}:${environment}`;
}

function derivativeCredentialEntryName(environment: TradingEnvironment): string {
  return `derivatives-credentials:koreainvestment:${environment}`;
}

function tokenEntryName(scope: AccountScope): string {
  return `token:${scope.brokerId}:${scope.environment}:${scope.accountId}`;
}

function envPrefix(brokerId: BrokerId, environment: TradingEnvironment): string {
  const broker = brokerId === "koreainvestment" ? "KIS" : "KIWOOM";
  return `${broker}_${environment === "live" ? "LIVE" : "PAPER"}`;
}

function credentialsFromEnvironment(
  brokerId: BrokerId,
  environment: TradingEnvironment,
): BrokerCredentials | null {
  const prefix = envPrefix(brokerId, environment);
  const appKey = process.env[`${prefix}_APP_KEY`];
  const appSecret = process.env[`${prefix}_APP_SECRET`];
  const accountId = process.env[`${prefix}_ACCOUNT_ID`];
  if (!appKey || !appSecret || !accountId) return null;
  const accountProductCode = process.env[`${prefix}_ACCOUNT_PRODUCT_CODE`];
  const htsId = process.env[`${prefix}_HTS_ID`];
  return {
    appKey,
    appSecret,
    accountId,
    ...(accountProductCode ? { accountProductCode } : {}),
    ...(htsId ? { htsId } : {}),
  };
}

function derivativeCredentialsFromEnvironment(
  environment: TradingEnvironment,
): BrokerCredentials | null {
  const prefix = `KIS_DERIVATIVES_${environment === "live" ? "LIVE" : "PAPER"}`;
  const appKey = process.env[`${prefix}_APP_KEY`];
  const appSecret = process.env[`${prefix}_APP_SECRET`];
  const accountId = process.env[`${prefix}_ACCOUNT_ID`];
  if (!appKey || !appSecret || !accountId) return null;
  return validatedDerivativeCredentials({
    appKey,
    appSecret,
    accountId,
    accountProductCode: process.env[`${prefix}_ACCOUNT_PRODUCT_CODE`] ?? "03",
    ...(process.env[`${prefix}_HTS_ID`]
      ? { htsId: process.env[`${prefix}_HTS_ID`] }
      : {}),
  }, environment);
}

function validatedCredentials(
  value: unknown,
  brokerId: BrokerId,
  environment: TradingEnvironment,
): BrokerCredentials {
  if (!value || typeof value !== "object") {
    throw new Error(`Stored credentials are incomplete for ${brokerId}:${environment}`);
  }
  const parsed = value as Partial<BrokerCredentials>;
  if (
    typeof parsed.appKey !== "string" || parsed.appKey.length === 0 ||
    typeof parsed.appSecret !== "string" || parsed.appSecret.length === 0 ||
    typeof parsed.accountId !== "string" || parsed.accountId.length === 0
  ) {
    throw new Error(`Stored credentials are incomplete for ${brokerId}:${environment}`);
  }
  if (
    parsed.accountProductCode !== undefined &&
    typeof parsed.accountProductCode !== "string"
  ) {
    throw new Error(`Stored credentials are invalid for ${brokerId}:${environment}`);
  }
  if (parsed.htsId !== undefined && typeof parsed.htsId !== "string") {
    throw new Error(`Stored credentials are invalid for ${brokerId}:${environment}`);
  }
  return {
    appKey: parsed.appKey,
    appSecret: parsed.appSecret,
    accountId: parsed.accountId,
    ...(parsed.accountProductCode ? { accountProductCode: parsed.accountProductCode } : {}),
    ...(parsed.htsId ? { htsId: parsed.htsId } : {}),
  };
}

function validatedDerivativeCredentials(
  value: unknown,
  environment: TradingEnvironment,
): BrokerCredentials {
  const parsed = validatedCredentials(value, "koreainvestment", environment);
  if (!/^[0-9-]+$/.test(parsed.accountId)) {
    throw new Error(`Stored derivatives credentials are invalid for koreainvestment:${environment}`);
  }
  const compact = parsed.accountId.replaceAll("-", "");
  const cano = compact.length === 10 ? compact.slice(0, 8) : compact;
  const embeddedProductCode = compact.length === 10 ? compact.slice(8) : null;
  if (
    !/^\d{8}$/.test(cano) ||
    parsed.accountProductCode !== "03" ||
    (embeddedProductCode !== null && embeddedProductCode !== "03")
  ) {
    throw new Error(`Stored derivatives credentials are invalid for koreainvestment:${environment}`);
  }
  return {
    appKey: parsed.appKey,
    appSecret: parsed.appSecret,
    accountId: cano,
    accountProductCode: "03",
    ...(parsed.htsId?.trim() ? { htsId: parsed.htsId.trim() } : {}),
  };
}

type CredentialMap = Record<string, BrokerCredentials>;

function credentialMapKey(brokerId: BrokerId, environment: TradingEnvironment): string {
  return `${brokerId}:${environment}`;
}

function derivativeCredentialMapKey(environment: TradingEnvironment): string {
  return `derivatives:koreainvestment:${environment}`;
}

class EncryptedFileCredentialStore {
  readonly #filename: string;
  readonly #key: Buffer;
  #tail: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string, masterKey: string) {
    if (masterKey.trim().length < 32) {
      throw new Error("KSTOCK_MASTER_KEY must contain at least 32 characters");
    }
    this.#filename = path.join(path.resolve(dataDirectory), "broker-credentials.enc.json");
    this.#key = createHash("sha256").update(masterKey, "utf8").digest();
  }

  async get(
    brokerId: BrokerId,
    environment: TradingEnvironment,
  ): Promise<BrokerCredentials | null> {
    await this.#tail;
    const stored = (await this.#read())[credentialMapKey(brokerId, environment)];
    return stored ? validatedCredentials(stored, brokerId, environment) : null;
  }

  async set(
    brokerId: BrokerId,
    environment: TradingEnvironment,
    credentials: BrokerCredentials,
  ): Promise<void> {
    const stored = validatedCredentials(credentials, brokerId, environment);
    await this.#mutate((credentialsByScope) => {
      credentialsByScope[credentialMapKey(brokerId, environment)] = stored;
    });
  }

  async delete(brokerId: BrokerId, environment: TradingEnvironment): Promise<boolean> {
    let deleted = false;
    await this.#mutate((credentialsByScope) => {
      const key = credentialMapKey(brokerId, environment);
      deleted = Object.hasOwn(credentialsByScope, key);
      delete credentialsByScope[key];
    });
    return deleted;
  }

  async getDerivatives(environment: TradingEnvironment): Promise<BrokerCredentials | null> {
    await this.#tail;
    const stored = (await this.#read())[derivativeCredentialMapKey(environment)];
    return stored ? validatedDerivativeCredentials(stored, environment) : null;
  }

  async setDerivatives(
    environment: TradingEnvironment,
    credentials: BrokerCredentials,
  ): Promise<void> {
    const stored = validatedDerivativeCredentials(credentials, environment);
    await this.#mutate((credentialsByScope) => {
      credentialsByScope[derivativeCredentialMapKey(environment)] = stored;
    });
  }

  async deleteDerivatives(environment: TradingEnvironment): Promise<boolean> {
    let deleted = false;
    await this.#mutate((credentialsByScope) => {
      const key = derivativeCredentialMapKey(environment);
      deleted = Object.hasOwn(credentialsByScope, key);
      delete credentialsByScope[key];
    });
    return deleted;
  }

  async #mutate(change: (credentialsByScope: CredentialMap) => void): Promise<void> {
    const run = this.#tail.then(async () => {
      const credentialsByScope = await this.#read();
      change(credentialsByScope);
      await this.#write(credentialsByScope);
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #read(): Promise<CredentialMap> {
    try {
      const envelope = JSON.parse(await readFile(this.#filename, "utf8")) as Partial<{
        version: number;
        iv: string;
        tag: string;
        ciphertext: string;
      }>;
      if (
        envelope.version !== 1 ||
        typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" ||
        typeof envelope.ciphertext !== "string"
      ) {
        throw new Error("Invalid encrypted credential envelope");
      }
      const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const parsed = JSON.parse(plaintext) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid encrypted credential data");
      }
      return parsed as CredentialMap;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Encrypted credential store could not be read", { cause: error });
    }
  }

  async #write(credentialsByScope: CredentialMap): Promise<void> {
    await mkdir(path.dirname(this.#filename), { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credentialsByScope), "utf8"),
      cipher.final(),
    ]);
    const envelope = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
    const temporary = `${this.#filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let renamed = false;
    try {
      await writeFile(temporary, envelope, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.#filename);
      renamed = true;
      await chmod(this.#filename, 0o600);
    } finally {
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }
}

export class CredentialStore {
  readonly #encryptedStore: EncryptedFileCredentialStore | null;

  constructor(
    dataDirectory: string | undefined = process.env.KSTOCK_DATA_DIR,
    masterKey: string | undefined = process.env.KSTOCK_MASTER_KEY,
  ) {
    if (masterKey) {
      if (!dataDirectory) {
        throw new Error("KSTOCK_DATA_DIR is required when KSTOCK_MASTER_KEY is configured");
      }
      this.#encryptedStore = new EncryptedFileCredentialStore(dataDirectory, masterKey);
    } else {
      this.#encryptedStore = null;
    }
  }

  async save(
    brokerId: BrokerId,
    environment: TradingEnvironment,
    credentials: BrokerCredentials,
  ): Promise<void> {
    if (credentialsFromEnvironment(brokerId, environment)) {
      throw new Error(`Credentials for ${brokerId}:${environment} are managed by environment variables`);
    }
    if (this.#encryptedStore) {
      await this.#encryptedStore.set(brokerId, environment, credentials);
      return;
    }
    const entry = await keyringEntry(credentialEntryName(brokerId, environment));
    entry.setPassword(JSON.stringify(validatedCredentials(credentials, brokerId, environment)));
  }

  async get(
    brokerId: BrokerId,
    environment: TradingEnvironment,
  ): Promise<BrokerCredentials | null> {
    const fromEnvironment = credentialsFromEnvironment(brokerId, environment);
    if (fromEnvironment) return fromEnvironment;
    if (this.#encryptedStore) return this.#encryptedStore.get(brokerId, environment);
    const entry = await keyringEntry(credentialEntryName(brokerId, environment));
    const serialized = entry.getPassword();
    if (!serialized) return null;
    return validatedCredentials(JSON.parse(serialized) as unknown, brokerId, environment);
  }

  async delete(brokerId: BrokerId, environment: TradingEnvironment): Promise<boolean> {
    if (credentialsFromEnvironment(brokerId, environment)) return false;
    if (this.#encryptedStore) return this.#encryptedStore.delete(brokerId, environment);
    const entry = await keyringEntry(credentialEntryName(brokerId, environment));
    return entry.deletePassword();
  }

  async status(brokerId: BrokerId, environment: TradingEnvironment): Promise<{
    configured: boolean;
    source: "environment" | "encrypted-file" | "os-keychain" | null;
    maskedAccountId: string | null;
  }> {
    const fromEnvironment = credentialsFromEnvironment(brokerId, environment);
    if (fromEnvironment) {
      return {
        configured: true,
        source: "environment",
        maskedAccountId: maskAccount(fromEnvironment.accountId),
      };
    }
    const stored = await this.get(brokerId, environment);
    return stored
      ? {
          configured: true,
          source: this.#encryptedStore ? "encrypted-file" : "os-keychain",
          maskedAccountId: maskAccount(stored.accountId),
        }
      : { configured: false, source: null, maskedAccountId: null };
  }

  async saveDerivatives(
    environment: TradingEnvironment,
    credentials: BrokerCredentials,
  ): Promise<void> {
    if (derivativeCredentialsFromEnvironment(environment)) {
      throw new Error(
        `Derivatives credentials for koreainvestment:${environment} are managed by environment variables`,
      );
    }
    const stored = validatedDerivativeCredentials(credentials, environment);
    if (this.#encryptedStore) {
      await this.#encryptedStore.setDerivatives(environment, stored);
      return;
    }
    const entry = await keyringEntry(derivativeCredentialEntryName(environment));
    entry.setPassword(JSON.stringify(stored));
  }

  async getDerivatives(
    environment: TradingEnvironment,
  ): Promise<BrokerCredentials | null> {
    const fromEnvironment = derivativeCredentialsFromEnvironment(environment);
    if (fromEnvironment) return fromEnvironment;
    if (this.#encryptedStore) return this.#encryptedStore.getDerivatives(environment);
    const entry = await keyringEntry(derivativeCredentialEntryName(environment));
    const serialized = entry.getPassword();
    if (!serialized) return null;
    return validatedDerivativeCredentials(JSON.parse(serialized) as unknown, environment);
  }

  async deleteDerivatives(environment: TradingEnvironment): Promise<boolean> {
    if (derivativeCredentialsFromEnvironment(environment)) return false;
    if (this.#encryptedStore) return this.#encryptedStore.deleteDerivatives(environment);
    const entry = await keyringEntry(derivativeCredentialEntryName(environment));
    return entry.deletePassword();
  }

  async statusDerivatives(environment: TradingEnvironment): Promise<{
    configured: boolean;
    source: "environment" | "encrypted-file" | "os-keychain" | null;
    maskedAccountId: string | null;
    accountProductCode: "03";
  }> {
    const fromEnvironment = derivativeCredentialsFromEnvironment(environment);
    if (fromEnvironment) {
      return {
        configured: true,
        source: "environment",
        maskedAccountId: maskAccount(fromEnvironment.accountId),
        accountProductCode: "03",
      };
    }
    const stored = await this.getDerivatives(environment);
    return stored
      ? {
          configured: true,
          source: this.#encryptedStore ? "encrypted-file" : "os-keychain",
          maskedAccountId: maskAccount(stored.accountId),
          accountProductCode: "03",
        }
      : {
          configured: false,
          source: null,
          maskedAccountId: null,
          accountProductCode: "03",
        };
  }
}

export class KeyringTokenStore implements TokenStore {
  async get(scope: AccountScope): Promise<CachedAccessToken | null> {
    const entry = await keyringEntry(tokenEntryName(scope));
    const serialized = entry.getPassword();
    if (!serialized) return null;
    const parsed = JSON.parse(serialized) as Partial<CachedAccessToken>;
    if (!parsed.token || !parsed.expiresAt) return null;
    return parsed.tokenType
      ? { token: parsed.token, expiresAt: parsed.expiresAt, tokenType: parsed.tokenType }
      : { token: parsed.token, expiresAt: parsed.expiresAt };
  }

  async set(scope: AccountScope, token: CachedAccessToken): Promise<void> {
    const entry = await keyringEntry(tokenEntryName(scope));
    entry.setPassword(JSON.stringify(token));
  }

  async delete(scope: AccountScope): Promise<void> {
    const entry = await keyringEntry(tokenEntryName(scope));
    entry.deletePassword();
  }
}

type TokenMap = Record<string, CachedAccessToken>;

const encryptedTokenFileTails = new Map<string, Promise<void>>();

function serializeEncryptedTokenFileAccess<T>(
  filename: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = encryptedTokenFileTails.get(filename) ?? Promise.resolve();
  const run = previous.then(operation);
  const tail = run.then(() => undefined, () => undefined);
  encryptedTokenFileTails.set(filename, tail);
  void tail.then(() => {
    if (encryptedTokenFileTails.get(filename) === tail) {
      encryptedTokenFileTails.delete(filename);
    }
  });
  return run;
}

function scopeTokenKey(scope: AccountScope): string {
  return `${scope.brokerId}:${scope.environment}:${scope.accountId}`;
}

export class EncryptedFileTokenStore implements TokenStore {
  readonly #filename: string;
  readonly #key: Buffer;

  constructor(dataDirectory: string, masterKey: string) {
    if (masterKey.trim().length < 32) {
      throw new Error("KSTOCK_MASTER_KEY must contain at least 32 characters");
    }
    this.#filename = path.join(path.resolve(dataDirectory), "token-cache.enc.json");
    this.#key = createHash("sha256").update(masterKey, "utf8").digest();
  }

  async get(scope: AccountScope): Promise<CachedAccessToken | null> {
    return serializeEncryptedTokenFileAccess(
      this.#filename,
      async () => (await this.#read())[scopeTokenKey(scope)] ?? null,
    );
  }

  async set(scope: AccountScope, token: CachedAccessToken): Promise<void> {
    await this.#mutate((tokens) => { tokens[scopeTokenKey(scope)] = token; });
  }

  async delete(scope: AccountScope): Promise<void> {
    await this.#mutate((tokens) => { delete tokens[scopeTokenKey(scope)]; });
  }

  async #mutate(change: (tokens: TokenMap) => void): Promise<void> {
    return serializeEncryptedTokenFileAccess(this.#filename, async () => {
      const tokens = await this.#read();
      change(tokens);
      await this.#write(tokens);
    });
  }

  async #read(): Promise<TokenMap> {
    try {
      const envelope = JSON.parse(await readFile(this.#filename, "utf8")) as {
        iv: string;
        tag: string;
        ciphertext: string;
      };
      const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plaintext) as TokenMap;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Encrypted token cache could not be read", { cause: error });
    }
  }

  async #write(tokens: TokenMap): Promise<void> {
    await mkdir(path.dirname(this.#filename), { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
    const envelope = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
    const temporary = `${this.#filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let renamed = false;
    try {
      await writeFile(temporary, envelope, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.#filename);
      renamed = true;
      await chmod(this.#filename, 0o600);
    } finally {
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }
}

export function createTokenStore(dataDirectory: string): TokenStore {
  const masterKey = process.env.KSTOCK_MASTER_KEY;
  return masterKey ? new EncryptedFileTokenStore(dataDirectory, masterKey) : new KeyringTokenStore();
}
