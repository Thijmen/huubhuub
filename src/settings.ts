import { applySetting, RUNTIME_SETTINGS, type Config, type RuntimeSetting } from "./config"
import type { Store } from "./store"

/** Variables that configure the bot process itself; changing them at runtime would do nothing or break it. */
export const PROTECTED_ENV = new Set([
  "TELEGRAM_BOT_TOKEN",
  "DATA_DIR",
  "WORKSPACE_DIR",
  "ADMIN_TOKEN",
  "ADMIN_PORT",
  "ADMIN_HOST",
  "ADMIN_PUBLIC_URL",
  "OPENCODE_BOT_CONFIG",
  "OPENCODE_LOG_LEVEL",
  "OPENCODE_PORT",
  "OPENCODE_HOST",
  "OPENCODE_PUBLIC_URL",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_DB",
  "BOT_INTERNAL_URL",
  "BOT_INTERNAL_TOKEN",
  "HOME",
  "PATH",
  "SHELL",
  "NODE_ENV",
])

export function isRuntimeSetting(name: string): name is RuntimeSetting {
  return (RUNTIME_SETTINGS as readonly string[]).includes(name)
}

/** Settings and environment variables managed from the admin UI, layered over the process environment. */
export class Settings {
  private readonly original = new Map<string, string | undefined>()

  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {}

  /** Apply stored overrides. Call before OpenCode starts so providers see the managed env vars. */
  load(): void {
    for (const { name, value } of this.store.envVars()) this.exportEnv(name, value)
    for (const key of RUNTIME_SETTINGS) {
      const stored = this.store.getSetting(key)
      if (stored === undefined) continue
      try {
        applySetting(this.config, key, stored)
      } catch (err) {
        console.error(`Ignoring invalid stored setting ${key}`, err)
      }
    }
  }

  describe() {
    return RUNTIME_SETTINGS.map((key) => {
      const stored = this.store.getSetting(key)
      const value = this.config[key]
      return {
        key,
        value: Array.isArray(value) ? value.join(",") : String(value ?? ""),
        source: stored !== undefined ? ("admin" as const) : process.env[key] ? ("env" as const) : ("default" as const),
        envValue: process.env[key] ?? "",
      }
    })
  }

  /** Set a runtime setting; `undefined` removes the override. Throws if the value is invalid. */
  set(key: RuntimeSetting, value: string | undefined): void {
    applySetting(this.config, key, value)
    this.store.setSetting(key, value)
  }

  envVars() {
    return this.store.envVars()
  }

  setEnv(name: string, value: string): void {
    if (PROTECTED_ENV.has(name)) throw new Error(`${name} can only be changed in the container environment.`)
    this.store.setEnvVar(name, value)
    this.exportEnv(name, value)
  }

  deleteEnv(name: string): void {
    this.store.deleteEnvVar(name)
    if (!this.original.has(name)) return
    const prev = this.original.get(name)
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
    this.original.delete(name)
  }

  private exportEnv(name: string, value: string): void {
    if (!this.original.has(name)) this.original.set(name, process.env[name])
    process.env[name] = value
  }
}
