import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInstaller } from './create-installer.js'
import type { SkillInstaller } from './types.js'

export const skillInstallers: Record<string, SkillInstaller> = {
    'claude-code': createInstaller({
        name: 'claude-code',
        description: 'Claude Code skill for Todoist CLI',
        dirName: '.claude',
    }),
    codex: createInstaller({
        name: 'codex',
        description: 'Codex skill for Todoist CLI',
        dirName: '.codex',
    }),
    cursor: createInstaller({
        name: 'cursor',
        description: 'Cursor skill for Todoist CLI',
        dirName: '.cursor',
    }),
    gemini: createInstaller({
        name: 'gemini',
        description: 'Gemini CLI skill for Todoist CLI',
        dirName: '.gemini',
    }),
    openclaw: createInstaller({
        name: 'openclaw',
        description: 'OpenClaw skill for Todoist CLI',
        getInstallPath(local) {
            const base = local ? process.cwd() : homedir()
            return join(base, local ? 'skills' : '.openclaw/skills', 'todoist-cli', 'SKILL.md')
        },
        getAgentInstallCheckPath(local) {
            return local ? process.cwd() : join(homedir(), '.openclaw')
        },
    }),
}

export function getInstaller(agent: string): SkillInstaller | undefined {
    return skillInstallers[agent]
}

export function listAgents(): string[] {
    return Object.keys(skillInstallers)
}

export type { SkillInstaller } from './types.js'
