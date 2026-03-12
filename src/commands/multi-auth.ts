import chalk from 'chalk'
import { Command } from 'commander'
import {
    listAccounts,
    removeAccount,
    saveApiToken,
    setDefaultAccount,
    type TokenStorageResult,
} from '../lib/auth.js'

async function addAccount(email: string, token: string): Promise<void> {
    const result = await saveApiToken(token, { account: email, setAsDefault: 'if-unset' })
    console.log(chalk.green('✓'), `Stored account ${result.account}`)
    logTokenStorageResult(result, 'Token stored securely in the system credential manager')
}

async function listStoredAccounts(): Promise<void> {
    const accounts = await listAccounts()
    if (accounts.length === 0) {
        console.log('No stored accounts')
        return
    }

    for (const account of accounts) {
        const markers = [
            account.isDefault ? 'default' : null,
            !account.hasStoredToken ? 'missing-token' : null,
        ]
            .filter((value): value is string => value !== null)
            .join(', ')
        console.log(markers ? `${account.email} (${markers})` : account.email)
    }
}

async function removeStoredAccount(email: string): Promise<void> {
    const result = await removeAccount(email)
    console.log(chalk.green('✓'), `Removed account ${result.account}`)
    logTokenStorageResult(result, 'Stored token removed from the system credential manager')
}

async function setDefaultStoredAccount(email: string): Promise<void> {
    await setDefaultAccount(email)
    console.log(chalk.green('✓'), `Default account set to ${email.trim().toLowerCase()}`)
}

function logTokenStorageResult(result: TokenStorageResult, secureStoreMessage: string): void {
    if (result.storage === 'secure-store') {
        console.log(chalk.dim(secureStoreMessage))
    }

    if (result.warning) {
        console.error(chalk.yellow('Warning:'), result.warning)
    }
}

export function registerMultiAuthCommand(program: Command): void {
    const multiAuth = program
        .command('multi-auth')
        .description('Manage multiple stored Todoist accounts')

    multiAuth
        .command('add <email> <token>')
        .description('Store a Todoist API token for an account')
        .action(addAccount)

    multiAuth.command('list').description('List stored accounts').action(listStoredAccounts)

    multiAuth
        .command('remove <email>')
        .description('Remove a stored account')
        .action(removeStoredAccount)

    multiAuth
        .command('default <email>')
        .description('Set the default stored account')
        .action(setDefaultStoredAccount)
}
