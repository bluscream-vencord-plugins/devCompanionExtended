/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "crypto";
import { BrowserWindow } from "electron";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";

type MCPRequest = {
    jsonrpc: "2.0";
    id?: number | string;
    method: string;
    params?: Record<string, unknown>;
};

type MCPResponse = {
    jsonrpc: "2.0";
    id: number | string | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown; };
};

type StartServerResult = { ok: boolean; port: number; error?: string; code?: string; };
type ServerStatus = { running: boolean; port: number | null; };
type OkResult = { ok: boolean; };

const HOST = "127.0.0.1";
let server: Server | null = null;
let currentPort: number | null = null;
let requestId = 0;
const MAX_REQUEST_ID = 2147483647;
const pendingRequests = new Map<number, (response: MCPResponse) => void>();
const requestQueue: Array<{ id: number; request: MCPRequest; }> = [];

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => resolve(body));
        req.on("error", reject);
    });
}

function sendJson(res: ServerResponse, data: unknown, sessionId?: string) {
    res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {})
    });
    res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, id: number | string | null, code: number, message: string, sessionId?: string) {
    sendJson(res, { jsonrpc: "2.0", id, error: { code, message } }, sessionId);
}

function sendNoContent(res: ServerResponse, sessionId?: string) {
    res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {})
    });
    res.end();
}

function getMainWindow(): BrowserWindow | null {
    return BrowserWindow.getAllWindows().find(w => !w.isDestroyed()) ?? null;
}

export async function startServer(_: Electron.IpcMainInvokeEvent, port = 8486): Promise<StartServerResult> {
    for (const [id, resolve] of pendingRequests) {
        resolve({ jsonrpc: "2.0", id, error: { code: -32603, message: "Session reset" } });
    }
    pendingRequests.clear();
    requestQueue.length = 0;

    if (server) return { ok: true, port: currentPort ?? port };

    const nextServer = createServer(async (req, res) => {
        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type"
            });
            res.end();
            return;
        }

        const sessionId = Array.isArray(req.headers["mcp-session-id"]) ? req.headers["mcp-session-id"][0] : req.headers["mcp-session-id"];
        const effectiveSessionId = sessionId ? String(sessionId) : randomUUID();

        if (req.method !== "POST") {
            sendError(res, null, -32600, "Only POST method allowed", effectiveSessionId);
            return;
        }

        const window = getMainWindow();
        if (!window) {
            sendError(res, null, -32603, "Discord window not found", effectiveSessionId);
            return;
        }

        let body: string;
        try {
            body = await readBody(req);
        } catch {
            sendError(res, null, -32700, "Failed to read body", effectiveSessionId);
            return;
        }

        let request: MCPRequest;
        try {
            request = JSON.parse(body);
        } catch {
            sendError(res, null, -32700, "Invalid JSON", effectiveSessionId);
            return;
        }

        if (request.jsonrpc !== "2.0") {
            sendError(res, request.id ?? null, -32600, "Must use JSON-RPC 2.0", effectiveSessionId);
            return;
        }

        if (request.id === undefined || request.id === null) {
            sendNoContent(res, effectiveSessionId);
            return;
        }

        const id = requestId = (requestId + 1) % MAX_REQUEST_ID;
        const requestIdValue = request.id as string | number;
        const responsePromise = new Promise<MCPResponse>(resolve => {
            pendingRequests.set(id, resolve);
            setTimeout(() => {
                if (pendingRequests.has(id)) {
                    pendingRequests.delete(id);
                    resolve({ jsonrpc: "2.0", id: requestIdValue, error: { code: -32603, message: "Timeout" } });
                }
            }, 30000);
        });

        requestQueue.push({ id, request });
        sendJson(res, await responsePromise, effectiveSessionId);
    });

    return await new Promise<StartServerResult>(resolve => {
        const onError = (error: Error & { code?: string; }) => {
            if (server === nextServer) server = null;
            if (currentPort === port) currentPort = null;
            nextServer.removeAllListeners();
            resolve({ ok: false, port, error: error.message, code: error.code });
        };

        nextServer.once("error", onError);
        nextServer.listen(port, HOST, () => {
            nextServer.removeListener("error", onError);
            const address = nextServer.address();
            const actualPort = typeof address === "object" && address ? address.port : port;
            server = nextServer;
            currentPort = actualPort;
            console.log(`[DevCompanionExtended] IPC MCP server listening on ${HOST}:${actualPort}`);
            resolve({ ok: true, port: actualPort });
        });
    });
}

export function stopServer(_: Electron.IpcMainInvokeEvent): OkResult {
    for (const [id, resolve] of pendingRequests) {
        resolve({ jsonrpc: "2.0", id, error: { code: -32603, message: "Server stopped" } });
    }
    pendingRequests.clear();
    requestQueue.length = 0;
    server?.close();
    server = null;
    currentPort = null;
    return { ok: true };
}

export function getServerStatus(_: Electron.IpcMainInvokeEvent): ServerStatus {
    return { running: server !== null, port: currentPort };
}

export function getNextRequest(_: Electron.IpcMainInvokeEvent): { id: number; request: MCPRequest; } | null {
    return requestQueue.shift() ?? null;
}

export function sendResponse(_: Electron.IpcMainInvokeEvent, id: number, response: MCPResponse | null): OkResult {
    const resolve = pendingRequests.get(id);
    if (!resolve) return { ok: false };
    pendingRequests.delete(id);
    resolve(response ?? { jsonrpc: "2.0", id, error: { code: -32603, message: "Missing response" } });
    return { ok: true };
}
