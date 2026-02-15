/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";

import { initWs, sockets, startMcpIpcBridge, stopMcpIpcBridge, stopWs } from "./ws";

export const DEFAULT_PORT = 8487;

const pluginId = "devCompanionExtended";
const pluginName = "Dev Companion Extended";
export const logger = new Logger(pluginName, "#7289da");

const Native = VencordNative.pluginHelpers.devcompanionExtended as PluginNative<typeof import("./native")>;

export const settings = definePluginSettings({
    notifyOnConnect: {
        description: "Show notification when MCP server connects",
        type: OptionType.BOOLEAN,
        default: true
    },
    allowReload: {
        description: "Allow MCP server to reload Discord",
        type: OptionType.BOOLEAN,
        default: true
    },
    allowPluginToggle: {
        description: "Allow MCP server to enable/disable plugins",
        type: OptionType.BOOLEAN,
        default: true
    },
    debugMode: {
        description: "Enable debug logging",
        type: OptionType.BOOLEAN,
        default: true
    },
    ports: {
        description: "Comma/space-separated MCP ports or ranges (leave empty to auto-detect)",
        type: OptionType.STRING,
        default: ""
    },
    maxReconnectAttempts: {
        description: "How many times to retry a port before giving up (manual reconnect resets)",
        type: OptionType.NUMBER,
        default: 5,
        onChange: value => Math.max(1, Math.min(20, value || 5))
    },
    scanSpread: {
        description: "When ports are empty, scan this many ports below/above the default",
        type: OptionType.NUMBER,
        default: 2,
        onChange: value => Math.max(0, Math.min(20, value || 2))
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
        default: false
    },
    ipcPort: {
        description: "Port for the in-app MCP HTTP server (0 = auto)",
        type: OptionType.NUMBER,
        default: 8486,
        onChange: value => Math.max(0, Math.min(65535, value ?? 8486))
    },
    cacheEnabled: {
        description: "Enable response caching for safe MCP tools",
        type: OptionType.BOOLEAN,
        default: true
    },
    cacheTtlMs: {
        description: "Default cache TTL in ms for safe MCP tools",
        type: OptionType.NUMBER,
        default: 10000,
        onChange: value => Math.max(0, Math.min(300000, value ?? 10000))
    },
    cacheMaxEntries: {
        description: "Maximum cached responses to keep",
        type: OptionType.NUMBER,
        default: 300,
        onChange: value => Math.max(50, Math.min(2000, value ?? 300))
    },
    prebuildSearchIndex: {
        description: "Prebuild a module token index to speed up literal searches",
        type: OptionType.BOOLEAN,
        default: false
    },
    prebuildPatchIndex: {
        description: "Prebuild a patch index to speed up patch analysis",
        type: OptionType.BOOLEAN,
        default: false
    },
    prewarmStoreCache: {
        description: "Prewarm store cache at startup to speed up store listing",
        type: OptionType.BOOLEAN,
        default: false
    },
    prewarmSearchQueries: {
        description: "Comma/space-separated literal search queries to prewarm on startup",
        type: OptionType.STRING,
        default: ""
    },
    ipcReadyTimeoutMs: {
        description: "How long to wait for IPC server readiness after reload (ms)",
        type: OptionType.NUMBER,
        default: 12000,
        onChange: value => Math.max(1000, Math.min(60000, value ?? 12000))
    },
    ipcReadyIntervalMs: {
        description: "Polling interval while waiting for IPC readiness (ms)",
        type: OptionType.NUMBER,
        default: 300,
        onChange: value => Math.max(100, Math.min(5000, value ?? 300))
    }
});

export default definePlugin({
    name: pluginName,
    description: pluginName,
    authors: [EquicordDevs.prism, EquicordDevs.justjxke],

    settings,

    toolboxActions: {
        "Reconnect"() {
            stopWs();
            initWs(true);
        },
        "Test Connection"() {
            const openPorts = Array.from(sockets.entries())
                .filter(([, sock]) => sock.readyState === WebSocket.OPEN)
                .map(([port]) => port)
                .sort((a, b) => a - b);
            if (openPorts.length) {
                logger.info(`WebSocket(s) connected on ports: ${openPorts.join(", ")}`);
            } else {
                logger.warn("No WebSocket connections");
            }
        }
    },

    async start() {
        logger.info("Devcompanion starting...");
        try {
            if (settings.store.enableIpcServer) {
                if (!Native?.startServer || !Native?.getNextRequest || !Native?.sendResponse) {
                    logger.warn("IPC MCP native helper missing; rebuild Equicord to enable IPC server");
                } else {
                    if (settings.store.debugMode) {
                        logger.info(`IPC native helpers: ${Object.keys(Native).join(", ") || "none"}`);
                    }
                    startMcpIpcBridge();
                    let result = await Native.startServer(settings.store.ipcPort);
                    if (!result?.ok && result?.code === "EADDRINUSE" && settings.store.ipcPort !== 0) {
                        logger.warn(`IPC MCP port ${settings.store.ipcPort} is in use; falling back to auto port`);
                        result = await Native.startServer(0);
                    }
                    if (result?.ok) {
                        logger.info(`IPC MCP server listening on port ${result?.port}`);
                        if (Native?.getServerStatus) {
                            try {
                                const status = await Native.getServerStatus();
                                logger.info(`IPC MCP status: ${status.running ? "running" : "stopped"} on port ${status.port}`);
                            } catch (statusError) {
                                logger.warn(`IPC MCP status check failed: ${String(statusError)}`);
                            }
                        }
                        return;
                    }
                    if (!result?.ok) {
                        logger.warn("IPC MCP server failed to start, falling back to WebSocket");
                        if (settings.store.enableWebSocketFallback) {
                            initWs();
                            logger.info("WebSocket fallback initialization started");
                        }
                        return;
                    }
                    return;
                }
            }
            if (settings.store.enableWebSocketFallback) {
                initWs();
                logger.info(settings.store.enableIpcServer ? "WebSocket fallback initialization started" : "WebSocket initialization started");
            }
        } catch (error) {
            logger.error("oh fuck: " + String(error));
            if (settings.store.enableWebSocketFallback) {
                try {
                    initWs();
                    logger.info("WebSocket fallback initialization started");
                } catch (fallbackError) {
                    logger.error("WebSocket fallback failed: " + String(fallbackError));
                }
            }
        }
    },

    stop() {
        logger.info("Devcompanion stopping...");
        stopWs();
        stopMcpIpcBridge();
        try {
            Native?.stopServer?.();
        } catch (error) {
            logger.warn("IPC MCP server stop failed: " + String(error));
        }
    }
});
