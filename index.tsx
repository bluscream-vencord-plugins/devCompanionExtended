//// Plugin originally written for Equicord at 2026-02-16 by https://github.com/Bluscream, https://antigravity.google
// region Imports
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";

import { initWs, sockets, startMcpIpcBridge, stopMcpIpcBridge, stopWs } from "./ws";
import { settings } from "./settings";
// endregion Imports

import { pluginInfo } from "./info";
export { pluginInfo };

// region Variables
export const logger = new Logger(pluginInfo.id, pluginInfo.color);
const Native = VencordNative.pluginHelpers.devcompanionExtended as PluginNative<typeof import("./native")>;
export const DEFAULT_PORT = 8487;
// endregion Variables

// region Definition
export default definePlugin({
    name: "DevCompanionExtended", // needs to be const string for native modules regex parsing
    description: pluginInfo.description,
    authors: pluginInfo.authors,

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
// endregion Definition
