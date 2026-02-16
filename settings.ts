import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    notifyOnConnect: {
        description: "Show notification when MCP server connects",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: false,
    },
    allowReload: {
        description: "Allow MCP server to reload Discord",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: false,
    },
    allowPluginToggle: {
        description: "Allow MCP server to enable/disable plugins",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: false,
    },
    debugMode: {
        description: "Enable debug logging",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: false,
    },
    ports: {
        description: "Comma/space-separated MCP ports or ranges (leave empty to auto-detect)",
        type: OptionType.STRING,
        default: "",
        restartNeeded: false,
    },
    maxReconnectAttempts: {
        description: "How many times to retry a port before giving up (manual reconnect resets)",
        type: OptionType.NUMBER,
        default: 5,
        onChange: value => Math.max(1, Math.min(20, value || 5)),
        restartNeeded: false,
    },
    scanSpread: {
        description: "When ports are empty, scan this many ports below/above the default",
        type: OptionType.NUMBER,
        default: 2,
        onChange: value => Math.max(0, Math.min(20, value || 2)),
        restartNeeded: false,
    },
    enableIpcServer: {
        description: "Host an in-app MCP HTTP server via IPC (fast path)",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    },
    enableWebSocketFallback: {
        description: "Fallback to external MCP server (WebSocket) if IPC server fails",
        type: OptionType.BOOLEAN,
        default: false,
        restartNeeded: false,
    },
    ipcPort: {
        description: "Port for the in-app MCP HTTP server (0 = auto)",
        type: OptionType.NUMBER,
        default: 8486,
        onChange: value => Math.max(0, Math.min(65535, value ?? 8486)),
        restartNeeded: true,
    },
    cacheEnabled: {
        description: "Enable response caching for safe MCP tools",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: false,
    },
    cacheTtlMs: {
        description: "Default cache TTL in ms for safe MCP tools",
        type: OptionType.NUMBER,
        default: 10000,
        onChange: value => Math.max(0, Math.min(300000, value ?? 10000)),
        restartNeeded: false,
    },
    cacheMaxEntries: {
        description: "Maximum cached responses to keep",
        type: OptionType.NUMBER,
        default: 300,
        onChange: value => Math.max(50, Math.min(2000, value ?? 300)),
        restartNeeded: false,
    },
    prebuildSearchIndex: {
        description: "Prebuild a module token index to speed up literal searches",
        type: OptionType.BOOLEAN,
        default: false,
        restartNeeded: false,
    },
    prebuildPatchIndex: {
        description: "Prebuild a patch index to speed up patch analysis",
        type: OptionType.BOOLEAN,
        default: false,
        restartNeeded: false,
    },
    prewarmStoreCache: {
        description: "Prewarm store cache at startup to speed up store listing",
        type: OptionType.BOOLEAN,
        default: false,
        restartNeeded: false,
    },
    prewarmSearchQueries: {
        description: "Comma/space-separated literal search queries to prewarm on startup",
        type: OptionType.STRING,
        default: "",
        restartNeeded: false,
    },
    ipcReadyTimeoutMs: {
        description: "How long to wait for IPC server readiness after reload (ms)",
        type: OptionType.NUMBER,
        default: 12000,
        onChange: value => Math.max(1000, Math.min(60000, value ?? 12000)),
        restartNeeded: false,
    },
    ipcReadyIntervalMs: {
        description: "Polling interval while waiting for IPC readiness (ms)",
        type: OptionType.NUMBER,
        default: 300,
        onChange: value => Math.max(100, Math.min(5000, value ?? 300)),
        restartNeeded: false,
    }
});
