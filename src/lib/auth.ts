import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { TodoistApi } from '@doist/todoist-api-typescript'
import {
    createSecureStore,
    SecureStoreUnavailableError,
    SECURE_STORE_DESCRIPTION,
} from './secure-store.js'

export const CONFIG_PATH = join(homedir(), '.config', 'todoist-cli', 'config.json')
export const TOKEN_ENV_VAR = 'TODOIST_API_TOKEN'

const LEGACY_SECURE_STORE_ACCOUNT = 'api-token'

let activeAccountEmail: string | null = null

export class NoTokenError extends Error {
    constructor() {
        super(
            `No API token found. Set ${TOKEN_ENV_VAR}, run \`td auth login\`, or run \`td multi-auth add <email> <token>\`.`,
        )
        this.name = 'NoTokenError'
    }
}

export type TokenStorageLocation = 'secure-store' | 'config-file'

export interface TokenStorageResult {
    storage: TokenStorageLocation
    warning?: string
}

export interface AccountInfo {
    email: string
    isDefault: boolean
    hasStoredToken: boolean
}

interface AccountConfig extends Record<string, unknown> {
    email: string
    api_token?: string
    pendingSecureStoreClear?: boolean
}

interface Config extends Record<string, unknown> {
    api_token?: string
    pendingSecureStoreClear?: boolean
    defaultAccount?: string
    accounts?: Record<string, AccountConfig>
}

interface SaveApiTokenOptions {
    account?: string
    setAsDefault?: boolean | 'if-unset'
}

interface ClearApiTokenOptions {
    account?: string
}

export function setActiveAccount(email?: string): void {
    activeAccountEmail = email ? normalizeAccountEmail(email) : null
}

export function getActiveAccount(): string | null {
    return activeAccountEmail
}

export async function getApiToken(accountOverride?: string): Promise<string> {
    const config = await readConfig()
    const explicitAccount = normalizeOptionalAccountEmail(accountOverride) ?? activeAccountEmail
    const selectedAccount = explicitAccount ?? normalizeOptionalAccountEmail(config.defaultAccount)
    const envToken = process.env[TOKEN_ENV_VAR]?.trim()

    if (envToken) {
        if (explicitAccount) {
            throw new Error(`Cannot use --account with ${TOKEN_ENV_VAR}`)
        }
        return envToken
    }

    if (selectedAccount) {
        return getAccountApiToken(config, selectedAccount)
    }

    return getLegacyApiToken(config)
}

export async function saveApiToken(
    token: string,
    options: SaveApiTokenOptions = {},
): Promise<TokenStorageResult & { account: string }> {
    if (!token || token.trim().length < 10) {
        throw new Error('Invalid token: Token must be at least 10 characters')
    }

    const trimmedToken = token.trim()
    const accountEmail = normalizeAccountEmail(
        options.account ?? (await resolveAccountEmailForToken(trimmedToken)),
    )
    const config = await readConfig()
    const account = getOrCreateAccountConfig(config, accountEmail)
    const secureStore = createSecureStore(getSecureStoreAccountName(accountEmail))

    try {
        await secureStore.setSecret(trimmedToken)
        account.email = accountEmail
        const warning = await cleanupAccountFallbackState(
            config,
            accountEmail,
            'Token was stored securely,',
        )
        if (shouldSetDefaultAccount(config, accountEmail, options.setAsDefault)) {
            config.defaultAccount = accountEmail
            await writeConfig(config)
        }
        return warning
            ? { storage: 'secure-store', warning, account: accountEmail }
            : { storage: 'secure-store', account: accountEmail }
    } catch (error) {
        if (!(error instanceof SecureStoreUnavailableError)) {
            throw error
        }
    }

    account.email = accountEmail
    account.api_token = trimmedToken
    delete account.pendingSecureStoreClear
    if (shouldSetDefaultAccount(config, accountEmail, options.setAsDefault)) {
        config.defaultAccount = accountEmail
    }
    await writeConfig(config)
    return {
        storage: 'config-file',
        warning: buildFallbackWarning('token saved as plaintext in', accountEmail),
        account: accountEmail,
    }
}

export async function clearApiToken(
    options: ClearApiTokenOptions = {},
): Promise<TokenStorageResult & { account?: string }> {
    const config = await readConfig()
    const selectedAccount = resolveSelectedAccount(config, options.account)

    if (selectedAccount) {
        return clearAccountApiToken(config, selectedAccount)
    }

    return clearLegacyApiToken(config)
}

export async function listAccounts(): Promise<AccountInfo[]> {
    const config = await readConfig()
    return getAccountEntries(config).map((account) => ({
        email: account.email,
        isDefault:
            normalizeOptionalAccountEmail(config.defaultAccount) ===
            normalizeAccountEmail(account.email),
        hasStoredToken: hasAccountStoredToken(account),
    }))
}

export async function setDefaultAccount(email: string): Promise<void> {
    const accountEmail = normalizeAccountEmail(email)
    const config = await readConfig()
    const account = getAccountConfig(config, accountEmail)
    if (!account || !hasAccountStoredToken(account)) {
        throw new Error(`No stored account found for ${accountEmail}`)
    }
    config.defaultAccount = accountEmail
    await writeConfig(config)
}

export async function removeAccount(
    email: string,
): Promise<TokenStorageResult & { account: string }> {
    const accountEmail = normalizeAccountEmail(email)
    const config = await readConfig()
    const account = getAccountConfig(config, accountEmail)
    if (!account) {
        throw new Error(`No stored account found for ${accountEmail}`)
    }

    const secureStore = createSecureStore(getSecureStoreAccountName(accountEmail))
    try {
        await secureStore.deleteSecret()
        deleteAccount(config, accountEmail)
        await writeConfig(config)
        return { storage: 'secure-store', account: accountEmail }
    } catch (error) {
        if (!(error instanceof SecureStoreUnavailableError)) {
            throw error
        }
    }

    if (!account.api_token && !account.pendingSecureStoreClear) {
        throw new Error(
            `${SECURE_STORE_DESCRIPTION} unavailable; cannot remove ${accountEmail} because its token is stored only in secure storage`,
        )
    }

    delete account.api_token
    account.pendingSecureStoreClear = true
    await writeConfig(config)
    return {
        storage: 'config-file',
        warning: buildFallbackWarning('local auth state cleared in', accountEmail),
        account: accountEmail,
    }
}

async function getAccountApiToken(config: Config, accountEmail: string): Promise<string> {
    const account = getAccountConfig(config, accountEmail)
    if (!account) {
        throw new NoTokenError()
    }

    const configToken = getAccountConfigToken(account)
    const secureStore = createSecureStore(getSecureStoreAccountName(accountEmail))

    if (configToken) {
        try {
            await secureStore.setSecret(configToken)
            const cleanupWarning = await cleanupAccountFallbackState(
                config,
                accountEmail,
                'Token was migrated to secure storage,',
            )
            if (cleanupWarning) {
                warn(cleanupWarning)
            }
        } catch (error) {
            if (error instanceof SecureStoreUnavailableError) {
                warnSecureStoreFallback('using plaintext token from', accountEmail)
            } else {
                throw error
            }
        }

        return configToken
    }

    if (account.pendingSecureStoreClear) {
        try {
            await secureStore.deleteSecret()
            const cleanupWarning = await cleanupAccountFallbackState(
                config,
                accountEmail,
                'Secure-store token was removed,',
            )
            if (cleanupWarning) {
                warn(cleanupWarning)
            }
        } catch (error) {
            if (!(error instanceof SecureStoreUnavailableError)) {
                throw error
            }
        }

        throw new NoTokenError()
    }

    try {
        const storedToken = await secureStore.getSecret()
        if (storedToken?.trim()) {
            return storedToken.trim()
        }
    } catch (error) {
        if (error instanceof SecureStoreUnavailableError) {
            warnSecureStoreFallback('using plaintext token from', accountEmail)
        } else {
            throw error
        }
    }

    throw new NoTokenError()
}

async function getLegacyApiToken(config: Config): Promise<string> {
    const configToken = getLegacyConfigToken(config)
    const secureStore = createSecureStore()

    if (configToken) {
        try {
            await secureStore.setSecret(configToken)
            const cleanupWarning = await cleanupLegacyFallbackState(
                config,
                'Token was migrated to secure storage,',
            )
            if (cleanupWarning) {
                warn(cleanupWarning)
            }
        } catch (error) {
            if (error instanceof SecureStoreUnavailableError) {
                warnSecureStoreFallback('using plaintext token from')
            } else {
                throw error
            }
        }

        return configToken
    }

    if (config.pendingSecureStoreClear) {
        try {
            await secureStore.deleteSecret()
            const cleanupWarning = await cleanupLegacyFallbackState(
                config,
                'Secure-store token was removed,',
            )
            if (cleanupWarning) {
                warn(cleanupWarning)
            }
        } catch (error) {
            if (!(error instanceof SecureStoreUnavailableError)) {
                throw error
            }
        }

        throw new NoTokenError()
    }

    try {
        const storedToken = await secureStore.getSecret()
        if (storedToken?.trim()) {
            return storedToken.trim()
        }
    } catch (error) {
        if (error instanceof SecureStoreUnavailableError) {
            warnSecureStoreFallback('using plaintext token from')
        } else {
            throw error
        }
    }

    throw new NoTokenError()
}

async function clearAccountApiToken(
    config: Config,
    accountEmail: string,
): Promise<TokenStorageResult & { account: string }> {
    const account = getAccountConfig(config, accountEmail)
    if (!account) {
        throw new Error(`No stored account found for ${accountEmail}`)
    }

    const secureStore = createSecureStore(getSecureStoreAccountName(accountEmail))
    try {
        await secureStore.deleteSecret()
        deleteAccount(config, accountEmail)
        await writeConfig(config)
        return { storage: 'secure-store', account: accountEmail }
    } catch (error) {
        if (!(error instanceof SecureStoreUnavailableError)) {
            throw error
        }
    }

    account.pendingSecureStoreClear = true
    delete account.api_token
    await writeConfig(config)
    return {
        storage: 'config-file',
        warning: buildFallbackWarning('local auth state cleared in', accountEmail),
        account: accountEmail,
    }
}

async function clearLegacyApiToken(config: Config): Promise<TokenStorageResult> {
    const secureStore = createSecureStore()

    try {
        await secureStore.deleteSecret()
        const warning = await cleanupLegacyFallbackState(config, 'Secure-store token was removed,')
        return warning ? { storage: 'secure-store', warning } : { storage: 'secure-store' }
    } catch (error) {
        if (!(error instanceof SecureStoreUnavailableError)) {
            throw error
        }
    }

    await writeConfig(withPendingLegacySecureStoreClear(config))
    return {
        storage: 'config-file',
        warning: buildFallbackWarning('local auth state cleared in'),
    }
}

async function resolveAccountEmailForToken(token: string): Promise<string> {
    const api = new TodoistApi(token)
    const user = await api.getUser()
    return normalizeAccountEmail(user.email)
}

function normalizeAccountEmail(email: string | undefined | null): string {
    if (!email || !email.trim()) {
        throw new Error('Account email is required')
    }
    return email.trim().toLowerCase()
}

function resolveSelectedAccount(config: Config, accountOverride?: string): string | null {
    const explicitAccount = normalizeOptionalAccountEmail(accountOverride) ?? activeAccountEmail
    if (explicitAccount) {
        return explicitAccount
    }

    const defaultAccount = normalizeOptionalAccountEmail(config.defaultAccount)
    return defaultAccount ?? null
}

function normalizeOptionalAccountEmail(email: string | undefined | null): string | null {
    return typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null
}

function shouldSetDefaultAccount(
    config: Config,
    accountEmail: string,
    setAsDefault: boolean | 'if-unset' | undefined,
): boolean {
    if (setAsDefault === true) {
        return true
    }

    if (setAsDefault === false) {
        return false
    }

    return (
        normalizeOptionalAccountEmail(config.defaultAccount) === null ||
        config.defaultAccount === accountEmail
    )
}

function getSecureStoreAccountName(accountEmail: string): string {
    return `${LEGACY_SECURE_STORE_ACCOUNT}:${normalizeAccountEmail(accountEmail)}`
}

async function readConfig(): Promise<Config> {
    try {
        const content = await readFile(CONFIG_PATH, 'utf-8')
        const parsed = JSON.parse(content)
        if (!isObject(parsed)) {
            return {}
        }

        const config = parsed as Config
        return {
            ...config,
            accounts: sanitizeAccounts(config.accounts),
            defaultAccount: normalizeOptionalAccountEmail(config.defaultAccount) ?? undefined,
        }
    } catch {
        return {}
    }
}

async function writeConfig(config: Config): Promise<void> {
    const sanitized = sanitizeConfig(config)

    if (Object.keys(sanitized).length === 0) {
        try {
            await unlink(CONFIG_PATH)
        } catch (error) {
            if (!isMissingFileError(error)) {
                throw error
            }
        }
        return
    }

    await mkdir(dirname(CONFIG_PATH), { recursive: true })
    await writeFile(CONFIG_PATH, `${JSON.stringify(sanitized, null, 2)}\n`)
}

async function cleanupAccountFallbackState(
    config: Config,
    accountEmail: string,
    warningPrefix: string,
): Promise<string | undefined> {
    try {
        const account = getAccountConfig(config, accountEmail)
        if (account) {
            delete account.api_token
            delete account.pendingSecureStoreClear
        }
        await writeConfig(config)
        return undefined
    } catch (error) {
        return buildConfigCleanupWarning(warningPrefix, error)
    }
}

async function cleanupLegacyFallbackState(
    config: Config,
    warningPrefix: string,
): Promise<string | undefined> {
    try {
        await writeConfig(withoutLegacyFallbackState(config))
        return undefined
    } catch (error) {
        return buildConfigCleanupWarning(warningPrefix, error)
    }
}

function getLegacyConfigToken(config: Config): string | null {
    return typeof config.api_token === 'string' && config.api_token.trim()
        ? config.api_token.trim()
        : null
}

function getAccountConfigToken(account: AccountConfig): string | null {
    return typeof account.api_token === 'string' && account.api_token.trim()
        ? account.api_token.trim()
        : null
}

function getOrCreateAccountConfig(config: Config, accountEmail: string): AccountConfig {
    if (!config.accounts) {
        config.accounts = {}
    }

    const key = normalizeAccountEmail(accountEmail)
    const existing = getAccountConfig(config, key)
    if (existing) {
        existing.email = key
        return existing
    }

    const created: AccountConfig = { email: key }
    config.accounts[key] = created
    return created
}

function getAccountConfig(config: Config, accountEmail: string): AccountConfig | undefined {
    return config.accounts?.[normalizeAccountEmail(accountEmail)]
}

function getAccountEntries(config: Config): AccountConfig[] {
    return Object.values(config.accounts ?? {}).sort((a, b) => a.email.localeCompare(b.email))
}

function hasAccountStoredToken(account: AccountConfig): boolean {
    return Boolean(account.email)
}

function deleteAccount(config: Config, accountEmail: string): void {
    const key = normalizeAccountEmail(accountEmail)
    if (config.accounts) {
        delete config.accounts[key]
        if (Object.keys(config.accounts).length === 0) {
            delete config.accounts
        }
    }

    if (normalizeOptionalAccountEmail(config.defaultAccount) === key) {
        delete config.defaultAccount
    }
}

function sanitizeAccounts(accounts: unknown): Record<string, AccountConfig> | undefined {
    if (!isObject(accounts)) {
        return undefined
    }

    const normalizedEntries = Object.entries(accounts)
        .map(([key, value]) => {
            if (!isObject(value)) {
                return null
            }

            const email =
                normalizeOptionalAccountEmail(
                    typeof value.email === 'string' ? value.email : key,
                ) ?? normalizeOptionalAccountEmail(key)

            if (!email) {
                return null
            }

            const account: AccountConfig = { email }
            if (typeof value.api_token === 'string' && value.api_token.trim()) {
                account.api_token = value.api_token.trim()
            }
            if (value.pendingSecureStoreClear === true) {
                account.pendingSecureStoreClear = true
            }
            return [email, account] satisfies [string, AccountConfig]
        })
        .filter((entry): entry is [string, AccountConfig] => entry !== null)

    return normalizedEntries.length > 0 ? Object.fromEntries(normalizedEntries) : undefined
}

function sanitizeConfig(config: Config): Config {
    const sanitized: Config = {}

    if (typeof config.api_token === 'string' && config.api_token.trim()) {
        sanitized.api_token = config.api_token.trim()
    }
    if (config.pendingSecureStoreClear === true) {
        sanitized.pendingSecureStoreClear = true
    }

    const accounts = sanitizeAccounts(config.accounts)
    if (accounts) {
        sanitized.accounts = accounts
    }

    const defaultAccount = normalizeOptionalAccountEmail(config.defaultAccount)
    if (defaultAccount && accounts?.[defaultAccount]) {
        sanitized.defaultAccount = defaultAccount
    }

    for (const [key, value] of Object.entries(config)) {
        if (!(key in sanitized) && key !== 'accounts' && key !== 'defaultAccount') {
            sanitized[key] = value
        }
    }

    return sanitized
}

function withoutLegacyFallbackState(config: Config): Config {
    const { api_token: _token, pendingSecureStoreClear: _pending, ...rest } = config
    return rest
}

function withPendingLegacySecureStoreClear(config: Config): Config {
    return { ...withoutLegacyFallbackState(config), pendingSecureStoreClear: true }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function buildFallbackWarning(action: string, accountEmail?: string): string {
    const suffix = accountEmail ? ` for ${accountEmail}` : ''
    return `${SECURE_STORE_DESCRIPTION} unavailable; ${action} ${CONFIG_PATH}${suffix}`
}

function buildConfigCleanupWarning(prefix: string, error: unknown): string {
    const detail = error instanceof Error && error.message ? ` (${error.message})` : ''
    return `${prefix} but could not remove legacy plaintext token from ${CONFIG_PATH}${detail}`
}

function warn(message: string): void {
    console.error(`Warning: ${message}`)
}

function warnSecureStoreFallback(action: string, accountEmail?: string): void {
    warn(buildFallbackWarning(action, accountEmail))
}
