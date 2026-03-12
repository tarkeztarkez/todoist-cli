import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_HOME = '/tmp/todoist-cli-tests'
const TEST_CONFIG_PATH = `${TEST_HOME}/.config/todoist-cli/config.json`

interface KeyringState {
    tokens: Map<string, string>
    getError?: Error
    setError?: Error
    deleteError?: Error
    getCalls: number
    entries: Array<{ service: string; account: string }>
    setCalls: Array<{ account: string; password: string }>
    deleteCalls: string[]
}

describe('lib/auth', () => {
    let configContent: string | null
    let configUnlinkError: Error | null
    let configWriteError: Error | null
    let mkdirMock: ReturnType<typeof vi.fn>
    let readFileMock: ReturnType<typeof vi.fn>
    let unlinkMock: ReturnType<typeof vi.fn>
    let writeFileMock: ReturnType<typeof vi.fn>
    let keyringState: KeyringState
    let errorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        vi.unstubAllEnvs()

        configContent = null
        configUnlinkError = null
        configWriteError = null
        keyringState = {
            tokens: new Map(),
            getCalls: 0,
            entries: [],
            setCalls: [],
            deleteCalls: [],
        }

        mkdirMock = vi.fn().mockResolvedValue(undefined)
        readFileMock = vi.fn().mockImplementation(async () => {
            if (configContent === null) {
                throw createErrnoError('ENOENT')
            }
            return configContent
        })
        unlinkMock = vi.fn().mockImplementation(async () => {
            if (configUnlinkError) {
                throw configUnlinkError
            }
            if (configContent === null) {
                throw createErrnoError('ENOENT')
            }
            configContent = null
        })
        writeFileMock = vi.fn().mockImplementation(async (_path: string, content: string) => {
            if (configWriteError) {
                throw configWriteError
            }
            configContent = content
        })

        vi.doMock('node:os', () => ({
            homedir: () => TEST_HOME,
        }))

        vi.doMock('node:fs/promises', () => ({
            mkdir: mkdirMock,
            readFile: readFileMock,
            unlink: unlinkMock,
            writeFile: writeFileMock,
        }))

        vi.doMock('@napi-rs/keyring', () => ({
            AsyncEntry: class {
                private readonly account: string

                constructor(service: string, account: string) {
                    this.account = account
                    keyringState.entries.push({ service, account })
                }

                async getPassword(): Promise<string | null> {
                    keyringState.getCalls += 1
                    if (keyringState.getError) {
                        throw keyringState.getError
                    }
                    return keyringState.tokens.get(this.account) ?? null
                }

                async setPassword(password: string): Promise<void> {
                    if (keyringState.setError) {
                        throw keyringState.setError
                    }
                    keyringState.tokens.set(this.account, password)
                    keyringState.setCalls.push({ account: this.account, password })
                }

                async deleteCredential(): Promise<boolean> {
                    if (keyringState.deleteError) {
                        throw keyringState.deleteError
                    }
                    const hadCredential = keyringState.tokens.has(this.account)
                    keyringState.tokens.delete(this.account)
                    keyringState.deleteCalls.push(this.account)
                    return hadCredential
                }
            },
        }))

        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        errorSpy.mockRestore()
        vi.unstubAllEnvs()
    })

    it('prefers TODOIST_API_TOKEN when no account is selected', async () => {
        vi.stubEnv('TODOIST_API_TOKEN', 'env-token-123456')
        setConfig({
            defaultAccount: 'work@example.com',
            accounts: { 'work@example.com': { email: 'work@example.com' } },
        })

        const { getApiToken, setActiveAccount } = await import('../lib/auth.js')
        setActiveAccount()

        await expect(getApiToken()).resolves.toBe('env-token-123456')
    })

    it('rejects combining TODOIST_API_TOKEN with a selected account', async () => {
        vi.stubEnv('TODOIST_API_TOKEN', 'env-token-123456')
        setConfig({
            defaultAccount: 'work@example.com',
            accounts: { 'work@example.com': { email: 'work@example.com' } },
        })

        const { getApiToken, setActiveAccount } = await import('../lib/auth.js')
        setActiveAccount('work@example.com')

        await expect(getApiToken()).rejects.toThrow('Cannot use --account with TODOIST_API_TOKEN')
    })

    it('saves account tokens to account-specific secure-store keys and sets the default account', async () => {
        const { saveApiToken, listAccounts } = await import('../lib/auth.js')

        await expect(
            saveApiToken('secure-token-123456', {
                account: 'Work@Example.com',
                setAsDefault: true,
            }),
        ).resolves.toEqual({
            storage: 'secure-store',
            account: 'work@example.com',
        })

        expect(keyringState.tokens.get('api-token:work@example.com')).toBe('secure-token-123456')
        expect(readConfig()).toEqual({
            defaultAccount: 'work@example.com',
            accounts: {
                'work@example.com': {
                    email: 'work@example.com',
                },
            },
        })
        await expect(listAccounts()).resolves.toEqual([
            {
                email: 'work@example.com',
                isDefault: true,
                hasStoredToken: true,
            },
        ])
    })

    it('reads tokens for the default account from secure storage', async () => {
        keyringState.tokens.set('api-token:work@example.com', 'secure-token-abcdef')
        setConfig({
            defaultAccount: 'work@example.com',
            accounts: {
                'work@example.com': { email: 'work@example.com' },
            },
        })

        const { getApiToken } = await import('../lib/auth.js')

        await expect(getApiToken()).resolves.toBe('secure-token-abcdef')
    })

    it('uses the explicitly selected account for token lookup', async () => {
        keyringState.tokens.set('api-token:work@example.com', 'work-token')
        keyringState.tokens.set('api-token:personal@example.com', 'personal-token')
        setConfig({
            defaultAccount: 'personal@example.com',
            accounts: {
                'work@example.com': { email: 'work@example.com' },
                'personal@example.com': { email: 'personal@example.com' },
            },
        })

        const { getApiToken, setActiveAccount } = await import('../lib/auth.js')
        setActiveAccount('work@example.com')

        await expect(getApiToken()).resolves.toBe('work-token')
    })

    it('falls back to plaintext config for account-scoped tokens when secure storage is unavailable', async () => {
        keyringState.setError = new Error('Keychain unavailable')
        keyringState.getError = new Error('Keychain unavailable')

        const { getApiToken, saveApiToken } = await import('../lib/auth.js')

        await expect(
            saveApiToken('fallback-token-123456', {
                account: 'work@example.com',
                setAsDefault: true,
            }),
        ).resolves.toEqual({
            storage: 'config-file',
            warning: `system credential manager unavailable; token saved as plaintext in ${TEST_CONFIG_PATH} for work@example.com`,
            account: 'work@example.com',
        })
        expect(readConfig()).toEqual({
            defaultAccount: 'work@example.com',
            accounts: {
                'work@example.com': {
                    email: 'work@example.com',
                    api_token: 'fallback-token-123456',
                },
            },
        })

        await expect(getApiToken()).resolves.toBe('fallback-token-123456')
        expect(errorSpy).toHaveBeenCalledWith(
            `Warning: system credential manager unavailable; using plaintext token from ${TEST_CONFIG_PATH} for work@example.com`,
        )
    })

    it('marks an account pending clear when secure-store removal is unavailable', async () => {
        keyringState.deleteError = new Error('Keychain unavailable')
        setConfig({
            defaultAccount: 'work@example.com',
            accounts: {
                'work@example.com': {
                    email: 'work@example.com',
                    api_token: 'fallback-token-123456',
                },
            },
        })

        const { clearApiToken, setActiveAccount } = await import('../lib/auth.js')
        setActiveAccount('work@example.com')

        await expect(clearApiToken()).resolves.toEqual({
            storage: 'config-file',
            warning: `system credential manager unavailable; local auth state cleared in ${TEST_CONFIG_PATH} for work@example.com`,
            account: 'work@example.com',
        })
        expect(readConfig()).toEqual({
            defaultAccount: 'work@example.com',
            accounts: {
                'work@example.com': {
                    email: 'work@example.com',
                    pendingSecureStoreClear: true,
                },
            },
        })
    })

    it('removes stored accounts and clears the default when deleting them', async () => {
        keyringState.tokens.set('api-token:work@example.com', 'secure-token-123456')
        setConfig({
            defaultAccount: 'work@example.com',
            accounts: {
                'work@example.com': { email: 'work@example.com' },
                'personal@example.com': { email: 'personal@example.com' },
            },
        })

        const { removeAccount } = await import('../lib/auth.js')

        await expect(removeAccount('work@example.com')).resolves.toEqual({
            storage: 'secure-store',
            account: 'work@example.com',
        })
        expect(readConfig()).toEqual({
            accounts: {
                'personal@example.com': {
                    email: 'personal@example.com',
                },
            },
        })
    })

    it('updates the default account explicitly', async () => {
        setConfig({
            defaultAccount: 'personal@example.com',
            accounts: {
                'work@example.com': { email: 'work@example.com' },
                'personal@example.com': { email: 'personal@example.com' },
            },
        })

        const { setDefaultAccount } = await import('../lib/auth.js')

        await setDefaultAccount('work@example.com')

        expect(readConfig()).toEqual({
            defaultAccount: 'work@example.com',
            accounts: {
                'work@example.com': { email: 'work@example.com' },
                'personal@example.com': { email: 'personal@example.com' },
            },
        })
    })

    it('preserves legacy single-account token lookup and migration', async () => {
        setConfig({
            api_token: 'legacy-token-123456',
            currentWorkspace: 'team-1',
        })

        const { getApiToken } = await import('../lib/auth.js')

        await expect(getApiToken()).resolves.toBe('legacy-token-123456')
        expect(keyringState.tokens.get('api-token')).toBe('legacy-token-123456')
        expect(readConfig()).toEqual({
            currentWorkspace: 'team-1',
        })
    })

    function setConfig(config: Record<string, unknown>): void {
        configContent = `${JSON.stringify(config, null, 2)}\n`
    }

    function readConfig(): Record<string, unknown> | null {
        return configContent ? (JSON.parse(configContent) as Record<string, unknown>) : null
    }

    function createErrnoError(code: string): Error & { code: string } {
        const error = new Error(code) as Error & { code: string }
        error.code = code
        return error
    }
})
