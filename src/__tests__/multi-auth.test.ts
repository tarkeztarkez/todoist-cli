import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/auth.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/auth.js')>()
    return {
        ...actual,
        listAccounts: vi.fn(),
        removeAccount: vi.fn(),
        saveApiToken: vi.fn(),
        setDefaultAccount: vi.fn(),
    }
})

vi.mock('chalk')

import { registerMultiAuthCommand } from '../commands/multi-auth.js'
import { listAccounts, removeAccount, saveApiToken, setDefaultAccount } from '../lib/auth.js'

const mockListAccounts = vi.mocked(listAccounts)
const mockRemoveAccount = vi.mocked(removeAccount)
const mockSaveApiToken = vi.mocked(saveApiToken)
const mockSetDefaultAccount = vi.mocked(setDefaultAccount)

function createProgram() {
    const program = new Command()
    program.exitOverride()
    registerMultiAuthCommand(program)
    return program
}

describe('multi-auth command', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>
    let errorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.clearAllMocks()
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        consoleSpy.mockRestore()
        errorSpy.mockRestore()
    })

    it('adds an account without forcing it to become default', async () => {
        const program = createProgram()
        mockSaveApiToken.mockResolvedValue({
            storage: 'secure-store',
            account: 'work@example.com',
        })

        await program.parseAsync([
            'node',
            'td',
            'multi-auth',
            'add',
            'work@example.com',
            'token-123456789',
        ])

        expect(mockSaveApiToken).toHaveBeenCalledWith('token-123456789', {
            account: 'work@example.com',
            setAsDefault: 'if-unset',
        })
        expect(consoleSpy).toHaveBeenCalledWith('✓', 'Stored account work@example.com')
    })

    it('lists stored accounts', async () => {
        const program = createProgram()
        mockListAccounts.mockResolvedValue([
            { email: 'personal@example.com', isDefault: true, hasStoredToken: true },
            { email: 'work@example.com', isDefault: false, hasStoredToken: true },
        ])

        await program.parseAsync(['node', 'td', 'multi-auth', 'list'])

        expect(consoleSpy).toHaveBeenCalledWith('personal@example.com (default)')
        expect(consoleSpy).toHaveBeenCalledWith('work@example.com')
    })

    it('removes an account', async () => {
        const program = createProgram()
        mockRemoveAccount.mockResolvedValue({
            storage: 'secure-store',
            account: 'work@example.com',
        })

        await program.parseAsync(['node', 'td', 'multi-auth', 'remove', 'work@example.com'])

        expect(mockRemoveAccount).toHaveBeenCalledWith('work@example.com')
        expect(consoleSpy).toHaveBeenCalledWith('✓', 'Removed account work@example.com')
    })

    it('sets the default account', async () => {
        const program = createProgram()

        await program.parseAsync(['node', 'td', 'multi-auth', 'default', 'work@example.com'])

        expect(mockSetDefaultAccount).toHaveBeenCalledWith('work@example.com')
        expect(consoleSpy).toHaveBeenCalledWith('✓', 'Default account set to work@example.com')
    })
})
