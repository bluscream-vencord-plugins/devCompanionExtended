/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings } from "@api/Settings";
import { getIntlMessageFromHash } from "@utils/discord";
import { runtimeHashMessageKey } from "@utils/intlHash";
import { canonicalizeMatch } from "@utils/patches";
import { PluginNative } from "@utils/types";
import { filters, findAll, fluxStores, search, wreq } from "@webpack";
import * as Common from "@webpack/common";
import { Constants, FluxDispatcher, RestAPI, Toasts } from "@webpack/common";
import { WebpackPatcher } from "Vencord";

import { DEFAULT_PORT, logger, settings } from ".";
import { getMcpTools } from "./mcpTools";

const { getFactoryPatchedBy, getFactoryPatchedSource } = WebpackPatcher;
const Native = VencordNative.pluginHelpers.devcompanionExtended as PluginNative<typeof import("./native")>;

export const sockets = new Map<number, WebSocket>();
type ConnectionState = { socket?: WebSocket; reconnectTimeout?: NodeJS.Timeout; reconnectAttempts: number; };
const connections = new Map<number, ConnectionState>();
const MAX_RECONNECT_DELAY = 15000;
const INITIAL_RECONNECT_DELAY = 500;
const MAX_SCAN_SPREAD = 20; // upper bound for safety
let fallbackTimer: NodeJS.Timeout | undefined;
let dynamicReconnectAttempts = 5;
let dynamicFallbackSpread = 2;
const MAX_CODE_LENGTH = 50000;
const CHUNK_SIZE = 1000;
const stoppedPorts = new Set<number>();
let stoppedPortsTimer: NodeJS.Timeout | undefined;
let warmupStarted = false;

type PatchIndexEntry = { moduleId: number; patchedBy: string[]; };
const patchIndex: {
    ready: boolean;
    inFlight: Promise<void> | null;
    entries: PatchIndexEntry[];
    disabled: boolean;
} = {
    ready: false,
    inFlight: null,
    entries: [],
    disabled: false
};

async function buildPatchIndex(): Promise<void> {
    if (!settings.store.prebuildPatchIndex || patchIndex.disabled) return;
    if (patchIndex.ready) return;
    if (patchIndex.inFlight) return patchIndex.inFlight;

    patchIndex.inFlight = (async () => {
        const moduleIds = Object.keys(wreq.m);
        const batchSize = 20;
        let processed = 0;
        debugInfo(`Building patch index for ${moduleIds.length} modules...`);
        patchIndex.entries = [];

        for (let i = 0; i < moduleIds.length; i += batchSize) {
            const batch = moduleIds.slice(i, Math.min(i + batchSize, moduleIds.length));
            await new Promise(resolve => setTimeout(resolve, 0));

            for (const id of batch) {
                const patchedBy = getModulePatchedBy(id, true);
                if (patchedBy.length) {
                    patchIndex.entries.push({ moduleId: Number(id), patchedBy });
                }
                processed++;
                if (processed % 200 === 0) {
                    await new Promise(resolve => requestAnimationFrame(resolve));
                }
            }
        }

        patchIndex.ready = true;
        debugInfo(`Patch index ready: ${patchIndex.entries.length} modules`);
    })().finally(() => {
        patchIndex.inFlight = null;
    });

    return patchIndex.inFlight;
}

function debugInfo(message: string) {
    if (settings.store.debugMode) {
        logger.info(message);
    }
}

function getWarmupQueries(): string[] {
    const raw = settings.store.prewarmSearchQueries?.trim();
    if (!raw) return [];
    const parts = raw.split(/[,\s]+/).map(part => part.trim()).filter(Boolean);
    const unique = Array.from(new Set(parts));
    return unique.slice(0, 20);
}

function startWarmupTasks(source: "ipc" | "ws"): void {
    if (warmupStarted) return;
    const queries = getWarmupQueries();
    if (!settings.store.prewarmStoreCache && queries.length === 0) return;
    warmupStarted = true;

    void (async () => {
        if (settings.store.prewarmStoreCache) {
            debugInfo(`Prewarming store cache (${source})...`);
            try {
                await handleGetStores();
            } catch (error) {
                debugInfo(`Store cache prewarm failed (${source}): ${String(error)}`);
            }
        }

        if (queries.length) {
            debugInfo(`Prewarming search cache (${source}): ${queries.join(", ")}`);
            for (const query of queries) {
                try {
                    await handleSearchLiteral({ query, isRegex: false, limit: 20, offset: 0 });
                } catch (error) {
                    debugInfo(`Search prewarm failed for "${query}" (${source}): ${String(error)}`);
                }
            }
        }

        debugInfo(`Prewarm complete (${source}).`);
    })();
}

function scheduleStoppedPortsLog() {
    if (stoppedPortsTimer) return;
    stoppedPortsTimer = setTimeout(() => {
        const ports = Array.from(stoppedPorts).sort((a, b) => a - b);
        stoppedPorts.clear();
        stoppedPortsTimer = undefined;
        logger.info(`Stopped reconnecting on ports: ${ports.join(", ")}`);
    }, 500);
}

function recordStoppedPort(port: number) {
    stoppedPorts.add(port);
    scheduleStoppedPortsLog();
}

async function* asyncIterateModules<T>(
    processor: (id: string, code: string) => T | null,
    filter?: (id: string) => boolean
): AsyncGenerator<T, void, unknown> {
    const modules = Object.keys(wreq.m);
    const batchSize = 10;
    let processed = 0;

    for (let i = 0; i < modules.length; i += batchSize) {
        const batch = modules.slice(i, Math.min(i + batchSize, modules.length));

        await new Promise(resolve => setTimeout(resolve, 0));

        for (const id of batch) {
            if (filter && !filter(id)) continue;

            const code = wreq.m[id].toString();
            const result = processor(id, code);

            if (result !== null) {
                yield result;
            }

            processed++;

            if (processed % 100 === 0) {
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
        }
    }
}

class ModuleSearchEngine {
    private static codeCache = new Map<string, { code: string; hash: number; }>();
    private static searchIndex = new Map<string, { ids: Set<string>; timestamp: number; }>();
    private static literalCache = new Map<string, { timestamp: number; matches: Array<{ id: number; preview: string; occurrences: number; offsets: number[]; snippets: string[]; }>; }>();
    private static tokenIndex = new Map<string, Set<string>>();
    private static tokenIndexReady = false;
    private static tokenIndexInFlight: Promise<void> | null = null;
    private static tokenIndexDisabled = false;
    private static tokenIndexLoggedHit = false;
    private static readonly INDEX_TTL_MS = 60000;
    private static readonly LITERAL_TTL_MS = 30000;
    private static readonly TOKEN_INDEX_LIMIT = 200000;
    private static readonly TOKEN_MAX_PER_MODULE = 200;
    private static readonly TOKEN_REGEX = /[A-Za-z_][A-Za-z0-9_]{2,}/g;

    static hashCode(str: string): number {
        let hash = 0;
        for (let i = 0; i < Math.min(str.length, 1000); i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }

    static getModuleCode(id: string): string {
        const cached = this.codeCache.get(id);
        if (cached) return cached.code;

        const code = wreq.m[id].toString();
        this.codeCache.set(id, { code, hash: this.hashCode(code) });

        if (this.codeCache.size > 500) {
            const firstKey = this.codeCache.keys().next().value;
            if (firstKey) {
                this.codeCache.delete(firstKey);
            }
        }

        return code;
    }

    static async* searchPattern(pattern: string | RegExp): AsyncGenerator<{ id: string; code: string; }, void, unknown> {
        const isRegex = pattern instanceof RegExp;
        const searchStr = isRegex ? "" : pattern;

        if (!isRegex && searchStr.length > 3) {
            const candidates = await this.getIndexedCandidates(searchStr);
            if (candidates) {
                for (const id of candidates) {
                    const code = this.getModuleCode(id);
                    if (isRegex ? pattern.test(code) : code.includes(searchStr)) {
                        yield { id, code };
                    }
                }
                return;
            }
        }

        if (!isRegex && searchStr.length > 3) {
            const key = searchStr.substring(0, 3);
            const indexed = this.searchIndex.get(key);
            if (indexed && Date.now() - indexed.timestamp < this.INDEX_TTL_MS) {
                for (const id of indexed.ids) {
                    const code = this.getModuleCode(id);
                    if (isRegex ? pattern.test(code) : code.includes(searchStr)) {
                        yield { id, code };
                    }
                }
                return;
            }
        }

        yield* asyncIterateModules((id, code) => {
            const matches = isRegex ? pattern.test(code) : code.includes(searchStr);
            if (matches) {
                if (!isRegex && searchStr.length > 3) {
                    const key = searchStr.substring(0, 3);
                    if (!this.searchIndex.has(key)) {
                        this.searchIndex.set(key, { ids: new Set(), timestamp: Date.now() });
                    }
                    const entry = this.searchIndex.get(key)!;
                    entry.ids.add(id);
                    entry.timestamp = Date.now();
                }
                return { id, code };
            }
            return null;
        });
    }

    static clearCache() {
        this.codeCache.clear();
        this.searchIndex.clear();
        this.patternCache.clear();
        this.literalCache.clear();
        this.tokenIndex.clear();
        this.tokenIndexReady = false;
        this.tokenIndexDisabled = false;
        this.tokenIndexInFlight = null;
    }

    private static patternCache = new Map<string, Array<{ id: string; code: string; }>>();

    static getCachedResults(pattern: string | RegExp): Array<{ id: string; code: string; }> {
        const key = pattern instanceof RegExp ? pattern.toString() : pattern;
        return this.patternCache.get(key) || [];
    }

    static addToCache(pattern: string | RegExp, id: string, code: string): void {
        const key = pattern instanceof RegExp ? pattern.toString() : pattern;
        if (!this.patternCache.has(key)) {
            this.patternCache.set(key, []);
        }
        const cached = this.patternCache.get(key)!;
        if (cached.length >= 20) return;
        if (!cached.some(item => item.id === id)) {
            cached.push({ id, code: code.substring(0, 500) });
        }
        if (this.patternCache.size > 50) {
            const keys = Array.from(this.patternCache.keys());
            for (let i = 0; i < 25; i++) {
                this.patternCache.delete(keys[i]);
            }
        }
    }

    static getLiteralCache(query: string): Array<{ id: number; preview: string; occurrences: number; offsets: number[]; snippets: string[]; }> | null {
        const entry = this.literalCache.get(query);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > this.LITERAL_TTL_MS) {
            this.literalCache.delete(query);
            return null;
        }
        return entry.matches;
    }

    static setLiteralCache(query: string, matches: Array<{ id: number; preview: string; occurrences: number; offsets: number[]; snippets: string[]; }>) {
        this.literalCache.set(query, { timestamp: Date.now(), matches });
        if (this.literalCache.size > 50) {
            const keys = Array.from(this.literalCache.keys());
            for (let i = 0; i < 25; i++) {
                this.literalCache.delete(keys[i]);
            }
        }
    }

    private static extractTokens(text: string): string[] {
        const matches = text.match(this.TOKEN_REGEX);
        if (!matches) return [];
        const unique = new Set<string>();
        for (const token of matches) {
            unique.add(token.toLowerCase());
            if (unique.size >= this.TOKEN_MAX_PER_MODULE) break;
        }
        return Array.from(unique);
    }

    private static addToken(token: string, moduleId: string): boolean {
        let entry = this.tokenIndex.get(token);
        if (!entry) {
            if (this.tokenIndex.size >= this.TOKEN_INDEX_LIMIT) {
                return false;
            }
            entry = new Set();
            this.tokenIndex.set(token, entry);
        }
        entry.add(moduleId);
        return true;
    }

    static async ensureTokenIndex(): Promise<void> {
        if (!settings.store.prebuildSearchIndex || this.tokenIndexDisabled) return;
        if (this.tokenIndexReady) return;
        if (this.tokenIndexInFlight) return this.tokenIndexInFlight;

        this.tokenIndexInFlight = (async () => {
            const moduleIds = Object.keys(wreq.m);
            const batchSize = 10;
            let processed = 0;
            debugInfo(`Building search index for ${moduleIds.length} modules...`);

            for (let i = 0; i < moduleIds.length; i += batchSize) {
                const batch = moduleIds.slice(i, Math.min(i + batchSize, moduleIds.length));
                await new Promise(resolve => setTimeout(resolve, 0));

                for (const id of batch) {
                    const code = wreq.m[id].toString();
                    const tokens = this.extractTokens(code);
                    for (const token of tokens) {
                        if (!this.addToken(token, id)) {
                            this.tokenIndexDisabled = true;
                            this.tokenIndex.clear();
                            logger.warn("Prebuilt search index disabled: token limit exceeded");
                            return;
                        }
                    }
                    processed++;
                    if (processed % 100 === 0) {
                        await new Promise(resolve => requestAnimationFrame(resolve));
                    }
                }
            }

            this.tokenIndexReady = true;
            debugInfo(`Search index ready: ${processed} modules, ${this.tokenIndex.size} tokens`);
        })().finally(() => {
            this.tokenIndexInFlight = null;
        });

        return this.tokenIndexInFlight;
    }

    static async getIndexedCandidates(query: string): Promise<Set<string> | null> {
        if (!settings.store.prebuildSearchIndex || this.tokenIndexDisabled) return null;
        await this.ensureTokenIndex();
        if (!this.tokenIndexReady) return null;

        const tokens = this.extractTokens(query);
        if (!tokens.length) return null;

        let best: Set<string> | null = null;
        for (const token of tokens) {
            const candidates = this.tokenIndex.get(token);
            if (!candidates) continue;
            if (!best || candidates.size < best.size) {
                best = candidates;
            }
        }

        if (best && !this.tokenIndexLoggedHit) {
            this.tokenIndexLoggedHit = true;
            debugInfo(`Search index hit: ${best.size} candidate modules`);
        }
        return best;
    }
}

type DomNodeSummary = {
    tag: string;
    id?: string;
    classes: string[];
    text?: string;
    attrs?: Record<string, string>;
    childCount: number;
    children?: DomNodeSummary[];
};

function normalizeText(text: string, maxLength: number): string {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length > maxLength) {
        return clean.slice(0, maxLength) + "...";
    }
    return clean;
}

function collectAttributes(el: Element, max = 10): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(el.attributes).slice(0, max)) {
        attrs[attr.name] = attr.value;
    }
    return attrs;
}

function elementPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && depth < 10) {
        const tag = node.tagName.toLowerCase();
        const id = node.id ? `#${node.id}` : "";
        const classes = node.classList.length ? "." + Array.from(node.classList).slice(0, 2).join(".") : "";
        const parent = node.parentElement;
        let nth = "";
        if (parent) {
            const siblings = Array.from(parent.children);
            const index = siblings.indexOf(node);
            nth = `:nth-child(${index + 1})`;
        }
        parts.unshift(`${tag}${id}${classes}${nth}`);
        node = parent;
        depth++;
    }
    return parts.join(" > ");
}

function summarizeNode(el: Element, includeText: boolean, includeAttrs: boolean, maxTextLength: number): DomNodeSummary {
    const text = includeText ? normalizeText(el.textContent || "", maxTextLength) : undefined;
    return {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        classes: Array.from(el.classList),
        text: text && text.length > 0 ? text : undefined,
        attrs: includeAttrs ? collectAttributes(el) : undefined,
        childCount: el.childElementCount
    };
}

function buildTree(el: Element, depth: number, breadth: number, includeText: boolean, maxTextLength: number): DomNodeSummary {
    const node = summarizeNode(el, includeText, false, maxTextLength);
    if (depth <= 0) {
        return node;
    }
    const children: Element[] = Array.from(el.children).slice(0, breadth);
    if (children.length > 0) {
        node.children = children.map(child => buildTree(child, depth - 1, breadth, includeText, maxTextLength));
    }
    return node;
}

interface WSMessage {
    type: "tool_call";
    data: { name: string; arguments?: Record<string, unknown>; raw?: boolean; };
    nonce: number;
}

interface RegexNode {
    type: "regex";
    value: { pattern: string; flags: string; };
}

interface StringNode {
    type: "string";
    value: string;
}

type ArgNode = RegexNode | StringNode;

interface SearchRequest {
    findType: string;
    args: ArgNode[];
}

interface FindByPropsRequest {
    props: string[];
}

interface FindByCodeRequest {
    code: string[];
}

interface FindStoreRequest {
    name: string;
}

interface FindComponentByCodeRequest {
    code: string[];
}

interface FindAllRequest {
    props: string[];
    limit?: number;
}

interface GetModuleIdsRequest {
    limit?: number;
}

interface GetFluxEventsRequest {
    filter?: string;
}

interface GetIntlKeysRequest {
    filter?: string;
    limit?: number;
}

interface ExtractRequest {
    moduleId: PropertyKey;
    usePatched?: boolean;
    maxLength?: number;
}

interface DiffRequest {
    moduleId: PropertyKey;
}

interface TestPatchRequest {
    find: string | { pattern: string; flags: string; };
    replacements: Array<{
        match: string | { pattern: string; flags: string; };
        replace: string;
    }>;
    preview?: boolean;
    previewMode?: "compact" | "full" | "context-only";
    contextLines?: number;
    radius?: number;
}

interface PatchLintRequest {
    find: string | { pattern: string; flags: string; };
    replacements: Array<{
        match: string | { pattern: string; flags: string; };
        replace: string;
    }>;
    moduleId?: number;
}

interface PluginToggleRequest {
    pluginName: string;
    enabled: boolean;
}

interface BulkSearchRequest {
    queries: Array<{
        name?: string;
        findType: string;
        args: ArgNode[];
    }>;
}

interface QueryDomRequest {
    selector: string;
    limit?: number;
    includeText?: boolean;
    includeAttrs?: boolean;
    maxTextLength?: number;
}

interface InspectDomPathRequest {
    selector: string;
    index?: number;
    depth?: number;
    breadth?: number;
    includeText?: boolean;
    maxTextLength?: number;
}

interface ListDomClassesRequest {
    maxNodes?: number;
    maxClasses?: number;
}

interface FindTextNodesRequest {
    query: string;
    isRegex?: boolean;
    maxResults?: number;
    maxTextLength?: number;
}

interface SearchLiteralRequest {
    query: string;
    isRegex?: boolean;
    limit?: number;
    offset?: number;
    preset?: "compact" | "full" | "minimal";
}

interface SearchContextRequest {
    pattern: string;
    isRegex?: boolean;
    limit?: number;
    matchLimit?: number;
    radius?: number;
    contextLines?: number;
}

interface ComponentLocatorRequest {
    query: string;
    isRegex?: boolean;
    limit?: number;
}

interface DispatcherActionsRequest {
    filter?: string;
    isRegex?: boolean;
}

interface EventListenerAuditRequest {
    event?: string;
    limit?: number;
}

interface EvaluateCodeRequest {
    code: string;
    async?: boolean;
    expression?: boolean;
    timeoutMs?: number;
    maxOutputChars?: number;
}

interface CallRestApiRequest {
    method: "get" | "post" | "put" | "patch" | "del";
    url: string;
    body?: unknown;
    query?: Record<string, string | number | boolean>;
    headers?: Record<string, string>;
}

interface GetStoreStateRequest {
    storeName: string;
}

interface GetStoreSubscriptionsRequest {
    storeName: string;
    limit?: number;
}

interface GetEndpointsRequest {
    filter?: string;
}

interface DispatchFluxRequest {
    action: Record<string, unknown>;
}

interface FindEnumRequest {
    query: string;
    limit?: number;
    includeMembers?: boolean;
}

interface FindExportValueRequest {
    moduleId: number;
    exportName: string;
}

interface GetPrototypeMethodsRequest {
    moduleId: number;
    exportName?: string;
}

interface CanonicalizeIntlRequest {
    text: string;
}

interface ReverseIntlHashRequest {
    hashedKey: string;
}

interface SearchIntlInModuleRequest {
    moduleId: number;
}

interface PluginSettingsRequest {
    pluginId: string;
    action: "get" | "set" | "dry-run";
    values?: Record<string, unknown>;
}

interface StoreFindRequest {
    name: string;
}

interface StoreMethodsRequest {
    storeName: string;
}

interface StoreDiffRequest {
    storeName: string;
    limit?: number;
}

interface TraceRequest {
    action: "events" | "handlers" | "storeEvents" | "start" | "get" | "stop" | "store" | "status" | "clear";
    event?: string;
    filter?: string;
    isRegex?: boolean;
    storeName?: string;
    limit?: number;
    offset?: number;
    maxEntries?: number;
    redact?: boolean;
    fields?: string[];
    sampleRate?: number;
    matchPayload?: string;
    maxPayloadChars?: number;
    maxPayloadDepth?: number;
}

interface InterceptRequest {
    action: "set" | "get" | "stop" | "status";
    moduleId?: number;
    exportName?: string;
    path?: string;
    id?: string;
    limit?: number;
    offset?: number;
    maxEntries?: number;
    sampleRate?: number;
    matchArgs?: string;
    matchResult?: string;
    isRegex?: boolean;
}

interface GetCurrentContextResult {
    wsPorts: number[];
    connections: number;
    user: { id: string; username: string; discriminator?: string; globalName?: string | null; } | null;
    channel: { id: string; name: string; type: number; } | null;
    guild: { id: string; name: string; ownerId: string; } | null;
    buildNumber: number | null;
    locale: string | null;
    moduleCount: number;
    guildCount: number;
}

type MessageHandler = (data: unknown) => unknown | Promise<unknown>;

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

type ToolCallResult = {
    content: Array<{ type: "text"; text: string; }>;
    isError?: boolean;
};

type FindNode = { type: "string"; value: string; } | { type: "regex"; value: { pattern: string; flags: string; }; };

let mcpIpcActive = false;
let mcpIpcLoopActive = false;

const resourceStore = new Map<string, { mimeType: string; text: string; createdAt: number; }>();
const RESOURCE_MAX_AGE_MS = 5 * 60 * 1000;
const RESOURCE_MAX_ENTRIES = 200;

const moduleCache = new Map<string, { code: string; timestamp: number; }>();
const CACHE_TTL = 10000;
const STORE_CACHE_TTL_MS = 120000;
const PATCHED_CACHE_TTL_MS = 60000;
const TOOL_CACHE_TTL_MS = 10000;
const ANALYTICS_TARGET_CACHE_TTL_MS = 30000;
const TOOL_CACHE_MAX_ENTRIES = 300;
const TOOL_CACHE_OVERRIDES = new Map<string, number>([
    ["store", STORE_CACHE_TTL_MS],
    ["patch", PATCHED_CACHE_TTL_MS],
    ["search", 30000],
    ["module", 30000]
]);
const toolResponseCache = new Map<string, { timestamp: number; ttlMs: number; value: unknown; }>();
const toolResponseInFlight = new Map<string, Promise<unknown>>();
let toolCacheHits = 0;
let toolCacheStores = 0;
const storeCache: { timestamp: number; data: Record<string, { found: boolean; moduleId?: number; source?: string; }> | null; } = {
    timestamp: 0,
    data: null
};
const patchedModulesCache = new Map<string, { timestamp: number; result: { patches: Array<{ moduleId: number; pluginName: string; find: string; replacements: number; }>; totalFound: number; offset: number; limit: number; hasMore: boolean; }; }>();
const patchedModulesInFlight = new Map<string, Promise<{ patches: Array<{ moduleId: number; pluginName: string; find: string; replacements: number; }>; totalFound: number; offset: number; limit: number; hasMore: boolean; }>>();
const exportModuleIdCache = new WeakMap<object, number>();
const componentNameCache = new Map<number, { name: string; source: string; confidence: number; } | null>();
const storeSnapshots = new Map<string, Record<string, unknown>>();

type TraceEntry = { type: string; timestamp: number; payload: unknown; };
const traceState: {
    active: boolean;
    interceptor: ((action: Record<string, unknown>) => Record<string, unknown>) | null;
    events: TraceEntry[];
    maxEntries: number;
    redact: boolean;
    fields: string[] | null;
    sampleRate: number;
    matchPayload: { matcher: ((text: string) => boolean) | null; isRegex: boolean; pattern: string | null; };
    filter: string | null;
    isRegex: boolean;
    maxPayloadDepth: number | null;
} = {
    active: false,
    interceptor: null,
    events: [],
    maxEntries: 500,
    redact: false,
    fields: null,
    sampleRate: 1,
    matchPayload: { matcher: null, isRegex: false, pattern: null },
    filter: null,
    isRegex: false,
    maxPayloadDepth: null
};
const storeWatchers = new Map<string, { store: any; handler: () => void; remove: () => void; }>();

type AnalyticsEntry = { event: string; timestamp: string; payload?: unknown; flush?: boolean; source?: string; };
type AnalyticsTarget = { trackWithMetadata?: (...args: any[]) => unknown; track?: (...args: any[]) => unknown; };
const analyticsState: {
    active: boolean;
    events: AnalyticsEntry[];
    maxEntries: number;
    filter: string | null;
    isRegex: boolean;
    redact: boolean;
    fields: string[] | null;
    targets: Array<{ target: AnalyticsTarget; original: AnalyticsTarget; }>;
    matchCount: number;
    stopOnMatch: boolean;
    stopAfter: number | null;
    lastStopReason: string | null;
    cachedTargets: { targets: AnalyticsTarget[]; createdAt: number; } | null;
} = {
    active: false,
    events: [],
    maxEntries: 500,
    filter: null,
    isRegex: false,
    redact: true,
    fields: null,
    targets: [],
    matchCount: 0,
    stopOnMatch: false,
    stopAfter: null,
    lastStopReason: null,
    cachedTargets: null
};

type InterceptEntry = {
    id: string;
    targetLabel: string;
    calls: Array<{ timestamp: number; args: unknown[]; result?: unknown; error?: string; }>;
    maxEntries: number;
    sampleRate: number;
    matchArgs?: string;
    matchResult?: string;
    isRegex?: boolean;
    restore: () => void;
};
const intercepts = new Map<string, InterceptEntry>();
const evalSession: { vars: Record<string, unknown>; } = { vars: {} };

function stableStringify(value: unknown): string {
    if (value === null || value === undefined) return String(value);
    if (typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toOptionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function truncatePayload(payload: unknown, maxChars?: number) {
    if (!maxChars || !Number.isFinite(maxChars)) return payload;
    const limit = Math.max(200, Math.min(20000, Number(maxChars)));
    const text = JSON.stringify(payload);
    if (text.length <= limit) return payload;
    return { truncated: true, preview: text.slice(0, limit), maxChars: limit };
}

function truncatePayloadDepth(payload: unknown, maxDepth?: number | null, depth = 0): unknown {
    if (!maxDepth || !Number.isFinite(maxDepth)) return payload;
    const limit = Math.max(1, Math.min(10, Number(maxDepth)));
    if (payload === null || payload === undefined) return payload;
    if (typeof payload !== "object") return payload;
    if (depth >= limit) return { truncated: true, depth: limit };
    if (Array.isArray(payload)) {
        return payload.map(value => truncatePayloadDepth(value, limit, depth + 1));
    }
    const record = payload as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
        next[key] = truncatePayloadDepth(value, limit, depth + 1);
    }
    return next;
}

function isCacheableTool(name: string, args?: unknown): boolean {
    if ([
        "reloadDiscord",
        "evaluateCode",
        "batch_tools",
        "analytics"
    ].includes(name)) {
        return false;
    }

    const params = (args && typeof args === "object") ? (args as Record<string, unknown>) : {};
    const action = typeof params.action === "string" ? params.action : undefined;

    if (name === "dom") return action !== "modify";
    if (name === "flux") return action !== "dispatch";
    if (name === "discord") return action !== "api";
    if (name === "store") return action !== "call" && action !== "diff";
    if (name === "plugin") {
        if (action === "toggle") return false;
        if (action === "settings" && "values" in params) return false;
        return true;
    }
    return true;
}

function shouldCacheResult(value: unknown): boolean {
    if (!value || typeof value !== "object") return true;
    const record = value as Record<string, unknown>;
    if ("error" in record) return false;
    if (record.isError === true) return false;
    if (record.cached === true) return false;
    return true;
}

function getToolCacheTtlMs(name: string): number {
    if (!settings.store.cacheEnabled) return 0;
    return TOOL_CACHE_OVERRIDES.get(name) ?? settings.store.cacheTtlMs ?? TOOL_CACHE_TTL_MS;
}

function cleanupToolCache(): void {
    const maxEntries = settings.store.cacheMaxEntries ?? TOOL_CACHE_MAX_ENTRIES;
    if (toolResponseCache.size <= maxEntries) return;
    const entries = Array.from(toolResponseCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < entries.length - maxEntries; i++) {
        toolResponseCache.delete(entries[i][0]);
    }
}

async function executeWithCache<T>(name: string, args: unknown, compute: () => Promise<T>): Promise<T> {
    if (!settings.store.cacheEnabled || !isCacheableTool(name, args)) return compute();

    const cacheKey = `${name}:${stableStringify(args ?? {})}`;
    const baseTtlMs = getToolCacheTtlMs(name);
    if (baseTtlMs <= 0) return compute();
    const now = Date.now();
    const cached = toolResponseCache.get(cacheKey);
    if (cached && now - cached.timestamp < cached.ttlMs) {
        toolCacheHits++;
        if (cached.value && typeof cached.value === "object") {
            if (Array.isArray(cached.value)) {
                return { cached: true, result: cached.value } as T;
            }
            return { ...(cached.value as Record<string, unknown>), cached: true } as T;
        }
        return { cached: true, result: cached.value } as T;
    }

    const inflight = toolResponseInFlight.get(cacheKey) as Promise<T> | undefined;
    if (inflight) return inflight;

    const task = (async () => {
        const startTime = performance.now();
        const value = await compute();
        const durationMs = Math.max(0, performance.now() - startTime);
        if (shouldCacheResult(value)) {
            const cachedValue = value && typeof value === "object" && "cached" in (value as Record<string, unknown>)
                ? { ...(value as Record<string, unknown>), cached: false }
                : value;
            const adaptiveTtlMs = Math.min(
                120000,
                Math.max(baseTtlMs, Math.round(durationMs * 15))
            );
            toolResponseCache.set(cacheKey, { timestamp: Date.now(), ttlMs: adaptiveTtlMs, value: cachedValue });
            toolCacheStores++;
            cleanupToolCache();
            return cachedValue as T;
        }
        return value;
    })();

    toolResponseInFlight.set(cacheKey, task);
    try {
        return await task;
    } finally {
        toolResponseInFlight.delete(cacheKey);
    }
}

async function searchModulesInternal(args: { kind: string; pattern: string; limit?: number; isRegex?: boolean; }) {
    const kind = String(args.kind || "");
    const pattern = String(args.pattern || "");
    if (!pattern) throw new Error("pattern is required");
    if (kind === "literal") {
        return handleSearchLiteral({
            query: pattern,
            isRegex: args.isRegex ?? false,
            limit: args.limit ?? 20,
            offset: 0
        });
    }
    if (kind === "regex") {
        return handleSearchByPatternAsync({ pattern, limit: args.limit ?? 20 });
    }
    const findTypeMap: Record<string, string> = {
        props: "findByProps",
        code: "findByCode",
        store: "findStore",
        component: "findComponentByCode",
        moduleId: "findModuleId"
    };
    const findType = findTypeMap[kind];
    if (!findType) throw new Error(`Unknown kind: ${kind}`);
    const argsList = pattern.split(",").map(part => part.trim()).filter(Boolean);
    return handleSearch({
        findType,
        args: argsList.map(parseRegexString)
    });
}

async function searchExtractInternal(args: {
    kind: string;
    pattern: string;
    limit?: number;
    searchLimit?: number;
    isRegex?: boolean;
    usePatched?: boolean;
    maxLength?: number;
}) {
    const kind = String(args.kind || "");
    const pattern = String(args.pattern || "");
    if (!pattern) throw new Error("pattern is required");
    const limit = Number(args.limit ?? 3);
    const searchLimit = Number(args.searchLimit ?? 20);
    const usePatched = args.usePatched ?? true;
    const maxLength = Number(args.maxLength ?? 50000);

    let moduleIds: number[] = [];
    if (kind === "literal") {
        const result = await handleSearchLiteral({ query: pattern, isRegex: args.isRegex ?? false, limit: searchLimit, offset: 0 });
        moduleIds = (result.matches ?? []).map((m: { id: number; }) => m.id);
    } else if (kind === "pattern" || kind === "regex") {
        const result = await handleSearchByPatternAsync({ pattern, limit: searchLimit });
        moduleIds = (result.modules ?? []).map((m: { id: number; }) => m.id);
    } else if (kind === "props" || kind === "code") {
        const findType = kind === "props" ? "findByProps" : "findByCode";
        const argsList = pattern.split(",").map(part => part.trim()).filter(Boolean);
        const result = await handleSearch({ findType, args: argsList.map(parseRegexString) });
        if (typeof result.moduleId === "number") {
            moduleIds = [result.moduleId];
        } else if (Array.isArray(result.moduleIds)) {
            moduleIds = result.moduleIds as number[];
        }
    } else {
        throw new Error(`Unsupported kind: ${kind}`);
    }

    const extracted: Array<{ moduleId: number; size: number; truncated: boolean; patchedBy: string[]; preview: string; }> = [];
    for (const moduleId of moduleIds.slice(0, limit)) {
        const result = await handleExtract({ moduleId, usePatched, maxLength });
        extracted.push({
            moduleId: Number(result.moduleId),
            size: result.size,
            truncated: result.truncated ?? false,
            patchedBy: result.patchedBy ?? [],
            preview: result.code?.slice(0, 200) ?? ""
        });
    }
    return { moduleIds: moduleIds.slice(0, limit), extracted };
}

async function getModuleContextInternal(moduleId: number, usePatched: boolean) {
    const [analysis, relationships, exports] = await Promise.all([
        handleAnalyzeModule({ moduleId }),
        handleGetModuleRelationships({ moduleId }),
        handleGetModuleExports({ moduleId })
    ]);
    if ((exports as { error?: string; }).error) {
        throw new Error((exports as { error: string; }).error);
    }
    return {
        summary: {
            moduleId: analysis.moduleId,
            size: analysis.size,
            patchedBy: analysis.patchedBy,
            hasReactComponents: analysis.hasReactComponents,
            hasFluxStore: analysis.hasFluxStore
        },
        context: {
            moduleId: analysis.moduleId,
            size: analysis.size,
            patchedBy: analysis.patchedBy,
            hasReactComponents: analysis.hasReactComponents,
            hasFluxStore: analysis.hasFluxStore,
            exports: (exports as { exports: Record<string, string>; }).exports,
            hasDefaultExport: (exports as { hasDefault: boolean; }).hasDefault,
            isESModule: (exports as { isESModule: boolean; }).isESModule,
            imports: (relationships as { imports: string[]; }).imports,
            usedBy: (relationships as { usedBy: number[]; }).usedBy
        }
    };
}

type BatchToolRequest = {
    id?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
    timeoutMs?: number;
};

function shouldStreamBatch(args: Record<string, unknown>): boolean {
    if (args.stream === false) return false;
    if (args.stream === true) return true;
    const requests = Array.isArray(args.requests) ? (args.requests as BatchToolRequest[]) : [];
    return requests.some(req => typeof req.tool === "string" && expectedSlowTools.has(req.tool));
}

function batchToolsStream(args: Record<string, unknown>): ToolCallResult {
    const requests = Array.isArray(args.requests) ? (args.requests as BatchToolRequest[]) : [];
    const parallelism = Math.max(1, Math.min((args.parallelism as number | undefined) ?? 4, 10));
    const defaultTimeoutMs = Math.max(1000, Math.min((args.timeoutMs as number | undefined) ?? 60000, 120000));
    const pending = [...requests];
    const results: Array<{ id?: string; tool: string; ok: boolean; result?: ToolCallResult; error?: string; timedOut?: boolean; }> = [];
    const summary = { total: pending.length, ok: 0, failed: 0, timedOut: 0, completed: 0, running: true };
    const resourceId = storeResource(JSON.stringify({ summary, results }, null, 2), "application/json");

    const update = () => {
        updateResource(resourceId, JSON.stringify({ summary, results }, null, 2), "application/json");
    };

    const runNext = async () => {
        const request = pending.shift();
        if (!request) return;
        const { tool } = request;
        if (!tool || typeof tool !== "string") {
            results.push({ id: request.id, tool: String(tool), ok: false, error: "tool is required" });
            summary.failed += 1;
            summary.completed += 1;
            update();
            return runNext();
        }
        if (tool === "batch_tools") {
            results.push({ id: request.id, tool, ok: false, error: "batch_tools cannot call itself" });
            summary.failed += 1;
            summary.completed += 1;
            update();
            return runNext();
        }

        const timeoutMs = Math.max(500, Math.min(request.timeoutMs ?? defaultTimeoutMs, 120000));
        try {
            const result = await Promise.race([
                callMcpTool(tool, (request.arguments ?? {}) as Record<string, unknown>),
                new Promise<ToolCallResult>((_, reject) =>
                    setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
                ),
            ]);
            results.push({ id: request.id, tool, ok: !result.isError, result });
            if (result.isError) summary.failed += 1;
            else summary.ok += 1;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const timedOut = /Timed out/.test(message);
            results.push({ id: request.id, tool, ok: false, error: message, timedOut });
            summary.failed += 1;
            if (timedOut) summary.timedOut += 1;
        }
        summary.completed += 1;
        update();
        return runNext();
    };

    const runners = Array.from({ length: Math.min(parallelism, pending.length) }, runNext);
    void Promise.all(runners).then(() => {
        summary.running = false;
        update();
    });

    return buildToolResponse({
        resourceId,
        status: "running",
        total: summary.total,
        stream: true
    });
}

function isToolCallResult(value: unknown): value is ToolCallResult {
    return Boolean(value && typeof value === "object" && "content" in (value as Record<string, unknown>));
}

async function computeToolResult(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
        case "module": {
            const action = String(args.action ?? "find");
            const moduleId = typeof args.moduleId === "number" ? args.moduleId : typeof args.id === "number" ? args.id : undefined;
            if (action === "stats") return handleDebugWebpack();
            if (action === "ids") return handleGetModuleIds({ limit: args.limit });
            if (action === "size") {
                if (typeof moduleId !== "number") throw new Error("moduleId is required for size");
                const analysis = await handleAnalyzeModule({ moduleId });
                const recommendation = analysis.size < 50000
                    ? "module action: extract will return full source"
                    : analysis.size < 100000
                        ? "use module action: extract with maxLength:100000"
                        : "use module action: context or search action: pattern to target a snippet";
                return {
                    moduleId: analysis.moduleId,
                    size: analysis.size,
                    patchedBy: analysis.patchedBy,
                    recommendation
                };
            }
            if (action === "extract") {
                if (typeof moduleId !== "number") throw new Error("moduleId is required for extract");
                const usePatched = toOptionalBoolean(args.usePatched) ?? true;
                return handleExtract({
                    moduleId,
                    usePatched,
                    maxLength: toOptionalNumber(args.maxLength)
                });
            }
            if (action === "exports") {
                if (typeof moduleId !== "number") throw new Error("moduleId is required for exports");
                return handleGetModuleExports({ moduleId });
            }
            if (action === "explain") {
                if (typeof moduleId !== "number") throw new Error("moduleId is required for explain");
                const usePatched = toOptionalBoolean(args.usePatched) ?? true;
                const context = await getModuleContextInternal(moduleId, usePatched);
                const source = extractModule(moduleId, usePatched);
                const anchors = extractAnchorCandidates(source.slice(0, 400));
                return { ...context, anchors };
            }
            if (action === "findStrings") {
                if (typeof moduleId !== "number") throw new Error("moduleId is required for findStrings");
                const usePatched = toOptionalBoolean(args.usePatched) ?? true;
                const source = extractModule(moduleId, usePatched);
                const minLength = Number(args.stringMinLength ?? 4);
                const maxLength = Number(args.stringMaxLength ?? 80);
                const limit = Number(args.limit ?? 20);
                const result = extractStringLiterals(source, minLength, maxLength, limit);
                return { moduleId, ...result };
            }
            if (action === "context") {
                if (args.pattern && typeof moduleId !== "number") {
                    const searchLimit = toOptionalNumber(args.searchLimit) ?? toOptionalNumber(args.limit);
                    return handleModuleContextSearch({
                        pattern: String(args.pattern),
                        isRegex: toOptionalBoolean(args.isRegex) ?? false,
                        limit: searchLimit,
                        matchLimit: toOptionalNumber(args.matchLimit),
                        radius: toOptionalNumber(args.radius),
                        contextLines: toOptionalNumber(args.contextLines)
                    });
                }
                if (typeof moduleId !== "number") throw new Error("moduleId is required for context");
                if (args.pattern) {
                    const usePatched = toOptionalBoolean(args.usePatched) ?? true;
                    return handleModuleContext({
                        moduleId,
                        pattern: String(args.pattern),
                        isRegex: toOptionalBoolean(args.isRegex) ?? false,
                        radius: toOptionalNumber(args.radius),
                        limit: toOptionalNumber(args.limit),
                        contextLines: toOptionalNumber(args.contextLines),
                        usePatched
                    });
                }
                return getModuleContextInternal(moduleId, toOptionalBoolean(args.usePatched) ?? true);
            }
            if (action === "diff") {
                if (typeof moduleId !== "number") throw new Error("moduleId is required for diff");
                return handleDiff({ moduleId });
            }
            if (action === "deps" || action === "relationships") {
                if (typeof moduleId !== "number") throw new Error("moduleId is required for relationships");
                return handleGetModuleRelationships({ moduleId });
            }
            if (Array.isArray(args.props) && args.props.length) {
                if (args.all) return handleFindAll({ props: args.props, limit: args.limit });
                return handleFindByProps({ props: args.props });
            }
            if (Array.isArray(args.code) && args.code.length) {
                return handleFindByCode({ code: args.code });
            }
            if (args.displayName) {
                return handleComponentLocator({
                    query: String(args.displayName),
                    isRegex: toOptionalBoolean(args.isRegex),
                    limit: toOptionalNumber(args.limit)
                });
            }
            if (args.className) {
                return handleSearchLiteral({
                    query: String(args.className),
                    isRegex: toOptionalBoolean(args.isRegex) ?? false,
                    limit: toOptionalNumber(args.limit) ?? 20,
                    offset: toOptionalNumber(args.offset) ?? 0
                });
            }
            if (args.exportName) {
                return handleFindByProps({ props: [String(args.exportName)] });
            }
            if (args.exportValue) {
                return handleSearchLiteral({
                    query: String(args.exportValue),
                    isRegex: false,
                    limit: args.limit ?? 20,
                    offset: args.offset ?? 0
                });
            }
            if (args.pattern && args.kind) {
                return searchModulesInternal({
                    kind: String(args.kind),
                    pattern: String(args.pattern),
                    limit: toOptionalNumber(args.limit),
                    isRegex: toOptionalBoolean(args.isRegex)
                });
            }
            if (args.pattern) {
                return handleSearchByPatternAsync({ pattern: String(args.pattern), limit: toOptionalNumber(args.limit) });
            }
            throw new Error("Specify action or search criteria");
        }
        case "store": {
            const action = String(args.action ?? ((args.name || args.storeName) ? "state" : "list"));
            const storeName = String(args.storeName ?? args.name ?? "");
            if (action === "list") {
                return handleGetStores({
                    filter: toOptionalString(args.filter),
                    limit: toOptionalNumber(args.limit),
                    offset: toOptionalNumber(args.offset)
                });
            }
            if (action === "find") {
                if (!storeName) throw new Error("store name is required");
                return handleFindStore({ name: storeName });
            }
            if (!storeName) throw new Error("store name is required");
            if (action === "subscriptions") {
                return handleGetStoreSubscriptions({ storeName, limit: toOptionalNumber(args.limit) });
            }
            if (action === "methods") return handleGetStoreMethods({ storeName });
            if (action === "diff") return handleStoreDiff({ storeName, limit: toOptionalNumber(args.limit) });
            if (action === "state" || action === "call") {
                return handleGetStoreState({
                    storeName,
                    method: toOptionalString(args.method),
                    args: args.args
                });
            }
            throw new Error(`Unknown store action: ${action}`);
        }
        case "intl": {
            const action = String(args.action ?? (args.key ? "hash" : args.hash ? "reverse" : args.query ? "search" : "scan"));
            if (action === "hash") {
                if (!args.key) throw new Error("key is required");
                return handleIntlHash({ key: String(args.key) });
            }
            if (action === "reverse") {
                if (!args.hash) throw new Error("hash is required");
                return handleReverseIntlHash({ hashedKey: String(args.hash) });
            }
            if (action === "search") {
                if (!args.query) throw new Error("query is required");
                return handleGetIntlKeys({ filter: String(args.query), limit: toOptionalNumber(args.limit) });
            }
            if (action === "scan") {
                if (typeof args.moduleId !== "number") throw new Error("moduleId is required");
                return handleSearchIntlInModule({ moduleId: args.moduleId });
            }
            if (action === "targets") {
                if (!args.key) throw new Error("key is required");
                return handleIntlTargets({ key: String(args.key), limit: args.limit });
            }
            throw new Error(`Unknown intl action: ${action}`);
        }
        case "flux": {
            const action = String(args.action ?? "events");
            if (action === "events") return handleGetFluxEvents({ filter: args.filter });
            if (action === "types") return handleDispatcherActions({ filter: args.filter, isRegex: args.isRegex });
            if (action === "dispatch") {
                if (!args.type) throw new Error("type is required for dispatch");
                return handleDispatchFlux({ action: { type: String(args.type), ...(args.payload ?? {}) } });
            }
            if (action === "listeners") {
                return handleDispatcherActions({ filter: args.event ?? args.filter, isRegex: args.isRegex });
            }
            throw new Error(`Unknown flux action: ${action}`);
        }
        case "patch": {
            const action = String(args.action ?? "unique");
            if (action === "test") {
                if (!args.find) throw new Error("find is required");
                const replacements = Array.isArray(args.replacements) && args.replacements.length
                    ? args.replacements
                    : args.match
                        ? [{ match: String(args.match), replace: String(args.replace ?? "") }]
                        : [];
                if (!replacements.length) throw new Error("replacements or match is required");
                return handleTestPatch({ find: args.find, replacements });
            }
            if (action === "lint") {
                if (!args.find) throw new Error("find is required");
                const replacements = Array.isArray(args.replacements) && args.replacements.length
                    ? args.replacements
                    : args.match
                        ? [{ match: String(args.match), replace: String(args.replace ?? "") }]
                        : [];
                if (!replacements.length) throw new Error("replacements or match is required");
                return handlePatchLint({ find: args.find, replacements });
            }
            if (action === "overlap") {
                const moduleId = typeof args.moduleId === "number" ? args.moduleId : typeof args.id === "number" ? args.id : undefined;
                return handlePatchOverlapByFind({ moduleId, find: args.find });
            }
            if (action === "unique") {
                const query = args.find ?? args.brokenFind;
                if (!query) throw new Error("find is required");
                const result = await handleSearchLiteral({
                    query: String(query),
                    isRegex: false,
                    limit: toOptionalNumber(args.limit) ?? 50,
                    offset: 0
                });
                const uniques = (result.matches ?? []).filter((m: { occurrences?: number; }) => m.occurrences === 1);
                return { query, uniqueCount: uniques.length, matches: uniques };
            }
            if (action === "analyze") {
                if (!args.pluginName) throw new Error("pluginName is required");
                return handleGetPatchedModulesAsync({ pluginName: args.pluginName });
            }
            if (action === "plugin") {
                const resolved = resolvePluginName(
                    toOptionalString(args.pluginName) ?? toOptionalString(args.pluginId) ?? toOptionalString(args.name)
                );
                if (!resolved) throw new Error("plugin name is required");
                return handleGetPluginPatches({ pluginName: resolved });
            }
            if (action === "suggest") {
                const pattern = args.brokenFind ?? args.find;
                if (!pattern) throw new Error("brokenFind or find is required");
                return handleFindPatchTargets({ pattern: String(pattern), maxResults: toOptionalNumber(args.limit) });
            }
            throw new Error(`Unknown patch action: ${action}`);
        }
        case "dom": {
            const action = String(args.action ?? "inspect");
            if (action === "query") return handleQueryDom(args);
            if (action === "styles") return handleGetElementStyles(args);
            if (action === "modify") return handleModifyElement(args);
            if (action === "tree") return handleGetComponentTree(args);
            if (action === "classes") return handleListDomClasses(args);
            if (action === "text") return handleFindTextNodes({ query: args.query, isRegex: args.isRegex, maxResults: args.maxResults, maxTextLength: args.maxTextLength });
            if (action === "path") return handleInspectDomPath(args);
            if (action === "snapshot") return handleDomSnapshot(args);
            if (!args.selector) throw new Error("selector is required");
            return handleQueryDom({ selector: args.selector, limit: 1, includeText: args.includeText, includeAttrs: args.includeAttrs, maxTextLength: args.maxTextLength });
        }
        case "discord": {
            const action = String(args.action ?? "context");
            if (action === "context") return handleGetCurrentContext();
            if (action === "ready") return handleWaitForReady(args);
            if (action === "waitForIpc") return handleWaitForIpc(args);
            if (action === "api") return handleCallRestApi(args);
            if (action === "snowflake") return handleDecodeSnowflake({ snowflake: args.snowflake });
            if (action === "endpoints") return handleGetEndpoints(args);
            if (action === "common") return handleGetCommonModules();
            if (action === "stores") return handleGetStores({ filter: args.filter, limit: args.limit, offset: args.offset });
            if (action === "memory") return handleMemoryUsage();
            if (action === "performance") return handlePerformanceMetrics();
            if (action === "enum") {
                const query = args.queryEnum ?? args.query ?? args.filter;
                if (!query) throw new Error("query is required");
                return handleFindEnum({
                    query: String(query),
                    limit: toOptionalNumber(args.limit),
                    includeMembers: Boolean(args.includeMembers)
                });
            }
            throw new Error(`Unknown discord action: ${action}`);
        }
        case "analytics": {
            return handleAnalytics(args);
        }
        case "plugin": {
            const action = String(args.action ?? "list");
            if (action === "list") {
                return handleGetPluginList({
                    filter: toOptionalString(args.name),
                    showPatches: toOptionalBoolean(args.showPatches)
                });
            }
            if (action === "info") {
                const resolved = resolvePluginName(
                    toOptionalString(args.pluginId) ?? toOptionalString(args.pluginName) ?? toOptionalString(args.name)
                );
                if (!resolved) throw new Error("plugin name is required");
                return handleGetPluginInfo({ pluginName: resolved });
            }
            if (action === "patches") {
                const resolved = resolvePluginName(
                    toOptionalString(args.pluginName) ?? toOptionalString(args.pluginId) ?? toOptionalString(args.name)
                );
                if (!resolved) throw new Error("plugin name is required");
                return handleGetPluginPatches({ pluginName: resolved });
            }
            if (action === "toggle") return handleTogglePlugin(args);
            if (action === "enable") {
                return handleTogglePlugin({
                    pluginName: toOptionalString(args.pluginName) ?? toOptionalString(args.pluginId) ?? toOptionalString(args.name),
                    enabled: true
                });
            }
            if (action === "disable") {
                return handleTogglePlugin({
                    pluginName: toOptionalString(args.pluginName) ?? toOptionalString(args.pluginId) ?? toOptionalString(args.name),
                    enabled: false
                });
            }
            if (action === "settings") {
                const resolved = resolvePluginName(
                    toOptionalString(args.pluginId) ?? toOptionalString(args.pluginName) ?? toOptionalString(args.name)
                );
                if (!resolved) throw new Error("plugin name is required");
                const mode = args.values ? "set" : "get";
                return handlePluginSettings({ pluginId: resolved, action: mode, values: args.values });
            }
            if (action === "setSetting") {
                const resolved = resolvePluginName(
                    toOptionalString(args.pluginId) ?? toOptionalString(args.pluginName) ?? toOptionalString(args.name)
                );
                if (!resolved) throw new Error("plugin name is required");
                return handlePluginSettings({ pluginId: resolved, action: "set", values: args.values ?? {} });
            }
            throw new Error(`Unknown plugin action: ${action}`);
        }
        case "component": {
            const action = String(args.action ?? "find");
            if (action === "find") {
                if (Array.isArray(args.code) && args.code.length) {
                    return handleSearch({ findType: "findComponentByCode", args: args.code.map(parseRegexString) });
                }
                throw new Error("code is required");
            }
            if (action === "inspect") {
                if (!args.selector) throw new Error("selector is required");
                return handleGetComponentTree({ selector: String(args.selector), maxDepth: args.maxDepth });
            }
            if (action === "tree") {
                if (!args.selector) throw new Error("selector is required");
                return handleGetComponentTreeDetailed({
                    selector: String(args.selector),
                    maxDepth: args.maxDepth,
                    maxBreadth: args.maxBreadth
                });
            }
            throw new Error(`Unknown component action: ${action}`);
        }
        case "search": {
            const action = String(args.action ?? "literal");
            if (action === "extract") {
                if (!args.kind || !args.pattern) throw new Error("kind and pattern are required");
                return searchExtractInternal({
                    kind: String(args.kind),
                    pattern: String(args.pattern),
                    limit: toOptionalNumber(args.limit),
                    searchLimit: toOptionalNumber(args.searchLimit),
                    isRegex: toOptionalBoolean(args.isRegex),
                    usePatched: toOptionalBoolean(args.usePatched),
                    maxLength: toOptionalNumber(args.maxLength)
                });
            }
            if (action === "context") {
                if (!args.pattern) throw new Error("pattern is required");
                return handleSearchContext({
                    pattern: String(args.pattern),
                    isRegex: toOptionalBoolean(args.isRegex) ?? false,
                    limit: toOptionalNumber(args.limit),
                    matchLimit: toOptionalNumber(args.matchLimit),
                    radius: toOptionalNumber(args.radius),
                    contextLines: toOptionalNumber(args.contextLines)
                });
            }
            if (!args.pattern) throw new Error("pattern is required");
            if (action === "literal") {
                return handleSearchLiteral({
                    query: args.pattern,
                    isRegex: toOptionalBoolean(args.isRegex) ?? false,
                    limit: toOptionalNumber(args.limit) ?? 20,
                    offset: toOptionalNumber(args.offset) ?? 0,
                    preset: args.preset
                });
            }
            if (action === "regex" || action === "pattern") {
                return handleSearchByPatternAsync({ pattern: args.pattern, limit: toOptionalNumber(args.limit) });
            }
            if (["props", "code", "store", "component", "moduleId"].includes(action)) {
                return searchModulesInternal({
                    kind: action,
                    pattern: String(args.pattern),
                    limit: toOptionalNumber(args.limit),
                    isRegex: toOptionalBoolean(args.isRegex)
                });
            }
            throw new Error(`Unknown search action: ${action}`);
        }
        case "trace": {
            const action = String(args.action ?? "get");
            return handleTrace({ ...args, action } as TraceRequest);
        }
        case "intercept": {
            const action = String(args.action ?? "get");
            return handleIntercept({ ...args, action } as InterceptRequest);
        }
        case "testPatch":
            return handleTestPatch(args);
        case "reloadDiscord":
            return handleReload();
        case "evaluateCode":
            return handleEvaluateCode(args);
        case "read_resource":
            return readResource(String(args.resourceId), args.offset as number | undefined, args.length as number | undefined);
        case "batch_tools": {
            const requests = Array.isArray(args.requests) ? args.requests as Array<Record<string, unknown>> : [];
            const results: Array<{ id?: string; tool: string; ok: boolean; result?: ToolCallResult; error?: string; }> = [];
            for (const request of requests) {
                const tool = String(request.tool ?? "");
                if (!tool) {
                    results.push({ id: String(request.id ?? ""), tool: "", ok: false, error: "tool is required" });
                    continue;
                }
                if (tool === "batch_tools") {
                    results.push({ id: request.id as string | undefined, tool, ok: false, error: "batch_tools cannot call itself" });
                    continue;
                }
                try {
                    const result = await callMcpTool(tool, (request.arguments ?? {}) as Record<string, unknown>);
                    results.push({ id: request.id as string | undefined, tool, ok: !result.isError, result });
                } catch (error) {
                    results.push({ id: request.id as string | undefined, tool, ok: false, error: error instanceof Error ? error.message : String(error) });
                }
            }
            return { results };
        }
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

async function callMcpToolRaw(name: string, args: Record<string, unknown>): Promise<unknown> {
    return executeWithCache(name, args, () => computeToolResult(name, args));
}

async function callMcpTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    if (name === "batch_tools" && shouldStreamBatch(args)) {
        return batchToolsStream(args);
    }
    try {
        const result = await callMcpToolRaw(name, args);
        if (isToolCallResult(result)) return result;
        return buildToolResponse(result, args);
    } catch (error) {
        return buildErrorResponse(error instanceof Error ? error.message : String(error), name);
    }
}

const MCP_TOOL_HANDLERS: Record<string, MessageHandler> = {
    module: data => callMcpTool("module", data as Record<string, unknown>),
    store: data => callMcpTool("store", data as Record<string, unknown>),
    intl: data => callMcpTool("intl", data as Record<string, unknown>),
    flux: data => callMcpTool("flux", data as Record<string, unknown>),
    patch: data => callMcpTool("patch", data as Record<string, unknown>),
    dom: data => callMcpTool("dom", data as Record<string, unknown>),
    discord: data => callMcpTool("discord", data as Record<string, unknown>),
    plugin: data => callMcpTool("plugin", data as Record<string, unknown>),
    component: data => callMcpTool("component", data as Record<string, unknown>),
    search: data => callMcpTool("search", data as Record<string, unknown>),
    trace: data => callMcpTool("trace", data as Record<string, unknown>),
    intercept: data => callMcpTool("intercept", data as Record<string, unknown>),
    analytics: data => callMcpTool("analytics", data as Record<string, unknown>),
    evaluateCode: data => callMcpTool("evaluateCode", data as Record<string, unknown>),
    read_resource: data => callMcpTool("read_resource", data as Record<string, unknown>),
    reloadDiscord: data => callMcpTool("reloadDiscord", data as Record<string, unknown>),
    waitForIpc: data => callMcpTool("waitForIpc", data as Record<string, unknown>),
    testPatch: data => callMcpTool("testPatch", data as Record<string, unknown>),
    batch_tools: data => callMcpTool("batch_tools", data as Record<string, unknown>)
};

async function handleMcpRequest(request: MCPRequest): Promise<MCPResponse> {
    switch (request.method) {
        case "initialize":
            return {
                jsonrpc: "2.0",
                id: request.id ?? null,
                result: {
                    protocolVersion: "2024-11-05",
                    capabilities: { tools: {} },
                    serverInfo: { name: "devcompanion-embedded", version: "1.0.0" }
                }
            };
        case "notifications/initialized":
            return { jsonrpc: "2.0", id: request.id ?? null, result: {} };
        case "tools/list":
            return { jsonrpc: "2.0", id: request.id ?? null, result: { tools: getMcpTools(Object.keys(MCP_TOOL_HANDLERS)) } };
        case "tools/call": {
            const params = request.params as { name: string; arguments?: Record<string, unknown>; };
            const toolResult = await callMcpTool(params.name, params.arguments ?? {});
            return { jsonrpc: "2.0", id: request.id ?? null, result: toolResult };
        }
        default:
            return {
                jsonrpc: "2.0",
                id: request.id ?? null,
                error: { code: -32601, message: `Method not found: ${request.method}` }
            };
    }
}

export function startMcpIpcBridge() {
    if (mcpIpcActive) return;
    if (settings.store.prebuildSearchIndex) {
        void ModuleSearchEngine.ensureTokenIndex();
    }
    if (settings.store.prebuildPatchIndex) {
        void buildPatchIndex();
    }
    startWarmupTasks("ipc");
    if (!Native?.getNextRequest || !Native?.sendResponse) return;
    mcpIpcLoopActive = true;
    const poll = async () => {
        while (mcpIpcLoopActive) {
            let next: { id: number; request: MCPRequest; } | null = null;
            try {
                next = await Native.getNextRequest();
            } catch (error) {
                logger.warn(`IPC MCP polling failed: ${String(error)}`);
                await new Promise(resolve => setTimeout(resolve, 100));
                continue;
            }
            if (!next) {
                await new Promise(resolve => setTimeout(resolve, 25));
                continue;
            }

            const startTime = performance.now();
            const { request } = next;
            let toolName: string | undefined;
            let toolArgs: Record<string, unknown> | undefined;

            if (request.method === "tools/call") {
                const params = request.params as { name?: string; arguments?: Record<string, unknown>; } | undefined;
                toolName = params?.name;
                toolArgs = params?.arguments;
                if (toolName) logger.info(`MCP tool called: ${toolName} (ipc)`);
            }

            let response: MCPResponse;
            try {
                response = await handleMcpRequest(request);
            } catch (error) {
                response = {
                    jsonrpc: "2.0",
                    id: request.id ?? null,
                    error: { code: -32000, message: error instanceof Error ? error.message : String(error) }
                };
            }

            if (toolName) {
                const toolResult = response.result as ToolCallResult | undefined;
                const errorMessage = response.error?.message
                    ?? (toolResult?.isError ? toolResult.content?.[0]?.text : undefined);
                logToolResult({
                    type: toolName,
                    requestData: toolArgs,
                    startTime,
                    error: errorMessage,
                    responseData: toolResult
                });
            }

            try {
                await Native.sendResponse(next.id, response);
            } catch (error) {
                logger.warn(`IPC MCP response failed: ${String(error)}`);
            }
        }
    };

    void poll();
    mcpIpcActive = true;
}

export function stopMcpIpcBridge() {
    if (!mcpIpcActive) return;
    mcpIpcLoopActive = false;
    mcpIpcActive = false;
    warmupStarted = false;
}

export function stopWs() {
    if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
    }
    for (const state of connections.values()) {
        if (state.reconnectTimeout) {
            clearTimeout(state.reconnectTimeout);
            state.reconnectTimeout = undefined;
        }
        state.reconnectAttempts = 0;
        state.socket?.close(1000, "Plugin Stopped");
        state.socket = undefined;
    }
    connections.clear();
    sockets.clear();

    moduleCache.clear();
    ModuleSearchEngine.clearCache();
    patchIndex.entries = [];
    patchIndex.ready = false;
    patchIndex.disabled = false;
    patchIndex.inFlight = null;
    toolResponseCache.clear();
    toolResponseInFlight.clear();
    stopTrace();
    clearIntercepts();
    warmupStarted = false;
}

function getCacheKey(id: PropertyKey, patched: boolean): string {
    return `${String(id)}:${patched}`;
}

function extractModule(id: PropertyKey, patched = true): string {
    const cacheKey = getCacheKey(id, patched);
    const cached = moduleCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        cacheHits++;
        return cached.code;
    }

    let code: string;

    if (patched) {
        const patchedSource = getFactoryPatchedSource(id);
        if (patchedSource) {
            code = patchedSource;
        } else if (!wreq.m[id]) {
            throw new Error(`Module not found for id: ${String(id)}`);
        } else {
            code = `0,${wreq.m[id]}\n`;
        }
    } else {
        if (!wreq.m[id]) {
            throw new Error(`Module not found for id: ${String(id)}`);
        }
        code = `0,${wreq.m[id]}\n`;
    }

    if (code.length <= MAX_CODE_LENGTH) {
        moduleCache.set(cacheKey, { code, timestamp: Date.now() });
    }

    if (moduleCache.size > 100) {
        const now = Date.now();
        const toDelete: string[] = [];
        for (const [key, value] of moduleCache.entries()) {
            if (now - value.timestamp > CACHE_TTL) {
                toDelete.push(key);
            }
        }
        toDelete.forEach(key => moduleCache.delete(key));

        if (moduleCache.size > 100) {
            const keys = Array.from(moduleCache.keys());
            for (let i = 0; i < 50; i++) {
                moduleCache.delete(keys[i]);
            }
        }
    }

    return code;
}

function getModulePatchedBy(id: PropertyKey, usePatched = true): string[] {
    return [...(usePatched && getFactoryPatchedBy(id)) || []];
}

async function findModuleIdAsync(code: string): Promise<number | { multiple: number[]; count: number; }> {
    const matches: number[] = [];
    const codeSnippet = code.substring(0, Math.min(code.length, 200));

    for await (const { id } of ModuleSearchEngine.searchPattern(codeSnippet)) {
        matches.push(Number(id));
        if (matches.length >= 50) break;
    }

    if (matches.length === 0) {
        return { multiple: [], count: 0 };
    }

    if (matches.length === 1) {
        return matches[0];
    }

    logger.warn(`Found ${matches.length} modules, returning all matches`);
    return { multiple: matches, count: matches.length };
}

function findModuleIdFast(code: string): number | null {
    const codeSnippet = code.substring(0, Math.min(code.length, 100));
    const moduleIds = Object.keys(wreq.m);

    for (const id of moduleIds) {
        const moduleCode = wreq.m[id]?.toString();
        if (moduleCode && moduleCode.includes(codeSnippet)) {
            return Number(id);
        }
    }

    return null;
}

function parseRegex(pattern: string, flags: string): RegExp {
    return new RegExp(pattern, flags);
}

function parseRegexArg(arg: string | { pattern: string; flags: string; }): string | RegExp {
    if (typeof arg === "object" && arg && "pattern" in arg) {
        return parseRegex(arg.pattern, arg.flags);
    }
    if (typeof arg === "string" && arg.startsWith("/") && arg.lastIndexOf("/") > 0) {
        const lastSlash = arg.lastIndexOf("/");
        const pattern = arg.substring(1, lastSlash);
        const flags = arg.substring(lastSlash + 1);
        try {
            return parseRegex(pattern, flags);
        } catch {
            return arg;
        }
    }
    return arg;
}

function resolvePluginName(input?: string): string {
    const raw = input?.trim();
    if (!raw) return "";
    const plugins = Vencord.Plugins.plugins as Record<string, unknown>;
    if (plugins[raw]) return raw;
    const lower = raw.toLowerCase();
    const match = Object.keys(plugins).find(name => name.toLowerCase() === lower);
    return match ?? raw;
}

function togglePlugin(pluginName: string): void {
    const plugin = Vencord.Plugins.plugins[pluginName];
    if (!plugin) {
        throw new Error(`Plugin "${pluginName}" not found`);
    }

    const pluginSettings = Settings.plugins[plugin.name];
    const wasEnabled = pluginSettings.enabled ?? false;

    if (!wasEnabled) {
        const { failures } = Vencord.Plugins.startDependenciesRecursive(plugin);
        if (failures.length) {
            throw new Error(`Failed to start dependencies: ${failures.join(", ")}`);
        }
    }

    if (plugin.patches?.length) {
        pluginSettings.enabled = !wasEnabled;
        throw new Error("Plugin has patches - reload required");
    }

    if (wasEnabled && !plugin.started) {
        pluginSettings.enabled = !wasEnabled;
        return;
    }

    const result = wasEnabled
        ? Vencord.Plugins.stopPlugin(plugin)
        : Vencord.Plugins.startPlugin(plugin);

    if (!result) {
        pluginSettings.enabled = false;
        throw new Error(`Error while ${wasEnabled ? "stopping" : "starting"} plugin`);
    }

    pluginSettings.enabled = !wasEnabled;
}

async function handleSearch(requestData: unknown) {
    const startTime = performance.now();
    const { findType, args } = requestData as SearchRequest;

    const parsedArgs = args.map(arg => {
        if (arg.type === "regex") {
            return parseRegex(arg.value.pattern, arg.value.flags);
        }
        return arg.value;
    });

    let results: unknown[];

    switch (findType) {
        case "findByProps":
            results = findAll(filters.byProps(...(parsedArgs as string[])));
            break;
        case "findByCode":
            results = findAll(filters.byCode(...(parsedArgs as Array<string | RegExp>)));
            break;
        case "findStore":
            results = findAll(filters.byStoreName(parsedArgs[0] as string));
            break;
        case "findComponentByCode":
            results = findAll(filters.componentByCode(...(parsedArgs as Array<string | RegExp>)));
            break;
        case "findModuleId":
            results = Object.keys(search(parsedArgs[0] as string | RegExp)).map(id => wreq.m[id]);
            break;
        default:
            logger.error(`Unknown find type: ${findType}`);
            return { error: `Unknown find type: ${findType}` };
    }

    const uniqueResults = [...new Set(results)];
    const time = Math.round(performance.now() - startTime);

    if (uniqueResults.length === 0) {
        logger.warn(`No results found for ${findType} (${time}ms)`);
        return {
            warning: "No results found",
            findType,
            args: parsedArgs,
            time
        };
    }

    if (uniqueResults.length > 1) {
        logger.warn(`Found ${uniqueResults.length} results for ${findType} (${time}ms)`);
        const moduleIds: number[] = [];

        for (const result of uniqueResults.slice(0, 10)) {
            const code = (result as { toString(): string; }).toString();
            const id = await findModuleIdAsync(code);
            if (typeof id === "number") {
                moduleIds.push(id);
            }
        }

        return {
            warning: `Found ${uniqueResults.length} results`,
            findType,
            args: parsedArgs,
            moduleIds,
            count: uniqueResults.length,
            time
        };
    }

    const foundCode = (uniqueResults[0] as { toString(): string; }).toString();
    const moduleId = await findModuleIdAsync(foundCode);

    if (typeof moduleId !== "number") {
        logger.warn(`Multiple module IDs found: ${moduleId.count} (${time}ms)`);
        return {
            warning: "Multiple modules contain this code",
            moduleIds: moduleId.multiple,
            count: moduleId.count,
            time
        };
    }

    logger.info(`Found module ${moduleId} for ${findType} (${time}ms)`);

    return {
        moduleId,
        code: extractModule(moduleId),
        patchedBy: getModulePatchedBy(moduleId),
        time
    };
}

function handleExtract(requestData: unknown) {
    const { moduleId, usePatched, maxLength } = requestData as ExtractRequest;
    const source = extractModule(moduleId, usePatched ?? true);
    const limit = Math.min(maxLength ?? 50000, 100000);
    return {
        moduleId,
        code: source.slice(0, limit),
        patchedBy: getModulePatchedBy(moduleId, usePatched ?? true),
        size: source.length,
        truncated: source.length > limit,
        maxLength: limit
    };
}

function handleDiff(requestData: unknown) {
    const { moduleId } = requestData as DiffRequest;

    return {
        moduleId,
        original: extractModule(moduleId, false),
        patched: extractModule(moduleId, true),
        patchedBy: getModulePatchedBy(moduleId, true)
    };
}

function handleList() {
    return {
        modules: Object.keys(wreq.m)
    };
}

function handleTestPatch(requestData: unknown) {
    const { find, replacements, preview, previewMode = "compact", contextLines = 2, radius = 120 } = requestData as TestPatchRequest;
    if (!find) {
        throw new Error("find is required");
    }
    if (!Array.isArray(replacements) || replacements.length === 0) {
        throw new Error("replacements array is required");
    }

    const findPattern = parseRegexArg(find);
    const candidates = search(findPattern);
    const keys = Object.keys(candidates);

    if (keys.length !== 1) {
        throw new Error(`Expected exactly 1 match, found ${keys.length}`);
    }

    const rawSrc = String(candidates[keys[0]]);
    const flatOriginal = rawSrc.replaceAll("\n", "");
    let src = flatOriginal;
    const moduleId = Number(keys[0]);
    const clampContextLines = Math.max(0, Math.min(10, Number(contextLines ?? 2)));
    const clampRadius = Math.max(20, Math.min(500, Number(radius ?? 120)));
    const previews: Array<{
        index: number;
        match: string;
        before?: string;
        after?: string;
        context?: { before: string[]; current: string; after: string[]; line: number; };
        line?: number;
        column?: number;
    }> = [];

    if (src.startsWith("function(")) {
        src = "0," + src;
    }

    for (let i = 0; i < replacements.length; i++) {
        const { match, replace } = replacements[i];
        const matchPattern = parseRegexArg(match);
        const matcher = canonicalizeMatch(matchPattern);
        const newSource = src.replace(matcher, replace);

        if (src === newSource) {
            const context = getMatchContext(rawSrc, matchPattern, clampContextLines, clampRadius);
            return {
                success: false,
                error: `Replacement ${i + 1} had no effect`,
                moduleId,
                failedReplacement: {
                    index: i + 1,
                    match: String(match),
                    context
                }
            };
        }

        try {
            Function(newSource);
        } catch (error) {
            return {
                success: false,
                error: String(error),
                moduleId,
                failedReplacement: {
                    index: i + 1,
                    match: String(match),
                    context: getMatchContext(rawSrc, matchPattern, clampContextLines, clampRadius)
                }
            };
        }

        if (preview) {
            const rawContext = getMatchContext(rawSrc, matchPattern, clampContextLines, clampRadius);
            const flatContext = rawContext.found
                ? rawContext
                : getMatchContext(flatOriginal, matchPattern, clampContextLines, clampRadius);
            const item: {
                index: number;
                match: string;
                before?: string;
                after?: string;
                context?: { before: string[]; current: string; after: string[]; line: number; };
                line?: number;
                column?: number;
            } = {
                index: i + 1,
                match: trimPreviewText(String(match))
            };
            if ((previewMode === "full" || previewMode === "context-only") && flatContext.found) {
                if (previewMode === "context-only") {
                    item.context = flatContext.context;
                    if (rawContext.found) {
                        item.line = rawContext.line;
                        item.column = rawContext.column;
                    }
                } else {
                    const anchorIndex = findLookbehindAnchor(flatOriginal, matchPattern) ?? flatContext.index ?? 0;
                    const matchLen = flatContext.matchLength ?? 0;
                    item.before = flatOriginal.slice(
                        Math.max(0, anchorIndex - clampRadius),
                        Math.min(flatOriginal.length, anchorIndex + matchLen + clampRadius)
                    );
                    item.after = newSource.slice(
                        Math.max(0, anchorIndex - clampRadius),
                        Math.min(newSource.length, anchorIndex + matchLen + clampRadius)
                    );
                    item.context = flatContext.context;
                    if (rawContext.found) {
                        item.line = rawContext.line;
                        item.column = rawContext.column;
                    }
                }
            }
            previews.push(item);
        }

        src = newSource;
    }

    const warnings = collectPatchWarnings(src, replacements);
    let suggestions: { anchors: string[]; } | undefined;
    try {
        const findContext = getMatchContext(rawSrc, findPattern, clampContextLines, clampRadius);
        if (findContext.found) {
            const snippet = [findContext.context?.before?.join(" "), findContext.context?.current, findContext.context?.after?.join(" ")].filter(Boolean).join(" ");
            const anchors = extractAnchorCandidates(snippet);
            if (anchors.length) suggestions = { anchors };
        }
    } catch { }
    return {
        success: true,
        warnings: warnings.length ? warnings : undefined,
        previews: preview ? previews : undefined,
        suggestions
    };
}

function analyzePatternQuality(pattern: string) {
    const warnings: string[] = [];
    const anchors: string[] = [];
    let score = 5;
    const captureGroups = (pattern.match(/\((?!\?)/g) ?? []).length;

    if (/#\{intl::/.test(pattern)) {
        anchors.push("intl");
        score += 3;
    }
    if (/"[^"]{3,}"/.test(pattern) || /'[^']{3,}'/.test(pattern)) {
        anchors.push("string-literal");
        score += 2;
    }
    if (/[A-Za-z_$][\w$]*:/.test(pattern)) {
        anchors.push("prop-name");
        score += 2;
    }
    if (/\\i/.test(pattern)) {
        anchors.push("identifier");
        score += 1;
    }

    if (/\b(function|return|if|for|while|const|let)\b/.test(pattern)) {
        warnings.push("Anchored on generic keywords; prefer stable strings or props.");
        score -= 2;
    }
    if (/\.\+\?|\.\*\?|\.\+|\.\*/.test(pattern)) {
        warnings.push("Uses unbounded wildcards; prefer explicit .{0,N} limits.");
        score -= 1;
    }
    if (pattern.length > 200) {
        warnings.push("Pattern is long; consider a shorter, more stable anchor.");
        score -= 1;
    }
    if (captureGroups > 3) {
        warnings.push("Many capture groups; consider reducing captures to simplify the patch.");
        score -= 1;
    }
    if (!anchors.length) {
        warnings.push("No strong anchors detected; consider an intl key or unique string.");
        score -= 1;
    }

    score = Math.max(1, Math.min(10, score));
    return { score, anchors, warnings, captureGroups, anchorCount: anchors.length };
}

function extractAnchorCandidates(snippet: string) {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const push = (value: string) => {
        if (!value || seen.has(value)) return;
        seen.add(value);
        candidates.push(value);
    };

    for (const match of snippet.matchAll(/#\{intl::[A-Z0-9_]+\}/g)) {
        push(match[0]);
    }
    for (const match of snippet.matchAll(/(["'])([^"'\\]{4,60})\1/g)) {
        const value = match[0];
        if (value.includes(" ")) continue;
        push(value);
    }
    for (const match of snippet.matchAll(/\b[A-Za-z_$][\w$]*:/g)) {
        push(match[0]);
    }

    return candidates.slice(0, 6);
}

function extractStringLiterals(source: string, minLength = 4, maxLength = 80, limit = 20) {
    const counts = new Map<string, number>();
    const regex = /(["'])([^"'\\]{4,80})\1/g;
    for (const match of source.matchAll(regex)) {
        const value = match[2];
        if (value.length < minLength || value.length > maxLength) continue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const items = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([value, count]) => ({ value, count }));
    return { items, totalUnique: counts.size };
}

function handlePatchLint(requestData: unknown) {
    const { find, replacements, moduleId } = requestData as PatchLintRequest;
    if (!find) {
        throw new Error("find is required");
    }
    if (!Array.isArray(replacements) || replacements.length === 0) {
        throw new Error("replacements array is required");
    }

    const findText = typeof find === "string" ? find : `/${find.pattern}/${find.flags ?? ""}`;
    const findAnalysis = analyzePatternQuality(findText);
    const replacementAnalyses = replacements.map((replacement, index) => {
        const pattern = typeof replacement.match === "string"
            ? replacement.match
            : `/${replacement.match.pattern}/${replacement.match.flags ?? ""}`;
        return {
            index: index + 1,
            pattern,
            ...analyzePatternQuality(pattern)
        };
    });

    const scores = [findAnalysis.score, ...replacementAnalyses.map(r => r.score)];
    const overallScore = Math.max(1, Math.min(10, Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)));
    const warnings = [
        ...findAnalysis.warnings,
        ...replacementAnalyses.flatMap(r => r.warnings),
        ...(replacements.length > 1 ? ["Patch has multiple replacements; consider simplifying to reduce break risk."] : [])
    ];

    let suggestions: { anchors: string[]; } | undefined;
    if (typeof moduleId === "number") {
        try {
            const source = extractModule(moduleId, true);
            const findPattern = parseRegexArg(find);
            let index = -1;
            let matchLength = 0;
            if (findPattern instanceof RegExp) {
                findPattern.lastIndex = 0;
                const match = findPattern.exec(source);
                if (match) {
                    index = match.index;
                    matchLength = match[0].length;
                }
            } else {
                index = source.indexOf(findPattern);
                matchLength = typeof findPattern === "string" ? findPattern.length : 0;
            }
            if (index >= 0) {
                const start = Math.max(0, index - 120);
                const end = Math.min(source.length, index + matchLength + 120);
                const snippet = source.slice(start, end);
                const anchors = extractAnchorCandidates(snippet);
                if (anchors.length) suggestions = { anchors };
            }
        } catch { }
    }
    if (!suggestions || suggestions.anchors.length === 0) {
        const fallbackAnchors: string[] = [];
        if (typeof find === "string" && find.length >= 4) {
            fallbackAnchors.push(`"${find}"`);
            if (!find.endsWith(":")) fallbackAnchors.push(`${find}:`);
        }
        for (const replacement of replacements) {
            const pattern = typeof replacement.match === "string"
                ? replacement.match
                : `/${replacement.match.pattern}/${replacement.match.flags ?? ""}`;
            const literals = pattern.match(/["'][^"']{4,60}["']/g) ?? [];
            for (const literal of literals) {
                if (!fallbackAnchors.includes(literal)) fallbackAnchors.push(literal);
            }
        }
        if (fallbackAnchors.length) suggestions = { anchors: fallbackAnchors.slice(0, 6) };
    }

    return {
        score: overallScore,
        warnings: warnings.length ? warnings : undefined,
        find: findAnalysis,
        replacements: replacementAnalyses,
        suggestions
    };
}

function handleTogglePlugin(requestData: unknown) {
    if (!settings.store.allowPluginToggle) {
        throw new Error("Plugin toggling is disabled in settings");
    }

    const { pluginName, enabled, pluginId, name } = requestData as PluginToggleRequest & { pluginId?: string; name?: string; };
    const resolved = resolvePluginName(pluginName ?? pluginId ?? name);
    if (!resolved) {
        throw new Error("plugin name is required");
    }
    const plugin = Vencord.Plugins.plugins[resolved];

    if (!plugin) {
        throw new Error(`Plugin "${resolved}" not found`);
    }

    const currentlyEnabled = Settings.plugins[resolved]?.enabled ?? false;

    if (currentlyEnabled !== enabled) {
        togglePlugin(resolved);
    }

    return { success: true };
}

function handleReload(requestData?: unknown) {
    if (!settings.store.allowReload) {
        throw new Error("Reloading is disabled in settings");
    }

    const { delayMs = 100 } = (requestData ?? {}) as { delayMs?: number; };
    const delay = Math.max(0, Math.min(5000, Number(delayMs)));
    setTimeout(() => window.location.reload(), delay);
    return { success: true, delayMs: delay, recommendedWaitMs: 3000 };
}

async function handleGetStores(requestData?: unknown) {
    const { filter, limit = 50, offset = 0 } = (requestData ?? {}) as { filter?: string; limit?: number; offset?: number; };
    if (storeCache.data && Date.now() - storeCache.timestamp < STORE_CACHE_TTL_MS) {
        const filtered = filterStores(storeCache.data, filter, limit, offset);
        return { cached: true, ...filtered };
    }

    const storeInfo: Record<string, { found: boolean; moduleId?: number; source?: string; }> = {};
    const registerStore = (name: string | null, moduleId?: number, source?: string) => {
        if (!name) return;
        if (!storeInfo[name]) {
            storeInfo[name] = {
                found: true,
                moduleId: typeof moduleId === "number" ? moduleId : undefined,
                source
            };
        }
    };
    const maybeRegisterStore = (value: unknown, moduleId?: number, source?: string) => {
        if (!value || typeof value !== "object") return;
        const candidate = value as { getName?: () => string; constructor?: { displayName?: string; }; };
        let name: string | null = null;
        if (typeof candidate.getName === "function") {
            try {
                name = candidate.getName();
            } catch {
                name = null;
            }
        }
        if (!name) {
            name = candidate.constructor?.displayName ?? null;
        }
        if (name && name.length > 1) {
            registerStore(name, moduleId, source);
        }
    };

    for (const [name, store] of fluxStores.entries()) {
        const moduleId = (store as any)?.__moduleId ?? (store as any)?._moduleId;
        registerStore(name, typeof moduleId === "number" ? moduleId : undefined, "fluxStores");
    }

    for (const value of Object.values(Common)) {
        maybeRegisterStore(value, (value as any)?.__moduleId ?? (value as any)?._moduleId, "common");
    }

    const startTime = performance.now();
    for (const [id, mod] of Object.entries(wreq.c ?? {})) {
        if (performance.now() - startTime > 2500) break;
        const { exports } = (mod as { exports?: unknown; });
        if (!exports) continue;
        maybeRegisterStore(exports, Number(id), "module");
        if (typeof exports === "object") {
            for (const value of Object.values(exports as Record<string, unknown>)) {
                maybeRegisterStore(value, Number(id), "module");
            }
        }
    }

    if (!Object.keys(storeInfo).length) {
        const fallbackStores = [
            "UserStore",
            "GuildStore",
            "ChannelStore",
            "MessageStore",
            "PresenceStore",
            "RelationshipStore",
            "SelectedChannelStore",
            "SelectedGuildStore"
        ];
        for (const storeName of fallbackStores) {
            storeInfo[storeName] = { found: false, source: "fallback" };
        }
    }

    storeCache.data = storeInfo;
    storeCache.timestamp = Date.now();
    const filtered = filterStores(storeInfo, filter, limit, offset);
    return { cached: false, ...filtered };
}

async function handleBulkSearchAsync(requestData: unknown) {
    const { queries } = requestData as BulkSearchRequest;
    const results: Array<{ query: string; moduleId: number | null; found: boolean; error?: string; }> = [];
    let found = 0, failed = 0;

    for (let i = 0; i < queries.length; i += CHUNK_SIZE) {
        const chunk = queries.slice(i, i + CHUNK_SIZE);

        await new Promise<void>(resolve => {
            requestAnimationFrame(async () => {
                for (const query of chunk) {
                    try {
                        const { findType, args: queryArgs } = query;
                        const parsedArgs = queryArgs.map(arg => {
                            if (arg.type === "regex") {
                                return parseRegex(arg.value.pattern, arg.value.flags);
                            }
                            return arg.value;
                        });

                        let moduleResults: unknown[];
                        switch (findType) {
                            case "findByProps":
                                moduleResults = findAll(filters.byProps(...(parsedArgs as string[])));
                                break;
                            case "findByCode":
                                moduleResults = findAll(filters.byCode(...(parsedArgs as Array<string | RegExp>)));
                                break;
                            case "findStore":
                                moduleResults = findAll(filters.byStoreName(parsedArgs[0] as string));
                                break;
                            case "findComponentByCode":
                                moduleResults = findAll(filters.componentByCode(...(parsedArgs as Array<string | RegExp>)));
                                break;
                            case "findModuleId":
                                moduleResults = Object.keys(search(parsedArgs[0] as string | RegExp)).map(id => wreq.m[id]);
                                break;
                            default:
                                throw new Error(`Unknown find type: ${findType}`);
                        }

                        const unique = [...new Set(moduleResults)];
                        if (unique.length === 1) {
                            const foundCode = (unique[0] as { toString(): string; }).toString();
                            const moduleId = findModuleIdFast(foundCode);
                            results.push({ query: query.name || query.findType, moduleId, found: true });
                            found++;
                        } else {
                            results.push({ query: query.name || query.findType, moduleId: null, found: false, error: `Found ${unique.length} results` });
                            failed++;
                        }
                    } catch (err) {
                        results.push({ query: query.name || query.findType, moduleId: null, found: false, error: err instanceof Error ? err.message : String(err) });
                        failed++;
                    }
                }
                resolve();
            });
        });
    }

    return { results, found, failed };
}

function handleAnalyzeModule(requestData: unknown) {
    const { moduleId } = requestData as { moduleId: PropertyKey; };
    const code = extractModule(moduleId, false);

    if (code.length > 100000) {
        return {
            moduleId,
            size: code.length,
            exports: [],
            imports: [],
            hasReactComponents: code.includes("React"),
            hasFluxStore: code.includes("Store"),
            patchedBy: getModulePatchedBy(moduleId, true),
            functions: [],
            classes: [],
            warning: "Module too large for detailed analysis"
        };
    }

    const exports: string[] = [];
    const functions: string[] = [];
    const classes: string[] = [];

    const exportMatches = code.matchAll(/exports?\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g);
    let count = 0;
    for (const match of exportMatches) {
        if (!exports.includes(match[1]) && count++ < 50) exports.push(match[1]);
    }

    const funcMatches = code.matchAll(/function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g);
    count = 0;
    for (const match of funcMatches) {
        if (count++ < 30) functions.push(match[1]);
    }

    const classMatches = code.matchAll(/class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g);
    count = 0;
    for (const match of classMatches) {
        if (count++ < 20) classes.push(match[1]);
    }

    const hasReactComponents = code.includes("React");
    const hasFluxStore = code.includes("Store") && code.includes("Dispatcher");
    const imports = (code.match(/require\(['"](.*?)['"]\)/g) || []).slice(0, 20);

    return {
        moduleId,
        size: code.length,
        exports: exports.slice(0, 50),
        imports,
        hasReactComponents,
        hasFluxStore,
        patchedBy: getModulePatchedBy(moduleId, true),
        functions: functions.slice(0, 30),
        classes: classes.slice(0, 20)
    };
}

async function handleGetPatchedModulesAsync(requestData: unknown) {
    const { pluginName, offset = 0, limit = 100 } = requestData as { pluginName?: string; offset?: number; limit?: number; };
    const cacheKey = `${pluginName ?? "all"}:${offset}:${limit}`;
    const cached = patchedModulesCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < PATCHED_CACHE_TTL_MS) {
        return { ...cached.result, cached: true };
    }
    const inflight = patchedModulesInFlight.get(cacheKey);
    if (inflight) {
        return inflight;
    }

    const task = (async () => {
        const patches: Array<{
            moduleId: number;
            pluginName: string;
            find: string;
            replacements: number;
        }> = [];
        let totalFound = 0;
        const targetCount = Math.max(0, offset) + Math.max(1, limit);

        const normalizedName = pluginName?.trim();
        const useIndex = settings.store.prebuildPatchIndex;
        if (useIndex) {
            await buildPatchIndex();
        }

        if (useIndex && patchIndex.ready) {
            for (const entry of patchIndex.entries) {
                if (normalizedName && !entry.patchedBy.includes(normalizedName)) continue;
                totalFound++;
                if (totalFound > offset && patches.length < limit) {
                    const source = extractModule(entry.moduleId, false);
                    patches.push({
                        moduleId: entry.moduleId,
                        pluginName: normalizedName ?? entry.patchedBy[0],
                        find: source.substring(0, 100),
                        replacements: entry.patchedBy.length
                    });
                }
                if (totalFound >= targetCount) break;
            }
        } else {
            for await (const result of asyncIterateModules((id, code) => {
                const patchedBy = getModulePatchedBy(id, true);
                if (patchedBy.length > 0) {
                    if (!normalizedName || patchedBy.includes(normalizedName)) {
                        totalFound++;
                        return {
                            moduleId: Number(id),
                            pluginName: patchedBy[0],
                            find: code.substring(0, 100),
                            replacements: patchedBy.length
                        };
                    }
                }
                return null;
            })) {
                if (result) {
                    if (totalFound > offset && patches.length < limit) {
                        patches.push(result);
                    }
                    if (totalFound >= targetCount) break;
                }
            }
        }

        return {
            patches,
            totalFound,
            offset,
            limit,
            hasMore: totalFound >= targetCount
        };
    })();

    patchedModulesInFlight.set(cacheKey, task);
    try {
        const result = await task;
        patchedModulesCache.set(cacheKey, { timestamp: Date.now(), result });
        return { ...result, cached: false };
    } finally {
        patchedModulesInFlight.delete(cacheKey);
    }
}

async function handleSearchByPatternAsync(requestData: unknown) {
    const { pattern, limit = 20 } = requestData as { pattern: string; limit?: number; };
    const startTime = performance.now();
    const modules: Array<{ id: number; preview: string; }> = [];
    let searchPattern: string | RegExp = pattern;

    if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
        const lastSlash = pattern.lastIndexOf("/");
        const regexPattern = pattern.substring(1, lastSlash);
        const flags = pattern.substring(lastSlash + 1);
        searchPattern = new RegExp(regexPattern, flags);
    }

    const isRegex = searchPattern instanceof RegExp;
    const candidateIds = !isRegex && settings.store.prebuildSearchIndex
        ? await ModuleSearchEngine.getIndexedCandidates(String(searchPattern))
        : null;
    const cachedResults = ModuleSearchEngine.getCachedResults(searchPattern);
    if (cachedResults.length > 0) {
        for (const { id, code } of cachedResults) {
            if (modules.length >= limit) break;
            modules.push({
                id: Number(id),
                preview: code.substring(0, 200)
            });
        }
        return { modules };
    }

    const allModuleIds = candidateIds ? Array.from(candidateIds) : Object.keys(wreq.m);
    const batchSize = 100;
    let checked = 0;

    for (let i = 0; i < allModuleIds.length; i += batchSize) {
        if (modules.length >= limit) break;

        const batch = allModuleIds.slice(i, i + batchSize);

        await new Promise(resolve => requestAnimationFrame(resolve));

        if (performance.now() - startTime > 3000) {
            logger.warn(`searchByPattern timeout after ${checked} modules`);
            break;
        }

        for (const id of batch) {
            if (modules.length >= limit) break;

            checked++;
            const code = ModuleSearchEngine.getModuleCode(id);

            if (code.length > 200000) continue;

            const matches = isRegex ? (searchPattern as RegExp).test(code) : code.includes(searchPattern as string);
            if (matches) {
                modules.push({
                    id: Number(id),
                    preview: code.substring(0, 200)
                });
                ModuleSearchEngine.addToCache(searchPattern, id, code);
            }
        }
    }

    return { modules };
}

function handleGetPluginList(requestData: unknown) {
    const { filter, showPatches } = (requestData ?? {}) as { filter?: string; showPatches?: boolean; };
    const plugins: Array<{
        name: string;
        enabled: boolean;
        description: string;
        patches: number;
        patchDetails?: Array<{ find: string; replacements: number; }>;
    }> = [];

    const filterLower = filter?.toLowerCase().trim();
    for (const [name, plugin] of Object.entries(Vencord.Plugins.plugins)) {
        if (filterLower && !name.toLowerCase().includes(filterLower)) continue;
        const patches = (plugin as { patches?: Array<{ find: unknown; replacement?: unknown; }>; }).patches ?? [];
        const entry: {
            name: string;
            enabled: boolean;
            description: string;
            patches: number;
            patchDetails?: Array<{ find: string; replacements: number; }>;
        } = {
            name,
            enabled: Settings.plugins[name]?.enabled ?? false,
            description: (plugin as { description?: string; }).description || "",
            patches: patches.length
        };

        if (showPatches) {
            entry.patchDetails = patches.slice(0, 10).map(patch => ({
                find: String(typeof patch.find === "string" ? patch.find : patch.find).slice(0, 120),
                replacements: Array.isArray(patch.replacement) ? patch.replacement.length : patch.replacement ? 1 : 0
            }));
        }

        plugins.push(entry);
    }

    return {
        total: plugins.length,
        enabled: plugins.filter(p => p.enabled).length,
        plugins
    };
}

function handleGetPluginInfo(requestData: unknown) {
    const { pluginName, pluginId, name } = requestData as { pluginName?: string; pluginId?: string; name?: string; };
    const resolved = resolvePluginName(pluginName ?? pluginId ?? name);
    if (!resolved) {
        throw new Error("plugin name is required");
    }
    const plugin = Vencord.Plugins.plugins[resolved];
    if (!plugin) {
        throw new Error(`Plugin "${resolved}" not found`);
    }
    const pluginSettings = Settings.plugins[resolved] ?? {};
    const patches = (plugin as { patches?: unknown[]; }).patches ?? [];
    return {
        name: resolved,
        description: (plugin as { description?: string; }).description || "",
        enabled: pluginSettings.enabled ?? false,
        started: (plugin as { started?: boolean; }).started ?? false,
        hasPatches: patches.length > 0,
        patchCount: patches.length,
        authors: safeSerialize((plugin as { authors?: unknown; }).authors ?? []),
        dependencies: safeSerialize((plugin as { dependencies?: unknown; }).dependencies ?? []),
        settings: safeSerialize(pluginSettings)
    };
}

function handleGetModuleRelationships(requestData: unknown) {
    const { moduleId } = requestData as { moduleId: PropertyKey; };
    const code = extractModule(moduleId, false);

    if (code.length > 100000) {
        return {
            imports: [],
            exports: [],
            usedBy: [],
            warning: "Module too large for relationship analysis"
        };
    }

    const imports = (code.match(/require\(['"](.*?)['"]\)/g) || []).slice(0, 30).map(m => m.match(/require\(['"](.*?)['"]\)/)?.[1] || "");
    const exports = (code.match(/exports?\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g) || []).slice(0, 30).map(m => m.match(/exports?\.([a-zA-Z_$][a-zA-Z0-9_$]*)/)?.[1] || "");

    const usedBy: number[] = [];
    const searchPattern = `(${String(moduleId)})`;
    const allModules = Object.keys(wreq.m);

    for (let i = 0; i < Math.min(allModules.length, 100); i++) {
        const id = allModules[i];
        if (id !== String(moduleId)) {
            const otherCode = wreq.m[id].toString();
            if (otherCode.length < 50000 && otherCode.includes(searchPattern)) {
                usedBy.push(Number(id));
                if (usedBy.length >= 10) break;
            }
        }
    }

    return { imports, exports, usedBy };
}

function handleModuleContext(requestData: unknown) {
    const {
        moduleId,
        pattern,
        isRegex = false,
        radius = 80,
        limit = 5,
        contextLines = 2,
        usePatched = true
    } = requestData as {
        moduleId: number;
        pattern: string;
        isRegex?: boolean;
        radius?: number;
        limit?: number;
        contextLines?: number;
        usePatched?: boolean;
    };

    if (!pattern?.trim()) {
        throw new Error("pattern is required");
    }

    const code = extractModule(moduleId, usePatched);
    const { regex, patternString } = parsePotentialRegex(pattern, isRegex);
    const maxSnippets = Math.max(1, Math.min(20, Number(limit ?? 5)));
    const clampRadius = Math.max(20, Math.min(200, Number(radius ?? 80)));
    const clampContextLines = Math.max(0, Math.min(10, Number(contextLines ?? 2)));

    if (regex) {
        const matches = Array.from(code.matchAll(regex));
        const offsets = matches.map(m => m.index ?? 0);
        const matchDetails = matches.slice(0, maxSnippets).map(m => {
            const index = m.index ?? 0;
            const lineInfo = getLineColumn(code, index);
            const context = getLineContext(code, index, clampContextLines);
            return {
                offset: index,
                line: lineInfo.line,
                column: lineInfo.column,
                snippet: code.slice(Math.max(0, index - clampRadius), Math.min(code.length, index + (m[0]?.length || 0) + clampRadius)).replace(/\s+/g, " "),
                context: clampContextLines > 0 ? context : undefined
            };
        });
        return {
            moduleId,
            pattern,
            isRegex: true,
            matchCount: matches.length,
            offsets: offsets.slice(0, maxSnippets),
            snippets: sliceSnippets(code, matches as unknown as RegExpMatchArray[], maxSnippets, clampRadius),
            matches: matchDetails,
            truncated: matches.length > maxSnippets
        };
    }

    if (!patternString) {
        return { moduleId, pattern, isRegex: false, matchCount: 0, offsets: [], snippets: [] };
    }

    const offsets: number[] = [];
    const snippets: string[] = [];
    const matchDetails: Array<{
        offset: number;
        line: number;
        column: number;
        snippet: string;
        context?: { before: string[]; current: string; after: string[]; line: number; };
    }> = [];
    let idx = code.indexOf(patternString);
    while (idx !== -1 && offsets.length < maxSnippets) {
        offsets.push(idx);
        const start = Math.max(0, idx - clampRadius);
        const end = Math.min(code.length, idx + patternString.length + clampRadius);
        const snippet = code.slice(start, end).replace(/\s+/g, " ");
        snippets.push(snippet);
        const lineInfo = getLineColumn(code, idx);
        matchDetails.push({
            offset: idx,
            line: lineInfo.line,
            column: lineInfo.column,
            snippet,
            context: clampContextLines > 0 ? getLineContext(code, idx, clampContextLines) : undefined
        });
        idx = code.indexOf(patternString, idx + patternString.length);
    }

    return {
        moduleId,
        pattern,
        isRegex: false,
        matchCount: offsets.length,
        offsets,
        snippets,
        matches: matchDetails,
        truncated: idx !== -1
    };
}

async function handleSearchContext(requestData: SearchContextRequest) {
    const {
        pattern,
        isRegex = false,
        limit = 5,
        matchLimit = 3,
        radius = 80,
        contextLines = 2
    } = requestData;
    if (!pattern?.trim()) throw new Error("pattern is required");

    const { regex, patternString } = parsePotentialRegex(pattern, isRegex);
    const maxModules = Math.max(1, Math.min(20, Number(limit ?? 5)));
    const maxMatches = Math.max(1, Math.min(10, Number(matchLimit ?? 3)));
    const clampRadius = Math.max(20, Math.min(200, Number(radius ?? 80)));
    const clampContextLines = Math.max(0, Math.min(10, Number(contextLines ?? 2)));

    const modules: Array<{
        moduleId: number;
        matchCount: number;
        offsets: number[];
        snippets: string[];
        matches: Array<{
            offset: number;
            line: number;
            column: number;
            snippet: string;
            context?: { before: string[]; current: string; after: string[]; line: number; };
        }>;
    }> = [];
    let totalFound = 0;

    const searchPattern = regex ?? patternString ?? pattern;
    for await (const { id, code } of ModuleSearchEngine.searchPattern(searchPattern as string | RegExp)) {
        const offsets: number[] = [];
        let matchCount = 0;
        if (regex) {
            const localRegex = new RegExp(regex.source, regex.flags);
            for (const m of code.matchAll(localRegex)) {
                matchCount++;
                if (offsets.length < maxMatches) {
                    offsets.push(m.index ?? 0);
                }
            }
        } else if (patternString) {
            let idx = code.indexOf(patternString);
            while (idx !== -1) {
                matchCount++;
                if (offsets.length < maxMatches) {
                    offsets.push(idx);
                }
                idx = code.indexOf(patternString, idx + patternString.length);
            }
        }

        if (!offsets.length) continue;
        totalFound += matchCount;
        const matches = offsets.map(offset => {
            const lineInfo = getLineColumn(code, offset);
            const snippet = code.slice(Math.max(0, offset - clampRadius), Math.min(code.length, offset + (patternString?.length ?? 0) + clampRadius)).replace(/\s+/g, " ");
            return {
                offset,
                line: lineInfo.line,
                column: lineInfo.column,
                snippet,
                context: clampContextLines > 0 ? getLineContext(code, offset, clampContextLines) : undefined
            };
        });
        const snippets = matches.map(m => m.snippet).slice(0, maxMatches);

        modules.push({
            moduleId: Number(id),
            matchCount,
            offsets: offsets.slice(0, maxMatches),
            snippets,
            matches
        });
        if (modules.length >= maxModules) break;
    }

    return {
        pattern,
        isRegex: Boolean(regex),
        totalFound,
        modules
    };
}

async function handleModuleContextSearch(requestData: SearchContextRequest) {
    return handleSearchContext(requestData);
}

async function handleFindReactComponentsAsync(requestData: unknown) {
    const { pattern, offset = 0, limit = 50 } = requestData as { pattern: string; offset?: number; limit?: number; };
    const components: Array<{
        name: string;
        moduleId: number;
        patched: boolean;
    }> = [];
    let totalFound = 0;
    const targetCount = Math.max(0, offset) + Math.max(1, limit);

    const reactIndicators = ["React", ".Component", ".PureComponent", ".memo", "createElement", "jsx"];
    const componentNameRegex = /(?:function|const|class|let|var)\s+([A-Z][a-zA-Z0-9_]*)/g;

    for await (const { id, code } of ModuleSearchEngine.searchPattern(pattern)) {
        const hasReact = reactIndicators.some(indicator => code.includes(indicator));
        if (!hasReact) continue;

        const matches = Array.from(code.matchAll(componentNameRegex));
        if (matches.length > 0) {
            const componentName = matches[0][1];
            totalFound++;
            if (totalFound > offset && components.length < limit) {
                components.push({
                    name: componentName,
                    moduleId: Number(id),
                    patched: getModulePatchedBy(id, true).length > 0
                });
            }
            if (totalFound >= targetCount) break;
        }
    }

    return {
        components,
        totalFound,
        offset,
        limit,
        hasMore: totalFound >= targetCount
    };
}

function handleGetPluginPatches(requestData: unknown) {
    const { pluginName, pluginId, name } = requestData as { pluginName?: string; pluginId?: string; name?: string; };
    const resolved = resolvePluginName(pluginName ?? pluginId ?? name);
    if (!resolved) {
        throw new Error("plugin name is required");
    }
    const plugin = Vencord.Plugins.plugins[resolved];

    if (!plugin) {
        throw new Error(`Plugin "${resolved}" not found`);
    }

    const patches: Array<{
        moduleId: number | null;
        find: string;
        replacements: Array<{ match: string; replace: string; }>;
        applied: boolean;
    }> = [];
    const selfRefs = new Set<string>();
    const pluginPatches = (plugin as { patches?: Array<{ find: string | RegExp; replacement?: unknown; }>; }).patches || [];

    for (const patch of pluginPatches) {
        let moduleId: number | null = null;
        try {
            const candidates = search(patch.find);
            const keys = Object.keys(candidates);
            if (keys.length === 1) {
                moduleId = Number(keys[0]);
            }
        } catch { }

        const replacements = patch.replacement
            ? (Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement]) as Array<{ match: string; replace: string; }>
            : [];

        for (const replacement of replacements) {
            if (typeof replacement.replace !== "string") continue;
            const matches = replacement.replace.matchAll(/\$self\.([A-Za-z_$][\w$]*)/g);
            for (const match of matches) {
                selfRefs.add(match[1]);
            }
        }

        patches.push({
            moduleId,
            find: String(patch.find),
            replacements,
            applied: moduleId !== null
        });
    }

    const missingSelfRefs = Array.from(selfRefs).filter(ref => !(ref in (plugin as unknown as Record<string, unknown>)));
    const warnings = missingSelfRefs.length
        ? missingSelfRefs.map(ref => `Patch references $self.${ref} but the plugin does not export it.`)
        : [];

    return { patches, selfRefs: Array.from(selfRefs), missingSelfRefs, warnings };
}

function handleDebugWebpack() {
    const totalModules = Object.keys(wreq.m).length;
    const cachedModules = Object.keys(wreq.c || {}).length;

    return {
        totalModules,
        cachedModules,
        wreqVersion: wreq.v || undefined,
        hasWebpackRequire: typeof wreq === "function"
    };
}

async function handleModuleStats() {
    const modules = Object.keys(wreq.m);
    let totalSize = 0;
    let largestModule = { id: 0, size: 0 };
    let smallestModule = { id: 0, size: Infinity };
    let processed = 0;

    for await (const result of asyncIterateModules((id, code) => {
        const size = code.length;
        totalSize += size;
        processed++;

        if (size > largestModule.size) {
            largestModule = { id: Number(id), size };
        }
        if (size < smallestModule.size && size > 0) {
            smallestModule = { id: Number(id), size };
        }

        return null;
    })) { }

    return {
        totalSize,
        averageSize: processed > 0 ? totalSize / processed : 0,
        largestModule,
        smallestModule: smallestModule.size === Infinity ? { id: 0, size: 0 } : smallestModule,
        totalModules: modules.length,
        processedModules: processed
    };
}

function handleTraceFunctionCalls(requestData: unknown) {
    const { moduleId } = requestData as { moduleId: number; };
    const code = extractModule(moduleId, false);

    const functions: string[] = [];
    const classes: string[] = [];
    const exports: string[] = [];

    const funcMatches = code.matchAll(/function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g);
    for (const match of funcMatches) {
        functions.push(match[1]);
    }

    const classMatches = code.matchAll(/class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g);
    for (const match of classMatches) {
        classes.push(match[1]);
    }

    const exportMatches = code.matchAll(/exports?\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g);
    for (const match of exportMatches) {
        if (!exports.includes(match[1])) exports.push(match[1]);
    }

    const totalCalls = (code.match(/\w+\s*\(/g) || []).length;

    return { functions, classes, exports, totalCalls };
}

function handleMemoryUsage() {
    const memInfo = (window.performance as { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number; }; }).memory;

    return {
        heapUsed: memInfo?.usedJSHeapSize || 0,
        heapTotal: memInfo?.totalJSHeapSize || 0,
        external: memInfo?.jsHeapSizeLimit || 0,
        cacheSize: moduleCache.size
    };
}

async function handleFindUnusedModulesAsync() {
    const startTime = performance.now();
    const usageMap = new Map<string, Set<string>>();
    const allModules = Object.keys(wreq.m);

    let processed = 0;
    for await (const result of asyncIterateModules((id, code) => {
        processed++;

        const requiredModules = code.match(/\((\d+)\)/g);
        if (requiredModules) {
            for (const match of requiredModules) {
                const requiredId = match.slice(1, -1);
                if (!usageMap.has(requiredId)) {
                    usageMap.set(requiredId, new Set());
                }
                usageMap.get(requiredId)!.add(id);
            }
        }

        if (processed % 100 === 0 && performance.now() - startTime > 5000) {
            return null;
        }

        return null;
    })) { }

    const unused: number[] = [];
    for (const moduleId of allModules.slice(0, Math.min(1000, allModules.length))) {
        if (!usageMap.has(moduleId) && unused.length < 50) {
            unused.push(Number(moduleId));
        }
    }

    return {
        unused,
        totalChecked: processed,
        timeMs: Math.round(performance.now() - startTime)
    };
}

const performanceMetrics: Array<{ type: string; time: number; }> = [];
let cacheHits = 0;
let totalMetricRequests = 0;

const expectedSlowTools = new Set([
    "search",
    "patch",
    "module",
    "store",
    "dom",
    "plugin",
    "discord"
]);

function logToolResult(options: {
    type: string;
    requestData?: unknown;
    startTime: number;
    error?: string;
    responseData?: unknown;
}) {
    const duration = (performance.now() - options.startTime).toFixed(2);
    const time = Number(duration);

    performanceMetrics.push({ type: options.type, time });
    if (performanceMetrics.length > 100) {
        performanceMetrics.shift();
    }
    totalMetricRequests++;

    const resultText = options.error ? String(options.error) : JSON.stringify(options.responseData ?? {});
    const notFound = /"found"\s*:\s*false|"matchCount"\s*:\s*0|No module found|No match\b|No results\b/i.test(resultText);
    const status = options.error ? "FAIL" : notFound ? "MISS" : "PASS";
    const sizeBytes = resultText.length;
    const sizeStr = sizeBytes > 1024 ? `${(sizeBytes / 1024).toFixed(1)}KB` : `${sizeBytes}B`;
    const reqArgs = (options.requestData && typeof options.requestData === "object") ? (options.requestData as Record<string, unknown>) : {};
    const firstArg = Object.values(reqArgs)[0];
    let context = "-";
    if (Array.isArray(firstArg)) {
        const tools = firstArg
            .map(item => (item && typeof item === "object") ? (item as Record<string, unknown>).tool : item)
            .filter(Boolean)
            .slice(0, 3)
            .map(String);
        context = tools.length ? tools.join(", ") : `${firstArg.length} items`;
    } else if (firstArg != null) {
        context = String(firstArg).slice(0, 40);
    }
    const msg = `${status} | ${options.type.padEnd(20)} | ${duration.padStart(8)}ms | ${sizeStr.padStart(7)} | ${context}`;

    if (options.error) logger.error(msg);
    else if (notFound) logger.warn(msg);
    else logger.info(msg);

    if (!options.error && time > 100 && !expectedSlowTools.has(options.type)) {
        logger.warn(`${options.type} was slow: ${duration}ms`);
    }
}

function handleCreateCustomPatch(requestData: unknown) {
    const { moduleId, find, replace, predicate } = requestData as {
        moduleId?: number;
        find: string;
        replace: string;
        predicate?: string;
    };

    try {
        if (moduleId && !wreq.m[moduleId]) {
            return { error: `Module ${moduleId} not found` };
        }

        const patch = {
            find: find.substring(0, 100),
            replacement: {
                match: find,
                replace,
                predicate: predicate || undefined
            }
        };

        return {
            patch,
            valid: true,
            willMatch: moduleId ? wreq.m[moduleId].toString().includes(find) : "unknown"
        };
    } catch (err) {
        return { error: String(err) };
    }
}

function handleTestCustomPatch(requestData: unknown) {
    const { moduleId, find, replace } = requestData as {
        moduleId: number;
        find: string;
        replace: string;
    };

    try {
        const original = extractModule(moduleId, false);
        if (!original.includes(find)) {
            return {
                success: false,
                error: "Pattern not found in module",
                original: original.substring(0, 500)
            };
        }

        const patched = original.replace(find, replace);
        const diff = {
            before: original.substring(Math.max(0, original.indexOf(find) - 100), original.indexOf(find) + find.length + 100),
            after: patched.substring(Math.max(0, patched.indexOf(replace) - 100), patched.indexOf(replace) + replace.length + 100)
        };

        return {
            success: true,
            diff,
            occurrences: (original.match(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length
        };
    } catch (err) {
        return { success: false, error: String(err) };
    }
}

function handleFindPatchTargets(requestData: unknown) {
    const { pattern, maxResults = 10 } = requestData as {
        pattern: string;
        maxResults?: number;
    };

    const targets: Array<{
        moduleId: number;
        preview: string;
        matchCount: number;
        size: number;
    }> = [];

    const isRegex = pattern.startsWith("/") && pattern.lastIndexOf("/") > 0;
    let searchPattern: string | RegExp = pattern;

    if (isRegex) {
        const lastSlash = pattern.lastIndexOf("/");
        searchPattern = new RegExp(pattern.substring(1, lastSlash), pattern.substring(lastSlash + 1));
    }

    for (const id in wreq.m) {
        if (targets.length >= maxResults) break;

        const code = wreq.m[id].toString();
        const matches = isRegex
            ? (code.match(searchPattern as RegExp) || []).length
            : (code.split(searchPattern as string).length - 1);

        if (matches > 0) {
            const matchIndex = code.search(searchPattern);
            targets.push({
                moduleId: Number(id),
                preview: code.substring(Math.max(0, matchIndex - 50), Math.min(matchIndex + 150, code.length)),
                matchCount: matches,
                size: code.length
            });
        }
    }

    return { targets: targets.sort((a, b) => b.matchCount - a.matchCount) };
}

function handleAnalyzePatchOverlap(requestData: unknown) {
    const { moduleId } = requestData as { moduleId: number; };

    try {
        const patchedBy = getModulePatchedBy(moduleId, true);
        const original = extractModule(moduleId, false);
        const patched = extractModule(moduleId, true);

        const overlaps: Array<{
            plugin: string;
            changes: number;
        }> = [];

        for (const plugin of patchedBy) {
            const pluginPatches = (Vencord.Plugins.plugins[plugin] as any)?.patches || [];
            let changeCount = 0;

            for (const patch of pluginPatches) {
                const pattern = typeof patch.find === "string" ? patch.find : patch.find.source;
                if (original.includes(pattern) || (patch.find instanceof RegExp && patch.find.test(original))) {
                    changeCount++;
                }
            }

            if (changeCount > 0) {
                overlaps.push({ plugin, changes: changeCount });
            }
        }

        return {
            moduleId,
            patchedBy,
            totalPatches: patchedBy.length,
            overlaps,
            sizeChange: patched.length - original.length,
            hasOverlap: overlaps.length > 1
        };
    } catch (err) {
        return { error: String(err) };
    }
}

function handlePatchOverlapByFind(requestData: unknown) {
    const { moduleId, find } = requestData as { moduleId?: number; find?: string | { pattern: string; flags: string; }; };
    if (typeof moduleId === "number") {
        return handleAnalyzePatchOverlap({ moduleId });
    }
    if (!find) {
        throw new Error("moduleId or find is required");
    }
    const findPattern = parseRegexArg(find);
    const candidates = search(findPattern);
    const keys = Object.keys(candidates);
    if (keys.length !== 1) {
        throw new Error(`Expected exactly 1 match, found ${keys.length}`);
    }
    return handleAnalyzePatchOverlap({ moduleId: Number(keys[0]) });
}

function handleAnalytics(requestData: unknown) {
    const {
        action = "start",
        filter,
        isRegex = false,
        limit = 50,
        offset = 0,
        maxEntries = 500,
        redact = true,
        fields,
        stopOnMatch = false,
        stopAfter
    } = requestData as {
        action?: string;
        filter?: string;
        isRegex?: boolean;
        limit?: number;
        offset?: number;
        maxEntries?: number;
        redact?: boolean;
        fields?: string[] | null;
        stopOnMatch?: boolean;
        stopAfter?: number;
    };

    if (action === "get") {
        const maxPayloadChars = Number((requestData as { maxPayloadChars?: number; }).maxPayloadChars);
        const slice = analyticsState.events.slice(offset, offset + limit).map(entry => ({
            ...entry,
            payload: truncatePayload(entry.payload, maxPayloadChars)
        }));
        return {
            active: analyticsState.active,
            total: analyticsState.events.length,
            offset,
            limit,
            events: slice,
            stoppedReason: analyticsState.lastStopReason
        };
    }

    if (action === "status") {
        return {
            active: analyticsState.active,
            total: analyticsState.events.length,
            config: {
                filter: analyticsState.filter,
                isRegex: analyticsState.isRegex,
                redact: analyticsState.redact,
                fields: analyticsState.fields,
                maxEntries: analyticsState.maxEntries,
                stopOnMatch: analyticsState.stopOnMatch,
                stopAfter: analyticsState.stopAfter,
                matchCount: analyticsState.matchCount,
                targetCount: analyticsState.targets.length,
                lastStopReason: analyticsState.lastStopReason
            }
        };
    }

    if (action === "clear") {
        analyticsState.events = [];
        analyticsState.matchCount = 0;
        analyticsState.lastStopReason = null;
        return { cleared: true };
    }

    if (action === "events") {
        const counts: Record<string, number> = {};
        for (const entry of analyticsState.events) {
            counts[entry.event] = (counts[entry.event] ?? 0) + 1;
        }
        const items = Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([event, count]) => ({ event, count }));
        return { total: items.length, events: items.slice(offset, offset + limit) };
    }

    if (action === "stop") {
        if (analyticsState.active && analyticsState.targets.length > 0) {
            for (const entry of analyticsState.targets) {
                if (entry.original.trackWithMetadata) {
                    entry.target.trackWithMetadata = entry.original.trackWithMetadata;
                }
                if (entry.original.track) {
                    entry.target.track = entry.original.track;
                }
            }
        }
        analyticsState.active = false;
        analyticsState.targets = [];
        analyticsState.matchCount = 0;
        analyticsState.stopOnMatch = false;
        analyticsState.stopAfter = null;
        analyticsState.lastStopReason = "manual";
        return { stopped: true };
    }

    const matcher = createTextMatcher(filter, isRegex);
    const max = Math.max(50, Math.min(2000, Number(maxEntries ?? 500)));

    if (!analyticsState.active) {
        analyticsState.events = [];
        analyticsState.matchCount = 0;
        analyticsState.lastStopReason = null;
        const now = Date.now();
        const cached = analyticsState.cachedTargets && (now - analyticsState.cachedTargets.createdAt) < ANALYTICS_TARGET_CACHE_TTL_MS
            ? analyticsState.cachedTargets.targets
            : null;
        const targets: Array<{ target: AnalyticsTarget; original: AnalyticsTarget; }> = [];
        const collectTargets = (candidates: AnalyticsTarget[]) => {
            const seenTargets = new WeakSet<object>();
            for (const candidate of candidates) {
                if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) continue;
                const obj = candidate as object;
                if (seenTargets.has(obj)) continue;
                seenTargets.add(obj);
                if (typeof candidate.trackWithMetadata === "function" || typeof candidate.track === "function") {
                    targets.push({
                        target: candidate,
                        original: {
                            trackWithMetadata: candidate.trackWithMetadata,
                            track: candidate.track
                        }
                    });
                }
            }
        };

        if (cached && cached.length > 0) {
            collectTargets(cached);
        }

        if (targets.length === 0) {
            const seen = new WeakSet<object>();
            const discovered: AnalyticsTarget[] = [];
            const visit = (value: unknown, depth: number) => {
                if (!value || (typeof value !== "object" && typeof value !== "function")) return;
                const obj = value as object;
                if (seen.has(obj)) return;
                seen.add(obj);
                const candidate = value as AnalyticsTarget;
                if (typeof candidate.trackWithMetadata === "function" || typeof candidate.track === "function") {
                    discovered.push(candidate);
                }
                if (depth <= 0 || typeof value !== "object") return;
                for (const key of Object.keys(value as Record<string, unknown>)) {
                    visit((value as Record<string, unknown>)[key], depth - 1);
                }
            };
            for (const id in wreq.c) {
                const exp = wreq.c[id]?.exports;
                visit(exp, 2);
            }
            collectTargets(discovered);
            if (targets.length === 0) {
                throw new Error("trackWithMetadata/track not found");
            }
            analyticsState.cachedTargets = { targets: discovered, createdAt: now };
        } else {
            analyticsState.cachedTargets = { targets: cached ?? [], createdAt: now };
        }
        const capture = (event: unknown, payload: unknown, flush: unknown, source: string) => {
            try {
                const name = typeof event === "string" ? event : String(event);
                if (!matcher || matcher(name)) {
                    analyticsState.matchCount += 1;
                    let entry: Record<string, unknown> = {
                        event: name,
                        timestamp: new Date().toISOString(),
                        payload: safeSerialize(payload),
                        flush: Boolean(flush),
                        source
                    };
                    if (fields && fields.length > 0) {
                        entry = ensureBaseFields(filterFields(entry, fields) as Record<string, unknown>, {
                            event: name,
                            timestamp: entry.timestamp
                        });
                    }
                    const finalEntry = redact ? redactSensitive(entry) as AnalyticsEntry : entry as AnalyticsEntry;
                    analyticsState.events.push(finalEntry);
                    if (analyticsState.events.length > max) analyticsState.events.shift();
                    if (analyticsState.stopOnMatch || (typeof analyticsState.stopAfter === "number" && analyticsState.matchCount >= analyticsState.stopAfter)) {
                        const reason = analyticsState.stopOnMatch ? "stopOnMatch" : "stopAfter";
                        for (const entry of analyticsState.targets) {
                            if (entry.original.trackWithMetadata) {
                                entry.target.trackWithMetadata = entry.original.trackWithMetadata;
                            }
                            if (entry.original.track) {
                                entry.target.track = entry.original.track;
                            }
                        }
                        analyticsState.active = false;
                        analyticsState.targets = [];
                        analyticsState.matchCount = 0;
                        analyticsState.stopOnMatch = false;
                        analyticsState.stopAfter = null;
                        analyticsState.lastStopReason = reason;
                    }
                }
            } catch { }
        };

        for (const entry of targets) {
            if (typeof entry.target.trackWithMetadata === "function") {
                entry.target.trackWithMetadata = function (event: unknown, payload: unknown, flush?: unknown) {
                    capture(event, payload, flush, "trackWithMetadata");
                    return (entry.original.trackWithMetadata as (...args: any[]) => unknown).apply(this, arguments as any);
                };
            }
            if (typeof entry.target.track === "function") {
                entry.target.track = function (event: unknown, payload?: unknown) {
                    capture(event, payload, false, "track");
                    return (entry.original.track as (...args: any[]) => unknown).apply(this, arguments as any);
                };
            }
        }

        analyticsState.active = true;
        analyticsState.maxEntries = max;
        analyticsState.filter = filter ?? null;
        analyticsState.isRegex = isRegex;
        analyticsState.redact = redact;
        analyticsState.fields = fields ?? null;
        analyticsState.stopOnMatch = Boolean(stopOnMatch);
        analyticsState.stopAfter = typeof stopAfter === "number" && Number.isFinite(stopAfter) ? Math.max(1, Math.floor(stopAfter)) : null;
        analyticsState.targets = targets;
        return { started: true, alreadyActive: false, maxEntries: max, targetCount: targets.length };
    }

    return { started: true, alreadyActive: true, maxEntries: analyticsState.maxEntries };
}

function handleGetModuleExports(requestData: unknown) {
    const { moduleId } = requestData as { moduleId: number; };

    try {
        if (!wreq.c[moduleId]) {
            return { error: `Module ${moduleId} not loaded` };
        }

        const module = wreq.c[moduleId].exports;
        const exports: Record<string, string> = {};

        for (const key in module) {
            const type = typeof module[key];
            if (type === "function") {
                exports[key] = `function(${module[key].length} args)`;
            } else if (type === "object" && module[key] !== null) {
                exports[key] = Array.isArray(module[key]) ? "array" : "object";
            } else {
                exports[key] = type;
            }
        }

        return {
            moduleId,
            exports,
            hasDefault: "default" in module,
            isESModule: module.__esModule === true
        };
    } catch (err) {
        return { error: String(err) };
    }
}

async function handleSearchLiteral(requestData: unknown) {
    const { query, isRegex = false, limit = 20, offset = 0, preset = "full" } = requestData as SearchLiteralRequest & { offset?: number; };
    const results: Array<{ id: number; preview: string; occurrences: number; offsets: number[]; snippets: string[]; }> = [];
    const patternInfo = parsePotentialRegex(query, isRegex);
    const matcher = patternInfo.regex;
    const searchStr = patternInfo.patternString;
    const useCache = !matcher && !!searchStr && searchStr.length > 2;

    if (useCache) {
        const cached = ModuleSearchEngine.getLiteralCache(searchStr);
        if (cached) {
            const slice = cached.slice(offset, offset + limit);
            if (preset === "compact" || preset === "minimal") {
                return {
                    moduleIds: slice.map(m => m.id),
                    totalFound: cached.length,
                    offset,
                    limit,
                    hasMore: offset + limit < cached.length
                };
            }
            return {
                matches: slice,
                totalFound: cached.length,
                offset,
                limit,
                hasMore: offset + limit < cached.length
            };
        }
    }

    let totalFound = 0;
    const cacheMatches: Array<{ id: number; preview: string; occurrences: number; offsets: number[]; snippets: string[]; }> = [];
    const targetCount = Math.max(0, offset) + Math.max(1, limit);

    const candidateIds = !matcher && searchStr && settings.store.prebuildSearchIndex
        ? await ModuleSearchEngine.getIndexedCandidates(searchStr)
        : null;
    const moduleIds = candidateIds ? Array.from(candidateIds) : Object.keys(wreq.m);

    for (const id of moduleIds) {
        if (results.length >= limit && totalFound >= targetCount) break;
        const code = ModuleSearchEngine.getModuleCode(id);
        let occurrences = 0;
        let offsets: number[] = [];
        let snippets: string[] = [];
        if (matcher) {
            const matches = Array.from(code.matchAll(matcher));
            occurrences = matches.length;
            offsets = matches.map(m => m.index ?? 0);
            snippets = sliceSnippets(code, matches as unknown as RegExpMatchArray[], 3);
        } else if (searchStr) {
            occurrences = code.split(searchStr).length - 1;
            if (occurrences > 0) {
                let idx = code.indexOf(searchStr);
                while (idx !== -1 && offsets.length < 3) {
                    offsets.push(idx);
                    snippets.push(code.substring(Math.max(0, idx - 60), Math.min(code.length, idx + searchStr.length + 60)).replace(/\s+/g, " "));
                    idx = code.indexOf(searchStr, idx + searchStr.length);
                }
            }
        }
        if (occurrences > 0) {
            totalFound++;
            if (useCache && cacheMatches.length < 200) {
                cacheMatches.push({
                    id: Number(id),
                    preview: code.substring(0, 120).replace(/\s+/g, " "),
                    occurrences,
                    offsets,
                    snippets
                });
            }
            if (totalFound > offset && results.length < limit) {
                results.push({
                    id: Number(id),
                    preview: code.substring(0, 120).replace(/\s+/g, " "),
                    occurrences,
                    offsets,
                    snippets
                });
            }
        }
    }

    if (useCache) {
        ModuleSearchEngine.setLiteralCache(searchStr!, cacheMatches);
    }

    if (preset === "compact" || preset === "minimal") {
        return {
            moduleIds: results.map(r => r.id),
            totalFound,
            offset,
            limit,
            hasMore: totalFound >= targetCount
        };
    }
    return {
        matches: results,
        totalFound,
        offset,
        limit,
        hasMore: totalFound >= targetCount
    };
}

function parsePotentialRegex(query: string, isRegex: boolean): { regex: RegExp | null; patternString: string | null; } {
    if (!isRegex && query.startsWith("/") && query.lastIndexOf("/") > 0) {
        const lastSlash = query.lastIndexOf("/");
        const body = query.substring(1, lastSlash);
        const flags = query.substring(lastSlash + 1);
        try {
            return { regex: new RegExp(body, flags), patternString: null };
        } catch { /* fall through */ }
    }
    if (isRegex) {
        try {
            return { regex: new RegExp(query), patternString: null };
        } catch { /* ignore */ }
    }
    return { regex: null, patternString: query };
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRegexString(arg: string): FindNode {
    if (arg.startsWith("/")) {
        const lastSlash = arg.lastIndexOf("/");
        if (lastSlash > 0) {
            const pattern = arg.substring(1, lastSlash);
            const flags = arg.substring(lastSlash + 1);
            return { type: "regex", value: { pattern, flags } };
        }
    }
    return { type: "string", value: arg };
}

function storeResource(text: string, mimeType: string): string {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    resourceStore.set(id, { mimeType, text, createdAt: Date.now() });
    pruneResources();
    return id;
}

function updateResource(id: string, text: string, mimeType: string): void {
    const entry = resourceStore.get(id);
    if (entry) {
        entry.text = text;
        entry.mimeType = mimeType;
        entry.createdAt = Date.now();
        return;
    }
    resourceStore.set(id, { mimeType, text, createdAt: Date.now() });
    pruneResources();
}

function readResource(id: string, offset?: number, length?: number) {
    const entry = resourceStore.get(id);
    if (!entry) {
        throw new Error(`Resource not found: ${id}`);
    }
    const start = Math.max(0, offset ?? 0);
    const end = length ? start + Math.max(0, length) : entry.text.length;
    const slice = entry.text.slice(start, end);
    return {
        mimeType: entry.mimeType,
        text: slice,
        truncated: end < entry.text.length,
        total: entry.text.length,
        raw: true
    };
}

function pruneResources() {
    const now = Date.now();
    for (const [id, entry] of resourceStore.entries()) {
        if (now - entry.createdAt > RESOURCE_MAX_AGE_MS) {
            resourceStore.delete(id);
        }
    }
    if (resourceStore.size > RESOURCE_MAX_ENTRIES) {
        const oldest = [...resourceStore.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
        for (let i = 0; i < oldest.length - RESOURCE_MAX_ENTRIES; i++) {
            resourceStore.delete(oldest[i][0]);
        }
    }
}

function buildResourceResponse(data: unknown, mimeType = "application/json", previewLength = 800): ToolCallResult {
    if (data && typeof data === "object" && (data as Record<string, unknown>).raw === true) {
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    if (text.length <= previewLength * 4) {
        return { content: [{ type: "text", text }] };
    }
    const resourceId = storeResource(text, mimeType);
    const preview = text.slice(0, previewLength) + "...";
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    resourceId,
                    preview,
                    totalBytes: text.length,
                    mimeType,
                    summary: summarizeValue(data)
                }, null, 2)
            }
        ]
    };
}

function getErrorHint(message: string): string | null {
    if (/required/.test(message)) return "Check required fields in the request.";
    if (/Expected exactly 1 match/.test(message)) return "Refine the find pattern or run patch.unique first.";
    if (/had no effect/.test(message)) return "Match did not apply; check pattern and preview context.";
    if (/Pattern not found/.test(message)) return "Find string did not exist in the target module.";
    if (/timed out|timeout/i.test(message)) return "Retry after Discord finishes loading.";
    return null;
}

function buildErrorResponse(message: string, where?: string): ToolCallResult {
    const hint = getErrorHint(message);
    const payload: Record<string, unknown> = { error: message };
    if (where) payload.where = where;
    if (hint) payload.hint = hint;
    return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: true
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function summarizeValue(value: unknown) {
    if (Array.isArray(value)) {
        return { type: "array", count: value.length };
    }
    if (isPlainObject(value)) {
        const keys = Object.keys(value);
        const arrayCounts: Record<string, number> = {};
        const stringLengths: Record<string, number> = {};
        for (const key of keys) {
            const entry = value[key];
            if (Array.isArray(entry)) arrayCounts[key] = entry.length;
            else if (typeof entry === "string") stringLengths[key] = entry.length;
        }
        return {
            type: "object",
            keys,
            arrayCounts,
            stringLengths
        };
    }
    return { type: typeof value };
}

function trimTopLevel(value: unknown, maxItems?: number, maxChars?: number) {
    const truncation: Record<string, { total?: number; returned?: number; length?: number; truncated?: boolean; }> = {};
    if (Array.isArray(value)) {
        if (typeof maxItems === "number" && maxItems >= 0 && value.length > maxItems) {
            const trimmed = value.slice(0, maxItems);
            return {
                value: { items: trimmed, total: value.length, truncated: true },
                truncation: { __root__: { total: value.length, returned: trimmed.length, truncated: true } }
            };
        }
        return { value, truncation };
    }
    if (isPlainObject(value)) {
        const result: Record<string, unknown> = { ...value };
        for (const [key, entry] of Object.entries(result)) {
            if (Array.isArray(entry) && typeof maxItems === "number" && maxItems >= 0 && entry.length > maxItems) {
                result[key] = entry.slice(0, maxItems);
                truncation[key] = { total: entry.length, returned: (result[key] as unknown[]).length, truncated: true };
            } else if (typeof entry === "string" && typeof maxChars === "number" && maxChars >= 0 && entry.length > maxChars) {
                result[key] = entry.slice(0, Math.max(0, maxChars - 3)) + "...";
                truncation[key] = { length: entry.length, truncated: true };
            }
        }
        return { value: result, truncation };
    }
    if (typeof value === "string" && typeof maxChars === "number" && maxChars >= 0 && value.length > maxChars) {
        return { value: value.slice(0, Math.max(0, maxChars - 3)) + "...", truncation: { __root__: { length: value.length, truncated: true } } };
    }
    return { value, truncation };
}

function buildToolResponse(result: unknown, args?: Record<string, unknown>): ToolCallResult {
    const summary = Boolean(args?.summary);
    const maxItems = typeof args?.maxItems === "number" ? Number(args.maxItems) : undefined;
    const maxChars = typeof args?.maxChars === "number" ? Number(args.maxChars) : undefined;
    if (!summary && maxItems === undefined && maxChars === undefined) {
        return buildResourceResponse(result);
    }
    const defaults = summary
        ? {
            maxItems: maxItems ?? 10,
            maxChars: maxChars ?? 200
        }
        : { maxItems, maxChars };
    const trimmed = trimTopLevel(result, defaults.maxItems, defaults.maxChars);
    const payload = summary
        ? {
            summary: summarizeValue(result),
            truncation: Object.keys(trimmed.truncation).length ? trimmed.truncation : undefined,
            data: trimmed.value
        }
        : (Object.keys(trimmed.truncation).length
            ? { data: trimmed.value, truncation: trimmed.truncation }
            : trimmed.value);
    return buildResourceResponse(payload);
}

function safeSerialize(value: unknown): unknown {
    const seen = new WeakSet<object>();
    const MAX_DEPTH = 6;
    const MAX_KEYS = 40;
    const MAX_ARRAY = 100;
    const MAX_STRING = 10000;

    const serialize = (val: unknown, depth: number): unknown => {
        if (depth > MAX_DEPTH) return "[Max Depth]";
        if (val === null || val === undefined) return val;
        if (typeof val === "bigint") return val.toString();
        if (typeof val === "function") {
            const source = val.toString();
            return source.length > MAX_STRING ? source.slice(0, MAX_STRING) + "..." : source;
        }
        if (typeof val === "string") {
            return val.length > MAX_STRING ? val.slice(0, MAX_STRING) + "..." : val;
        }
        if (typeof val !== "object") return val;

        if (seen.has(val as object)) return "[Circular]";
        seen.add(val as object);

        if (val instanceof Map) {
            return serialize(Object.fromEntries(val), depth + 1);
        }
        if (val instanceof Set) {
            return serialize(Array.from(val), depth + 1);
        }
        if (val instanceof RegExp) return val.toString();
        if (val instanceof Error) {
            return { error: val.message, stack: val.stack };
        }
        if (Array.isArray(val)) {
            return val.slice(0, MAX_ARRAY).map(item => serialize(item, depth + 1));
        }

        const obj: Record<string, unknown> = {};
        for (const key of Object.keys(val as object).slice(0, MAX_KEYS)) {
            obj[key] = serialize((val as Record<string, unknown>)[key], depth + 1);
        }
        return obj;
    };

    try {
        return serialize(value, 0);
    } catch {
        return String(value);
    }
}

function getStoreByName(storeName: string): any | null {
    const results = findAll(filters.byStoreName(storeName));
    return results.length > 0 ? results[0] : null;
}

function resolveModuleIdFromValue(value: unknown): number | null {
    if (!value || (typeof value !== "function" && typeof value !== "object")) return null;
    const obj = value as object & { __moduleId?: number; _moduleId?: number; };
    if (typeof obj.__moduleId === "number") return obj.__moduleId;
    if (typeof obj._moduleId === "number") return obj._moduleId;
    const cached = exportModuleIdCache.get(obj);
    if (typeof cached === "number") return cached;

    const start = performance.now();
    const maxMs = 20;
    const cache = wreq.c ?? {};
    for (const [id, mod] of Object.entries(cache)) {
        if (performance.now() - start > maxMs) break;
        const { exports } = (mod as { exports?: unknown; });
        if (!exports) continue;
        if (exports === obj) {
            exportModuleIdCache.set(obj, Number(id));
            return Number(id);
        }
        if (typeof exports === "object") {
            for (const val of Object.values(exports as Record<string, unknown>)) {
                if (val === obj) {
                    exportModuleIdCache.set(obj, Number(id));
                    return Number(id);
                }
            }
        }
    }
    return null;
}

function resolveComponentNameFromModule(moduleId: number, fallbackName: string | null) {
    if (!moduleId) return null;
    if (componentNameCache.has(moduleId)) return componentNameCache.get(moduleId) ?? null;
    const exports = wreq.c?.[moduleId]?.exports;
    if (!exports) {
        componentNameCache.set(moduleId, null);
        return null;
    }

    const isGoodName = (name: string | null) => Boolean(name && name.length > 2 && name !== fallbackName);
    const candidates: Array<{ name: string | null; source: string; confidence: number; }> = [];

    const pushCandidate = (name: string | null, source: string, confidence: number) => {
        if (isGoodName(name)) candidates.push({ name, source, confidence });
    };

    const collect = (value: any) => {
        if (!value) return;
        if (typeof value === "function") {
            pushCandidate(value.displayName || null, "displayName", 0.9);
            pushCandidate(value.name || null, "functionName", 0.7);
            return;
        }
        if (typeof value === "object") {
            if (typeof value.displayName === "string") {
                pushCandidate(value.displayName, "displayName", 0.85);
            }
            if (typeof value.render === "function") {
                pushCandidate(value.render.displayName || null, "render.displayName", 0.75);
                pushCandidate(value.render.name || null, "render.name", 0.6);
            }
        }
    };

    collect(exports);
    if (typeof exports === "object") {
        for (const [key, value] of Object.entries(exports as Record<string, unknown>).slice(0, 20)) {
            collect(value);
            if (isGoodName(key)) {
                pushCandidate(key, "exportKey", 0.5);
            }
        }
    }

    const resolved = candidates.sort((a, b) => b.confidence - a.confidence)[0] ?? null;
    componentNameCache.set(moduleId, resolved ? { name: resolved.name!, source: resolved.source, confidence: resolved.confidence } : null);
    return componentNameCache.get(moduleId) ?? null;
}

function filterStores(
    stores: Record<string, { found: boolean; moduleId?: number; source?: string; }>,
    filter?: string,
    limit = 50,
    offset = 0
) {
    const keys = Object.keys(stores);
    const filteredKeys = filter
        ? keys.filter(key => key.toLowerCase().includes(filter.toLowerCase()))
        : keys;
    const start = Math.max(0, offset);
    const end = start + Math.max(1, limit);
    const slice = filteredKeys.slice(start, end);
    const result: Record<string, { found: boolean; moduleId?: number; source?: string; }> = {};
    for (const key of slice) {
        result[key] = stores[key];
    }
    return {
        totalFound: filteredKeys.length,
        offset: start,
        limit: Math.max(1, limit),
        hasMore: end < filteredKeys.length,
        stores: result
    };
}

async function handleFindStore(requestData: unknown) {
    const { name } = requestData as StoreFindRequest;
    if (!name?.trim()) {
        throw new Error("store name is required");
    }
    const list = await handleGetStores();
    const stores = list.stores ?? {};
    const exact = Object.keys(stores).find(k => k === name);
    if (exact) {
        return { found: true, name: exact, store: stores[exact] };
    }
    const lower = name.toLowerCase();
    const matches = Object.keys(stores)
        .filter(k => k.toLowerCase().includes(lower))
        .slice(0, 20);
    return { found: false, name, matches };
}

function handleGetStoreMethods(requestData: unknown) {
    const { storeName } = requestData as StoreMethodsRequest;
    if (!storeName?.trim()) {
        throw new Error("storeName is required");
    }
    const store = getStoreByName(storeName);
    if (!store) {
        throw new Error(`Store not found: ${storeName}`);
    }
    const methods = new Set<string>();
    let proto = Object.getPrototypeOf(store);
    while (proto && proto !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(proto)) {
            if (key === "constructor") continue;
            if (typeof (store as any)[key] === "function") {
                methods.add(key);
            }
        }
        proto = Object.getPrototypeOf(proto);
    }
    const moduleId = (store as any).__moduleId ?? (store as any)._moduleId ?? null;
    return {
        storeName,
        moduleId,
        methods: Array.from(methods).sort()
    };
}

async function resolveModuleId(mod: unknown): Promise<number | null> {
    try {
        const code = (mod as { toString?: () => string; })?.toString?.();
        if (!code) return null;
        const moduleId = await findModuleIdAsync(code);
        return typeof moduleId === "number" ? moduleId : null;
    } catch {
        return null;
    }
}

function getModuleKeySample(mod: Record<string, unknown>, maxKeys = 20) {
    const keys = Object.keys(mod);
    return {
        keys,
        sample: Object.fromEntries(keys.slice(0, maxKeys).map(k => [k, typeof mod[k]]))
    };
}

async function handleFindByProps(requestData: unknown) {
    const { props } = requestData as FindByPropsRequest;
    if (!props?.length) {
        throw new Error("props is required");
    }
    const results = findAll(filters.byProps(...props));
    if (!results.length) {
        return { found: false, message: "No module found with those props" };
    }
    const moduleId = await resolveModuleId(results[0]);
    const { keys, sample } = getModuleKeySample(results[0] as Record<string, unknown>);
    return { found: true, moduleId, keys, sample };
}

async function handleFindByCode(requestData: unknown) {
    const { code } = requestData as FindByCodeRequest;
    if (!code?.length) {
        throw new Error("code is required");
    }
    const results = findAll(filters.byCode(...code));
    if (!results.length) {
        return { found: false, message: "No module found with that code" };
    }
    const moduleId = await resolveModuleId(results[0]);
    const mod = results[0] as any;
    if (typeof mod === "function") {
        return {
            found: true,
            moduleId,
            type: "function",
            sourcePreview: mod.toString().slice(0, 5000)
        };
    }
    const { keys, sample } = getModuleKeySample(mod ?? {});
    return { found: true, moduleId, type: typeof mod, keys, sample };
}

async function handleFindComponentByCode(requestData: unknown) {
    const { code } = requestData as FindComponentByCodeRequest;
    if (!code?.length) {
        throw new Error("code is required");
    }
    const results = findAll(filters.componentByCode(...code));
    if (!results.length) {
        return { found: false, message: "No component found with that code" };
    }
    const comp = results[0] as any;
    const moduleId = await resolveModuleId(comp);
    return {
        found: true,
        moduleId,
        type: typeof comp,
        displayName: comp.displayName ?? comp.name ?? "Anonymous",
        sourcePreview: typeof comp === "function" ? comp.toString().slice(0, 5000) : null
    };
}

function handleFindAll(requestData: unknown) {
    const { props, limit = 20 } = requestData as FindAllRequest;
    if (!props?.length) {
        throw new Error("props is required");
    }
    const mods = findAll(filters.byProps(...props));
    const modules = mods.slice(0, limit).map((mod, index) => {
        const { keys, sample } = getModuleKeySample(mod as Record<string, unknown>, 10);
        return { index, keys: keys.slice(0, 30), sample };
    });
    return { count: mods.length, modules };
}

function handleGetModuleIds(requestData: unknown) {
    const { limit = 100 } = requestData as GetModuleIdsRequest;
    const ids = Object.keys(wreq.m).slice(0, limit);
    return { total: Object.keys(wreq.m).length, ids };
}

function handleGetFluxEvents(requestData: unknown) {
    const { filter } = requestData as GetFluxEventsRequest;
    const dispatcher: any = FluxDispatcher as any;
    const handlers = dispatcher?._actionHandlers?._orderedActionHandlers ?? dispatcher?._actionHandlers ?? dispatcher?._handlers ?? {};
    let events = Object.keys(handlers).sort();
    if (filter) {
        const lower = filter.toLowerCase();
        events = events.filter(e => e.toLowerCase().includes(lower));
    }
    return { count: events.length, events };
}

function handleGetIntlKeys(requestData: unknown) {
    const { filter, limit = 50 } = requestData as GetIntlKeysRequest;
    const baseObj = (Common as any)?.i18n?.t?.$$baseObject ?? {};
    let keys = Object.keys(baseObj).filter(k => /^[A-Z][A-Z_0-9]+$/.test(k));
    if (filter) {
        const lower = filter.toLowerCase();
        keys = keys.filter(k => k.toLowerCase().includes(lower));
    }
    return { count: keys.length, keys: keys.sort().slice(0, limit) };
}

function handleDecodeSnowflake(requestData: unknown) {
    const { snowflake } = requestData as { snowflake: string; };
    if (!snowflake?.trim()) {
        throw new Error("snowflake is required");
    }
    const value = BigInt(snowflake);
    const discordEpoch = 1420070400000n;
    const timestampMs = Number((value >> 22n) + discordEpoch);
    return {
        snowflake,
        timestampMs,
        timestampIso: new Date(timestampMs).toISOString(),
        workerId: Number((value & 0x3e0000n) >> 17n),
        processId: Number((value & 0x1f000n) >> 12n),
        increment: Number(value & 0xfffn)
    };
}

function handleComponentLocator(requestData: unknown) {
    const { query, isRegex = false, limit = 20 } = requestData as ComponentLocatorRequest;
    const patternInfo = parsePotentialRegex(query, isRegex);
    const results: Array<{ name: string; moduleId: number; preview: string; exports: string[]; patched: boolean; }> = [];
    const displayNameRegex = /displayName\s*[:=]\s*["'`]([A-Za-z0-9_$-]+)["'`]/;
    const componentNameRegex = /(?:function|class|const|let|var)\s+([A-Z][A-Za-z0-9_]*)/;

    for (const id of Object.keys(wreq?.m ?? {})) {
        if (results.length >= limit) break;
        try {
            const code = ModuleSearchEngine.getModuleCode(id);
            if (typeof code !== "string") continue;
            let matched = false;
            if (patternInfo.regex) {
                matched = patternInfo.regex.test(code);
            } else if (patternInfo.patternString) {
                matched = code.includes(patternInfo.patternString);
            }
            if (matched) {
                const displayMatch = code.match(displayNameRegex);
                const name =
                    displayMatch?.[1] ||
                    code.match(componentNameRegex)?.[1] ||
                    "UnknownComponent";
                const cache = wreq.c ?? {};
                const exports = cache[id]?.exports ? Object.keys(cache[id].exports).slice(0, 5) : [];
                let patched = false;
                try {
                    patched = (getFactoryPatchedBy(id)?.size || 0) > 0;
                } catch {
                    patched = false;
                }
                results.push({
                    name,
                    moduleId: Number(id),
                    preview: code.substring(0, 120).replace(/\s+/g, " "),
                    exports,
                    patched
                });
            }
        } catch {
            continue;
        }
    }

    return { components: results };
}

function handleDispatcherActions(requestData: unknown) {
    const { filter, isRegex = false } = requestData as DispatcherActionsRequest;
    const dispatcher: any = FluxDispatcher as any;
    const root = dispatcher?._actionHandlers ?? dispatcher?._handlers;
    const handlers = root?._orderedActionHandlers ?? root;
    if (!handlers) {
        return { error: "Dispatcher handlers not available" };
    }

    const actions: Array<{ type: string; handlers: number; handlerModules?: number[]; previews?: string[]; }> = [];
    const entries = Array.isArray(handlers)
        ? handlers
        : Object.entries(handlers).filter(([key]) => !key.startsWith("_"));

    const { regex, patternString } = parsePotentialRegex(filter || "", isRegex);

    for (const entry of entries) {
        let actionType: string;
        let arr: unknown;
        if (Array.isArray(entry)) {
            actionType = entry[0] as string;
            arr = entry[1];
        } else {
            continue;
        }

        if (regex && !regex.test(actionType)) continue;
        if (!regex && patternString && !actionType.includes(patternString)) continue;

        let count = 0;
        let modules: number[] = [];
        let previews: string[] = [];

        if (Array.isArray(arr)) {
            count = arr.length;
            modules = arr
                .map((h: any) => h?.__moduleId || h?._moduleId)
                .filter((x: any) => typeof x === "number")
                .slice(0, 5);
        } else if (arr && typeof arr === "object") {
            const keys = Object.keys(arr);
            count = keys.length;
            modules = keys
                .map(k => (arr as any)[k]?.__moduleId || (arr as any)[k]?._moduleId)
                .filter((x: any) => typeof x === "number")
                .slice(0, 5);
        }

        // Attempt to get a small preview from handler module code
        if (modules.length) {
            previews = modules.map(mid => {
                const code = ModuleSearchEngine.getModuleCode(String(mid));
                return code.substring(0, 80).replace(/\s+/g, " ");
            }).slice(0, 2);
        }

        actions.push({ type: actionType, handlers: count, handlerModules: modules, previews });
    }

    actions.sort((a, b) => b.handlers - a.handlers);
    return { actions, total: actions.length };
}

function handleEventListenerAudit(requestData: unknown) {
    const { event, limit = 20 } = requestData as EventListenerAuditRequest;
    const listeners: Array<{ moduleId: number; eventGuess?: string; matchCount: number; preview: string; offsets?: number[]; snippets?: string[]; }> = [];
    const searchPattern = event
        ? new RegExp(`addEventListener\\s*\\(\\s*['"]${event.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`, "gi")
        : /addEventListener\s*\(\s*['"]([A-Za-z0-9_-]+)['"]/gi;

    for (const id in wreq.m) {
        if (listeners.length >= limit) break;
        const code = ModuleSearchEngine.getModuleCode(id);
        const matches = Array.from(code.matchAll(searchPattern));
        if (matches.length) {
            const eventGuess = matches[0]?.[1] || event;
            const offsets = matches.map(m => m.index ?? 0).slice(0, 3);
            const snippets = sliceSnippets(code, matches as unknown as RegExpMatchArray[], 3, 80);
            listeners.push({
                moduleId: Number(id),
                eventGuess,
                matchCount: matches.length,
                preview: code.substring(0, 140).replace(/\s+/g, " "),
                offsets,
                snippets
            });
        }
    }

    return { listeners, total: listeners.length };
}

async function handleEvaluateCode(requestData: unknown) {
    const { code, async: asyncMode = false, expression = false, timeoutMs = 8000, maxOutputChars = 20000 } = requestData as EvaluateCodeRequest;
    if (!code?.trim()) {
        throw new Error("code is required");
    }
    (evalSession.vars as Record<string, unknown> & { reset?: () => boolean; }).reset = () => {
        for (const key of Object.keys(evalSession.vars)) {
            if (key !== "reset") delete (evalSession.vars as Record<string, unknown>)[key];
        }
        return true;
    };
    const ctx = {
        wreq,
        Vencord,
        FluxDispatcher,
        RestAPI,
        Constants,
        Common,
        stores: {
            get: getStoreByName,
            list: () => Array.from(fluxStores.keys())
        },
        session: evalSession.vars
    };
    const body = expression ? `return (${code});` : code;
    const wrapper = asyncMode
        ? `"use strict"; const { wreq, Vencord, FluxDispatcher, RestAPI, Constants, Common, stores, session } = ctx; return (async function(){${body}\n})();`
        : `"use strict"; const { wreq, Vencord, FluxDispatcher, RestAPI, Constants, Common, stores, session } = ctx; return (function(){${body}\n})();`;
    const fn = new Function("ctx", wrapper);
    try {
        const result = fn(ctx);
        const shouldTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
        const resolveResult = async () => {
            if (result && typeof result.then === "function") {
                return await result;
            }
            return result;
        };
        const isPromise = Boolean(result && typeof (result as { then?: unknown; }).then === "function");
        const resolved = shouldTimeout && isPromise
            ? await Promise.race([
                resolveResult(),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`evaluateCode timed out after ${timeoutMs}ms`)), timeoutMs))
            ])
            : await resolveResult();
        const serialized = safeSerialize(resolved);
        const maxChars = Math.max(100, Math.min(200000, Number(maxOutputChars ?? 20000)));
        const asText = JSON.stringify(serialized);
        if (asText.length > maxChars) {
            return {
                resultPreview: asText.slice(0, maxChars),
                truncated: true,
                maxOutputChars: maxChars
            };
        }
        return { result: serialized };
    } catch (err) {
        const stack = err instanceof Error ? err.stack ?? "" : String(err);
        const match = stack.match(/<anonymous>:(\d+):(\d+)/) ?? stack.match(/eval at .*?:(\d+):(\d+)/);
        const line = match ? Number(match[1]) : null;
        const column = match ? Number(match[2]) : null;
        return {
            error: {
                message: err instanceof Error ? err.message : String(err),
                line,
                column,
                stack
            }
        };
    }
}

async function handleCallRestApi(requestData: unknown) {
    const { method, url, body, query, headers } = requestData as CallRestApiRequest;
    if (!method || !url) {
        throw new Error("method and url are required");
    }
    const methodKey = String(method).toLowerCase();
    const client = RestAPI as unknown as Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
    const fn = client[methodKey];
    if (typeof fn !== "function") {
        throw new Error(`Unsupported method: ${method}`);
    }
    const response = await fn({ url, body, query, headers });
    return { response: safeSerialize(response) };
}

function handleGetStoreState(requestData: unknown) {
    const { storeName, method, args } = requestData as GetStoreStateRequest & { method?: string; args?: unknown[]; };
    if (!storeName?.trim()) {
        throw new Error("storeName is required");
    }
    const store = getStoreByName(storeName);
    if (!store) {
        throw new Error(`Store not found: ${storeName}`);
    }
    const state =
        store.getState?.() ??
        store.getCurrentState?.() ??
        store.getRawState?.() ??
        store.state ??
        store._state;
    const proto = Object.getPrototypeOf(store);
    const methods = Object.getOwnPropertyNames(proto)
        .filter(n => n !== "constructor" && typeof (store as any)[n] === "function");
    const properties = Object.keys(store).slice(0, 50);
    let methodResult: unknown = undefined;
    let methodError: string | null = null;
    if (method) {
        const fn = (store as any)[method];
        if (typeof fn !== "function") {
            methodError = `Method "${method}" not found or not a function`;
        } else {
            try {
                methodResult = fn.apply(store, Array.isArray(args) ? args : []);
            } catch (err) {
                methodError = err instanceof Error ? err.message : String(err);
            }
        }
    }
    return {
        storeName,
        state: safeSerialize(state),
        hasState: state !== undefined,
        methods,
        properties,
        method,
        methodResult: safeSerialize(methodResult),
        methodError
    };
}

function handleStoreDiff(requestData: StoreDiffRequest) {
    const { storeName, limit = 50 } = requestData;
    if (!storeName?.trim()) {
        throw new Error("storeName is required");
    }
    const store = getStoreByName(storeName);
    if (!store) {
        throw new Error(`Store not found: ${storeName}`);
    }
    const currentState =
        store.getState?.() ??
        store.getCurrentState?.() ??
        store.getRawState?.() ??
        store.state ??
        store._state;
    const serialized = safeSerialize(currentState);
    const current = (serialized && typeof serialized === "object") ? serialized as Record<string, unknown> : { __value: serialized };
    const previous = storeSnapshots.get(storeName) ?? null;
    storeSnapshots.set(storeName, current);
    if (!previous) {
        return { storeName, baseline: true, keys: Object.keys(current).length };
    }

    const added: string[] = [];
    const removed: string[] = [];
    const changed: Array<{ key: string; before: unknown; after: unknown; }> = [];
    const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
    for (const key of keys) {
        const before = (previous as Record<string, unknown>)[key];
        const after = (current as Record<string, unknown>)[key];
        if (!(key in previous)) {
            added.push(key);
        } else if (!(key in current)) {
            removed.push(key);
        } else if (JSON.stringify(before) !== JSON.stringify(after)) {
            changed.push({ key, before, after });
        }
        if (changed.length >= limit) break;
    }

    return {
        storeName,
        baseline: false,
        added,
        removed,
        changed,
        totalKeys: keys.size
    };
}

function handleGetStoreSubscriptions(requestData: unknown) {
    const { storeName, limit = 50 } = requestData as GetStoreSubscriptionsRequest;
    if (!storeName?.trim()) {
        throw new Error("storeName is required");
    }
    const store = getStoreByName(storeName);
    if (!store) {
        throw new Error(`Store not found: ${storeName}`);
    }
    const moduleId = store.__moduleId ?? store._moduleId ?? null;
    const dispatcher: any = FluxDispatcher as any;
    const handlers = dispatcher?._actionHandlers || dispatcher?._handlers;
    if (!handlers) {
        return { storeName, moduleId, actionTypes: [], total: 0 };
    }

    const actionTypes: string[] = [];
    const actions: Array<{ type: string; handlers: number; handlerModules: number[]; previews: string[]; }> = [];
    const entries = Array.isArray(handlers) ? handlers : Object.entries(handlers);
    for (const entry of entries) {
        if (!Array.isArray(entry)) continue;
        const actionType = entry[0] as string;
        const list = entry[1] as any;
        const arr = Array.isArray(list) ? list : Object.values(list || {});
        if (moduleId != null) {
            const hit = arr.some(h => h?.__moduleId === moduleId || h?._moduleId === moduleId);
            if (hit) {
                actionTypes.push(actionType);
                const handlerModules = arr
                    .map((h: any) => h?.__moduleId || h?._moduleId)
                    .filter((x: any) => typeof x === "number")
                    .slice(0, 5);
                const previews = handlerModules.slice(0, 2).map(mid => {
                    const code = ModuleSearchEngine.getModuleCode(String(mid));
                    return code.substring(0, 80).replace(/\s+/g, " ");
                });
                actions.push({
                    type: actionType,
                    handlers: arr.length,
                    handlerModules,
                    previews
                });
                if (actions.length >= limit) break;
            }
        }
    }

    return {
        storeName,
        moduleId,
        actionTypes,
        actions,
        total: actionTypes.length
    };
}

function startTrace(
    filter?: string,
    isRegex?: boolean,
    maxEntries?: number,
    redact?: boolean,
    fields?: string[],
    sampleRate?: number,
    matchPayload?: string,
    maxPayloadDepth?: number | null
) {
    if (traceState.active) {
        return { started: true, alreadyActive: true, total: traceState.events.length };
    }
    const { regex, patternString } = parsePotentialRegex(filter ?? "", isRegex ?? false);
    const payloadMatcher = createTextMatcher(matchPayload, isRegex);
    traceState.maxEntries = Math.max(50, Math.min(2000, Number(maxEntries ?? traceState.maxEntries)));
    traceState.redact = Boolean(redact ?? traceState.redact);
    traceState.fields = Array.isArray(fields) && fields.length ? fields : null;
    traceState.filter = filter ?? null;
    traceState.isRegex = Boolean(isRegex);
    if (maxPayloadDepth !== undefined && maxPayloadDepth !== null) {
        traceState.maxPayloadDepth = Math.max(1, Math.min(10, Number(maxPayloadDepth)));
    }
    const nextSampleRate = Number.isFinite(sampleRate as number) ? Number(sampleRate) : traceState.sampleRate;
    traceState.sampleRate = Math.max(0, Math.min(1, nextSampleRate || 0));
    traceState.matchPayload = { matcher: payloadMatcher, isRegex: Boolean(isRegex), pattern: matchPayload ?? null };

    const interceptor = (action: Record<string, unknown>) => {
        const type = String(action?.type ?? "UNKNOWN");
        if (regex && !regex.test(type)) return action;
        if (!regex && patternString && !type.includes(patternString)) return action;
        if (traceState.sampleRate > 0 && traceState.sampleRate < 1 && Math.random() > traceState.sampleRate) {
            return action;
        }
        if (traceState.matchPayload.matcher) {
            const payloadText = JSON.stringify(safeSerialize(action));
            if (!traceState.matchPayload.matcher(payloadText)) return action;
        }
        const entry: TraceEntry = {
            type,
            timestamp: Date.now(),
            payload: safeSerialize(action)
        };
        traceState.events.push(entry);
        if (traceState.events.length > traceState.maxEntries) {
            traceState.events.shift();
        }
        return action;
    };

    if (typeof (FluxDispatcher as any).addInterceptor !== "function") {
        throw new Error("FluxDispatcher.addInterceptor is not available");
    }

    (FluxDispatcher as any).addInterceptor(interceptor);
    traceState.active = true;
    traceState.interceptor = interceptor;
    return { started: true, alreadyActive: false, maxEntries: traceState.maxEntries };
}

function stopTrace() {
    if (traceState.interceptor) {
        const interceptors = (FluxDispatcher as any)._interceptors;
        if (Array.isArray(interceptors)) {
            const index = interceptors.indexOf(traceState.interceptor);
            if (index > -1) interceptors.splice(index, 1);
        }
    }
    traceState.active = false;
    traceState.interceptor = null;
    for (const entry of storeWatchers.values()) {
        try {
            entry.remove();
        } catch { }
    }
    storeWatchers.clear();
}

function handleTraceStore(storeName: string) {
    const store = getStoreByName(storeName);
    if (!store) {
        throw new Error(`Store not found: ${storeName}`);
    }
    if (storeWatchers.has(storeName)) {
        return { storeName, watching: true };
    }
    const add =
        (store as any).addChangeListener ??
        (store as any).addListener ??
        (store as any).addEventListener;
    const remove =
        (store as any).removeChangeListener ??
        (store as any).removeListener ??
        (store as any).removeEventListener;
    if (typeof add !== "function") {
        throw new Error("Store does not support change listeners");
    }
    const handler = () => {
        const entry: TraceEntry = {
            type: "STORE_CHANGE",
            timestamp: Date.now(),
            payload: { storeName }
        };
        traceState.events.push(entry);
        if (traceState.events.length > traceState.maxEntries) {
            traceState.events.shift();
        }
    };
    add.call(store, handler);
    const removeFn = typeof remove === "function" ? () => remove.call(store, handler) : () => { };
    storeWatchers.set(storeName, { store, handler, remove: removeFn });
    return { storeName, watching: true };
}

function handleTrace(requestData: TraceRequest) {
    const {
        action,
        filter,
        isRegex,
        storeName,
        limit = 50,
        offset = 0,
        maxEntries,
        redact,
        fields,
        sampleRate,
        matchPayload,
        maxPayloadChars,
        maxPayloadDepth
    } = requestData;
    if (action === "events") return handleGetFluxEvents({ filter });
    if (action === "handlers") {
        return handleDispatcherActions({ filter: requestData.event ?? filter, isRegex });
    }
    if (action === "storeEvents") {
        if (!storeName) throw new Error("storeName is required");
        return handleGetStoreSubscriptions({ storeName });
    }
    if (action === "start") {
        return startTrace(filter, isRegex, maxEntries, redact, fields, sampleRate, matchPayload, maxPayloadDepth);
    }
    if (action === "stop") {
        stopTrace();
        return { success: true };
    }
    if (action === "clear") {
        traceState.events = [];
        return { cleared: true };
    }
    if (action === "status") {
        return {
            active: traceState.active,
            total: traceState.events.length,
            config: {
                filter: traceState.filter,
                isRegex: traceState.isRegex,
                redact: traceState.redact,
                fields: traceState.fields,
                maxEntries: traceState.maxEntries,
                sampleRate: traceState.sampleRate,
                matchPayload: traceState.matchPayload.pattern,
                maxPayloadDepth: traceState.maxPayloadDepth
            }
        };
    }
    if (action === "store") {
        if (!storeName) throw new Error("storeName is required");
        return handleTraceStore(storeName);
    }

    const applyRedaction = Boolean(redact ?? traceState.redact);
    const fieldAllowlist = Array.isArray(fields) && fields.length ? fields : traceState.fields;
    const depthLimit = maxPayloadDepth ?? traceState.maxPayloadDepth;
    const slice = traceState.events.slice(offset, offset + limit).map(entry => {
        const filtered = filterFields(entry.payload, fieldAllowlist);
        const payload = applyRedaction ? redactSensitive(filtered) : filtered;
        const depthTrimmed = truncatePayloadDepth(payload, depthLimit);
        return { ...entry, payload: truncatePayload(depthTrimmed, maxPayloadChars) };
    });
    return {
        active: traceState.active,
        total: traceState.events.length,
        offset,
        limit,
        events: slice
    };
}

function resolveInterceptTarget(moduleId: number, exportName?: string, path?: string) {
    const mod = wreq.c[moduleId];
    const exports = mod?.exports ?? wreq(moduleId);
    let target: any = exportName ? (exports as any)?.[exportName] : (exports as any)?.default ?? exports;
    let parent: any = null;
    let key: string | null = null;
    let descriptor: PropertyDescriptor | undefined;

    if (path) {
        const parts = path.split(".").filter(Boolean);
        for (const part of parts) {
            parent = target;
            key = part;
            target = target?.[part];
        }
    } else if (exportName) {
        parent = exports;
        key = exportName;
    }

    if (parent && key) {
        descriptor = Object.getOwnPropertyDescriptor(parent, key);
    }

    return { exports, target, parent, key, descriptor };
}

function createTextMatcher(pattern?: string, isRegex?: boolean): ((text: string) => boolean) | null {
    if (!pattern) return null;
    const { regex, patternString } = parsePotentialRegex(pattern, Boolean(isRegex));
    if (regex) {
        return text => {
            if (regex.global) regex.lastIndex = 0;
            return regex.test(text);
        };
    }
    if (patternString) return text => text.includes(patternString);
    return null;
}

function handleIntercept(requestData: InterceptRequest) {
    const {
        action,
        moduleId,
        exportName,
        path,
        id,
        limit = 50,
        offset = 0,
        maxEntries,
        sampleRate = 1,
        matchArgs,
        matchResult,
        isRegex
    } = requestData;
    if (action === "status") {
        const items = Array.from(intercepts.values()).slice(offset, offset + limit).map(entry => ({
            id: entry.id,
            target: entry.targetLabel,
            maxEntries: entry.maxEntries,
            sampleRate: entry.sampleRate,
            matchArgs: entry.matchArgs ?? null,
            matchResult: entry.matchResult ?? null,
            isRegex: entry.isRegex ?? false,
            total: entry.calls.length
        }));
        return {
            active: intercepts.size > 0,
            total: intercepts.size,
            offset,
            limit,
            intercepts: items
        };
    }
    if (action === "get") {
        if (!id) throw new Error("id is required");
        const entry = intercepts.get(id);
        if (!entry) return { id, active: false };
        return {
            id,
            active: true,
            target: entry.targetLabel,
            total: entry.calls.length,
            offset,
            limit,
            calls: entry.calls.slice(offset, offset + limit)
        };
    }
    if (action === "stop") {
        if (!id) throw new Error("id is required");
        const entry = intercepts.get(id);
        if (entry) {
            entry.restore();
            intercepts.delete(id);
            return { id, stopped: true };
        }
        return { id, stopped: false };
    }

    if (typeof moduleId !== "number") throw new Error("moduleId is required");
    const resolvedId = id ?? `${moduleId}:${exportName ?? "default"}:${path ?? "export"}`;
    if (intercepts.has(resolvedId)) {
        return { id: resolvedId, active: true, alreadyActive: true };
    }

    const { exports, target, parent, key, descriptor } = resolveInterceptTarget(moduleId, exportName, path);
    let targetFn = target;
    let getterDescriptor: PropertyDescriptor | null = null;

    if (descriptor?.get && !descriptor.set && !descriptor.writable) {
        if (descriptor.configurable === false) {
            throw new Error("Target is read-only and non-configurable");
        }
        getterDescriptor = descriptor;
        const getterValue = descriptor.get.call(parent);
        if (typeof getterValue !== "function") {
            throw new Error("Target is not a function");
        }
        targetFn = getterValue;
    }

    if (typeof targetFn !== "function") {
        throw new Error("Target is not a function");
    }

    const max = Math.max(10, Math.min(2000, Number(maxEntries ?? 200)));
    const sample = Math.max(0, Math.min(1, Number(sampleRate ?? 1)));
    const argsMatcher = createTextMatcher(matchArgs, isRegex);
    const resultMatcher = createTextMatcher(matchResult, isRegex);
    const calls: Array<{ timestamp: number; args: unknown[]; result?: unknown; error?: string; }> = [];
    const original = targetFn;
    const wrapper = function (this: unknown, ...args: unknown[]) {
        const serializedArgs = safeSerialize(args);
        const entryArgs = Array.isArray(serializedArgs) ? serializedArgs : [];
        if (sample < 1 && Math.random() > sample) {
            return original.apply(this, args);
        }
        if (argsMatcher && !argsMatcher(JSON.stringify(serializedArgs))) {
            return original.apply(this, args);
        }
        const entry: { timestamp: number; args: unknown[]; result?: unknown; error?: string; } = {
            timestamp: Date.now(),
            args: entryArgs
        };
        try {
            const result = original.apply(this, args);
            if (result && typeof (result as any).then === "function") {
                entry.result = { status: "pending" };
                (result as Promise<unknown>)
                    .then(resolved => {
                        const serialized = safeSerialize(resolved);
                        if (!resultMatcher || resultMatcher(JSON.stringify(serialized))) {
                            entry.result = { status: "resolved", value: serialized };
                            calls.push(entry as { timestamp: number; args: unknown[]; result?: unknown; error?: string; });
                            if (calls.length > max) calls.shift();
                        }
                    })
                    .catch(err => {
                        const errorText = err instanceof Error ? err.message : String(err);
                        if (!resultMatcher || resultMatcher(errorText)) {
                            entry.result = { status: "rejected", error: errorText };
                            calls.push(entry as { timestamp: number; args: unknown[]; result?: unknown; error?: string; });
                            if (calls.length > max) calls.shift();
                        }
                    });
            } else {
                const serialized = safeSerialize(result);
                if (!resultMatcher || resultMatcher(JSON.stringify(serialized))) {
                    entry.result = serialized;
                    calls.push(entry as { timestamp: number; args: unknown[]; result?: unknown; error?: string; });
                    if (calls.length > max) calls.shift();
                }
            }
            return result;
        } catch (err) {
            entry.error = err instanceof Error ? err.message : String(err);
            if (!resultMatcher || resultMatcher(entry.error)) {
                calls.push(entry as { timestamp: number; args: unknown[]; result?: unknown; error?: string; });
                if (calls.length > max) calls.shift();
            }
            throw err;
        }
    };

    const restore = () => {
        if (parent && key) {
            if (getterDescriptor) {
                Object.defineProperty(parent, key, getterDescriptor);
            } else {
                parent[key] = original;
            }
            return;
        }
        if (exports && wreq.c[moduleId]) {
            wreq.c[moduleId].exports = original as any;
        }
    };

    if (parent && key) {
        if (getterDescriptor) {
            Object.defineProperty(parent, key, {
                configurable: getterDescriptor.configurable ?? true,
                enumerable: getterDescriptor.enumerable ?? true,
                get: () => wrapper
            });
        } else {
            parent[key] = wrapper;
        }
    } else if (wreq.c[moduleId]) {
        wreq.c[moduleId].exports = wrapper as any;
    } else {
        throw new Error("Module is not loaded");
    }

    intercepts.set(resolvedId, {
        id: resolvedId,
        targetLabel: `${moduleId}:${exportName ?? "default"}${path ? `.${path}` : ""}`,
        calls,
        maxEntries: max,
        sampleRate: sample,
        matchArgs,
        matchResult,
        isRegex,
        restore
    });

    return { id: resolvedId, active: true, maxEntries: max };
}

function clearIntercepts() {
    for (const entry of intercepts.values()) {
        try {
            entry.restore();
        } catch { }
    }
    intercepts.clear();
}

function handleGetCurrentContext(): GetCurrentContextResult {
    const user = Common.UserStore?.getCurrentUser?.();
    const locale = (Common as any)?.i18n?.getLocale?.() ?? null;
    const moduleCount = Object.keys(wreq?.m ?? {}).length;
    const selectedChannelId = Common.SelectedChannelStore?.getChannelId?.() ?? null;
    const selectedGuildId = Common.SelectedGuildStore?.getGuildId?.() ?? null;
    const channel = selectedChannelId ? Common.ChannelStore?.getChannel?.(selectedChannelId) : null;
    const guild = selectedGuildId ? Common.GuildStore?.getGuild?.(selectedGuildId) : null;
    const guildCount =
        Common.GuildStore?.getGuildCount?.() ??
        Object.keys(Common.GuildStore?.getGuilds?.() ?? {}).length;

    return {
        wsPorts: Array.from(sockets.keys()),
        connections: sockets.size,
        user: user
            ? {
                id: String(user.id),
                username: user.username,
                discriminator: user.discriminator,
                globalName: user.globalName ?? null
            }
            : null,
        channel: channel
            ? {
                id: String(channel.id),
                name: channel.name,
                type: channel.type
            }
            : null,
        guild: guild
            ? {
                id: String(guild.id),
                name: guild.name,
                ownerId: guild.ownerId
            }
            : null,
        buildNumber: (Constants as any)?.BuildNumber ?? null,
        locale,
        moduleCount,
        guildCount
    };
}

async function handleWaitForReady(requestData?: unknown) {
    const { timeoutMs = 5000, intervalMs = 150 } = (requestData ?? {}) as { timeoutMs?: number; intervalMs?: number; };
    const timeout = Math.max(0, Math.min(30000, Number(timeoutMs)));
    const interval = Math.max(50, Math.min(2000, Number(intervalMs)));
    const start = Date.now();

    while (Date.now() - start < timeout) {
        const ready =
            document.readyState === "complete" &&
            !!(Vencord as any)?.Webpack &&
            !!(Vencord as any)?.Plugins;

        if (ready) {
            return { ready: true, waitedMs: Date.now() - start };
        }

        await new Promise(resolve => setTimeout(resolve, interval));
    }

    return { ready: false, waitedMs: Date.now() - start, timeoutMs: timeout };
}

async function handleWaitForIpc(requestData?: unknown) {
    const {
        timeoutMs = settings.store.ipcReadyTimeoutMs ?? 12000,
        intervalMs = settings.store.ipcReadyIntervalMs ?? 300,
        warmupMs = 500
    } = (requestData ?? {}) as { timeoutMs?: number; intervalMs?: number; warmupMs?: number; };
    const timeout = Math.max(1000, Math.min(60000, Number(timeoutMs)));
    const interval = Math.max(100, Math.min(5000, Number(intervalMs)));
    const warmup = Math.max(0, Math.min(5000, Number(warmupMs)));
    const start = Date.now();
    let attempts = 0;

    if (warmup) {
        await new Promise(resolve => setTimeout(resolve, warmup));
    }

    while (Date.now() - start < timeout) {
        attempts++;
        try {
            const ctx = handleGetCurrentContext();
            if (ctx.moduleCount > 0) {
                return {
                    ready: true,
                    attempts,
                    waitedMs: Date.now() - start
                };
            }
        } catch { }
        await new Promise(resolve => setTimeout(resolve, interval));
    }

    return {
        ready: false,
        attempts,
        waitedMs: Date.now() - start,
        timeoutMs: timeout
    };
}

function handleGetEndpoints(requestData: unknown) {
    const { filter } = requestData as GetEndpointsRequest;
    const endpoints = Object.entries(Constants.Endpoints || {});
    const filtered = filter
        ? endpoints.filter(([name]) => name.toLowerCase().includes(filter.toLowerCase()))
        : endpoints;
    return {
        total: filtered.length,
        endpoints: filtered.map(([name, value]) => ({
            name,
            type: typeof value
        }))
    };
}

function handleDispatchFlux(requestData: unknown) {
    const { action } = requestData as DispatchFluxRequest;
    if (!action || typeof action !== "object") {
        throw new Error("action object is required");
    }
    if (typeof action.type !== "string") {
        throw new Error("action.type must be a string");
    }
    FluxDispatcher.dispatch(action as Record<string, unknown> & { type: string; });
    return { success: true };
}

function handleGetCommonModules() {
    return {
        exports: Object.keys(Common).sort()
    };
}

async function handleFindEnum(requestData: unknown) {
    const { query, limit = 20, includeMembers = false } = requestData as FindEnumRequest;
    if (!query?.trim()) {
        throw new Error("query is required");
    }
    const queryText = String(query).trim();
    const key = escapeRegex(queryText);
    const nameQuery = /^[A-Za-z_$][\w$]*$/.test(queryText) ? queryText : undefined;
    const nameKey = nameQuery ? escapeRegex(nameQuery) : null;
    const enumRegex = new RegExp(
        String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{(?=[^}]*\b${key}\b)([^}]*)\}`,
        "g"
    );
    const freezeRegex = new RegExp(String.raw`Object\.freeze\(\s*\{[^}]*\b${key}\b[^}]*\}\s*\)`, "g");
    const exportRegex = new RegExp(String.raw`exports?\.[A-Za-z_$][\w$]*\s*=\s*\{[^}]*\b${key}\b[^}]*\}`, "g");
    const helperRegex = new RegExp(String.raw`\b(?:makeEnum|createEnum|enumify)\s*\(\s*\{[^}]*\b${key}\b[^}]*\}\s*\)`, "g");
    const entriesRegex = new RegExp(String.raw`Object\.fromEntries\(\s*\[[^\]]*\b${key}\b[^\]]*\]\s*\)`, "g");
    const results: Array<{ moduleId: number; enumName: string; preview: string; }> = [];

    const extractEnumMembers = (body: string) => {
        const members = new Set<string>();
        const keyRegex = /(?:^|[,{]\s*)([A-Za-z_$][\w$]*)\s*:/g;
        const stringKeyRegex = /(?:^|[,{]\s*)["']([^"']+)["']\s*:/g;
        let match: RegExpExecArray | null;
        while ((match = keyRegex.exec(body))) {
            members.add(match[1]);
        }
        while ((match = stringKeyRegex.exec(body))) {
            members.add(match[1]);
        }
        return Array.from(members).slice(0, 200);
    };

    if (nameQuery) {
        const nameDeclRegex = new RegExp(String.raw`(?:const|let|var)\s+${nameKey}\s*=\s*\{([^}]*)\}`, "g");
        const nameExportRegex = new RegExp(String.raw`exports?\.\s*${nameKey}\s*=\s*\{([^}]*)\}`, "g");
        for (const id in wreq.m) {
            if (results.length >= limit) break;
            const code = ModuleSearchEngine.getModuleCode(id);
            const declMatch = nameDeclRegex.exec(code) ?? nameExportRegex.exec(code);
            if (declMatch) {
                results.push({
                    moduleId: Number(id),
                    enumName: nameQuery,
                    preview: code.substring(0, 140).replace(/\s+/g, " ")
                });
                if (includeMembers) {
                    const members = extractEnumMembers(declMatch[1]);
                    (results[results.length - 1] as any).members = members;
                    (results[results.length - 1] as any).memberCount = members.length;
                }
            }
            if (!declMatch && code.includes(nameQuery)) {
                const loaded = wreq.c[id]?.exports ?? wreq(id);
                const candidate = (loaded as any)?.[nameQuery];
                if (candidate && typeof candidate === "object") {
                    results.push({
                        moduleId: Number(id),
                        enumName: nameQuery,
                        preview: code.substring(0, 140).replace(/\s+/g, " ")
                    });
                    if (includeMembers) {
                        const members = Object.keys(candidate).slice(0, 200);
                        (results[results.length - 1] as any).members = members;
                        (results[results.length - 1] as any).memberCount = members.length;
                    }
                }
            }
            nameDeclRegex.lastIndex = 0;
            nameExportRegex.lastIndex = 0;
        }
        if (results.length) {
            return { matches: results, totalFound: results.length, mode: "enumName" };
        }
    }

    for (const id in wreq.m) {
        if (results.length >= limit) break;
        const code = ModuleSearchEngine.getModuleCode(id);
        const match = enumRegex.exec(code);
        if (match) {
            results.push({
                moduleId: Number(id),
                enumName: match[1],
                preview: code.substring(0, 140).replace(/\s+/g, " ")
            });
            if (includeMembers) {
                const members = extractEnumMembers(match[2]);
                let resolvedMembers = members;
                if (!resolvedMembers.length) {
                    const loaded = wreq.c[id]?.exports ?? wreq(id);
                    const exported = (loaded as any)?.[match[1]];
                    if (exported && typeof exported === "object") {
                        resolvedMembers = Object.keys(exported).slice(0, 200);
                    } else if (loaded && typeof loaded === "object") {
                        for (const value of Object.values(loaded as Record<string, unknown>)) {
                            if (value && typeof value === "object" && queryText in (value as Record<string, unknown>)) {
                                resolvedMembers = Object.keys(value as Record<string, unknown>).slice(0, 200);
                                break;
                            }
                        }
                    }
                }
                (results[results.length - 1] as any).members = resolvedMembers;
                (results[results.length - 1] as any).memberCount = resolvedMembers.length;
            }
        }
        if (!match) {
            const freezeMatch = freezeRegex.exec(code);
            if (freezeMatch) {
                results.push({
                    moduleId: Number(id),
                    enumName: "Object.freeze",
                    preview: code.substring(0, 140).replace(/\s+/g, " ")
                });
            } else {
                const exportMatch = exportRegex.exec(code);
                if (exportMatch) {
                    results.push({
                        moduleId: Number(id),
                        enumName: "exports",
                        preview: code.substring(0, 140).replace(/\s+/g, " ")
                    });
                } else {
                    const helperMatch = helperRegex.exec(code);
                    if (helperMatch) {
                        results.push({
                            moduleId: Number(id),
                            enumName: "makeEnum",
                            preview: code.substring(0, 140).replace(/\s+/g, " ")
                        });
                    } else {
                        const entriesMatch = entriesRegex.exec(code);
                        if (entriesMatch) {
                            results.push({
                                moduleId: Number(id),
                                enumName: "Object.fromEntries",
                                preview: code.substring(0, 140).replace(/\s+/g, " ")
                            });
                        }
                    }
                }
            }
        }
        enumRegex.lastIndex = 0;
        freezeRegex.lastIndex = 0;
        exportRegex.lastIndex = 0;
        helperRegex.lastIndex = 0;
        entriesRegex.lastIndex = 0;
    }

    if (!results.length && nameQuery) {
        return {
            matches: results,
            totalFound: results.length,
            hint: "No enum by name found in runtime modules; try a member key (ex: MESSAGE_CREATE)."
        };
    }

    return { matches: results, totalFound: results.length };
}

function handleFindExportValue(requestData: unknown) {
    const { moduleId, exportName } = requestData as FindExportValueRequest;
    if (!exportName?.trim()) {
        throw new Error("exportName is required");
    }
    const exports = wreq.c[moduleId]?.exports;
    if (!exports) {
        throw new Error(`Module ${moduleId} is not loaded`);
    }
    const value = exports?.[exportName];
    if (value === undefined) {
        throw new Error(`Export not found: ${exportName}`);
    }
    return {
        moduleId,
        exportName,
        type: typeof value,
        value: safeSerialize(value)
    };
}

function handleGetPrototypeMethods(requestData: unknown) {
    const { moduleId, exportName } = requestData as GetPrototypeMethodsRequest;
    const exports = wreq.c[moduleId]?.exports ?? wreq(moduleId);
    const target = exportName ? exports?.[exportName] : (exports?.default ?? exports);
    if (!target?.prototype) {
        throw new Error("Target has no prototype");
    }
    const methods = Object.getOwnPropertyNames(target.prototype).filter(m => m !== "constructor");
    return {
        moduleId,
        exportName: exportName || (exports?.default ? "default" : "module"),
        methods
    };
}

function handleCanonicalizeIntl(requestData: unknown) {
    const { text } = requestData as CanonicalizeIntlRequest;
    if (!text?.trim()) {
        throw new Error("text is required");
    }
    const matches = Array.from(text.matchAll(/#{intl::([\w$+/]*)(?:::(\w+))?}/g)).map(m => {
        const key = m[1];
        const modifier = m[2];
        const hashed = modifier === "raw" ? key : runtimeHashMessageKey(key);
        return { key, modifier: modifier || null, hashed };
    });
    return {
        canonical: canonicalizeMatch(text),
        matches
    };
}

function handleIntlHash(requestData: unknown) {
    const { key } = requestData as { key: string; };
    if (!key?.trim()) {
        throw new Error("key is required");
    }
    const hash = runtimeHashMessageKey(key);
    return {
        key,
        hash,
        dotNotation: `.${hash}`,
        bracketNotation: `["${hash}"]`,
        findString: `#{intl::${key}}`,
        messageText: getIntlMessageFromHash(hash)
    };
}

async function handleIntlTargets(requestData: unknown) {
    const { key, limit = 20 } = requestData as { key: string; limit?: number; };
    if (!key?.trim()) {
        throw new Error("key is required");
    }
    const hash = runtimeHashMessageKey(key);
    const matches = await handleSearchLiteral({
        query: hash,
        isRegex: false,
        limit,
        offset: 0
    });
    return {
        key,
        hash,
        findString: `#{intl::${key}}`,
        dotNotation: `.${hash}`,
        bracketNotation: `["${hash}"]`,
        matches
    };
}

function handleReverseIntlHash(requestData: unknown) {
    const { hashedKey } = requestData as ReverseIntlHashRequest;
    if (!hashedKey?.trim()) {
        throw new Error("hashedKey is required");
    }
    return {
        hashedKey,
        value: getIntlMessageFromHash(hashedKey)
    };
}

function handleSearchIntlInModule(requestData: unknown) {
    const { moduleId } = requestData as SearchIntlInModuleRequest;
    const code = extractModule(moduleId, true);
    const seen = new Map<string, { key: string; modifier?: string; hashed: string; }>();
    const matches = code.matchAll(/#{intl::([\w$+/]*)(?:::(\w+))?}/g);
    for (const match of matches) {
        const key = match[1];
        const modifier = match[2];
        const hashed = modifier === "raw" ? key : runtimeHashMessageKey(key);
        const id = `${key}::${modifier || ""}`;
        if (!seen.has(id)) {
            seen.set(id, { key, modifier, hashed });
        }
    }
    return {
        moduleId,
        matches: Array.from(seen.values())
    };
}

function handlePluginSettings(requestData: unknown) {
    const { pluginId, pluginName, name, action, values } = requestData as PluginSettingsRequest & { pluginName?: string; name?: string; };
    const resolved = resolvePluginName(pluginId ?? pluginName ?? name);
    if (!resolved) {
        throw new Error("plugin name is required");
    }
    const plugin = Vencord.Plugins.plugins[resolved];
    if (!plugin) {
        throw new Error(`Plugin "${resolved}" not found`);
    }

    const settings = Settings.plugins[resolved] ?? (Settings.plugins[resolved] = { enabled: false });
    const options = (plugin as any).options || {};
    const typeNames = [
        "string",
        "number",
        "bigint",
        "boolean",
        "select",
        "slider",
        "component",
        "custom"
    ];

    const formatValue = (value: unknown) => {
        if (value === undefined) return "undefined";
        if (typeof value === "string") return `"${value}"`;
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    };

    const validate = (key: string, value: unknown) => {
        const opt = options[key];
        if (!opt) return { valid: false, error: "Unknown setting", typeName: "unknown" };
        const type = opt.type ?? opt?.type;
        const typeName = typeNames[type] ?? "unknown";

        let valid = true;
        let error = "";
        switch (typeName) {
            case "string":
                valid = value == null || typeof value === "string";
                break;
            case "number":
            case "slider":
                valid = typeof value === "number" && !Number.isNaN(value);
                break;
            case "bigint":
                valid = typeof value === "bigint" || (typeof value === "string" && value.trim() !== "");
                break;
            case "boolean":
                valid = typeof value === "boolean";
                break;
            case "select": {
                const optionsList = opt.options || [];
                valid = optionsList.some((o: any) => o.value === value);
                break;
            }
            default:
                valid = true;
        }

        if (valid && typeof opt.isValid === "function") {
            const result = opt.isValid.call(settings, value);
            if (result !== true && result !== undefined) {
                valid = false;
                error = typeof result === "string" ? result : "Validation failed";
            }
        }

        if (!valid && !error) {
            error = `Invalid ${typeName} value: ${formatValue(value)}`;
        }
        return { valid, error, typeName };
    };

    if (action === "set" || action === "dry-run") {
        if (!values || typeof values !== "object") {
            throw new Error("values object is required for set/dry-run");
        }
    }

    const entries = Object.keys(options).map(key => {
        const opt = options[key];
        const typeName = typeNames[opt?.type] ?? "unknown";
        const defaultValue =
            opt?.default ??
            (opt?.type === 4 ? opt?.options?.find((o: any) => o.default)?.value : undefined);
        return {
            key,
            value: settings[key],
            default: defaultValue,
            type: typeName,
            description: opt?.description,
            valid: true as boolean,
            error: "" as string | undefined
        };
    });

    if (action === "set" || action === "dry-run") {
        for (const [key, value] of Object.entries(values!)) {
            const existing = entries.find(e => e.key === key);
            const { valid, error, typeName } = validate(key, value);
            if (existing) {
                existing.type = typeName;
                existing.value = value;
                existing.valid = valid;
                existing.error = error || undefined;
            } else {
                entries.push({
                    key,
                    value,
                    default: undefined,
                    type: typeName,
                    description: options[key]?.description,
                    valid,
                    error: error || undefined
                });
            }
        }
    }

    const failed = entries.some(e => !e.valid);
    if (action === "set" && !failed) {
        for (const [key, value] of Object.entries(values!)) {
            const opt = options[key];
            if (opt?.type === 2 && typeof value === "string") {
                settings[key] = BigInt(value);
            } else {
                settings[key] = value;
            }
        }
    }

    return {
        pluginId: resolved,
        updated: action === "set" && !failed,
        settings: entries
    };
}

function handleQueryDom(requestData: unknown) {
    const {
        selector,
        limit = 20,
        includeText = true,
        includeAttrs = false,
        maxTextLength = 200
    } = requestData as QueryDomRequest;

    try {
        const all = Array.from(document.querySelectorAll(selector));
        const nodes = all.slice(0, Math.max(0, limit)).map(el => summarizeNode(el, includeText, includeAttrs, maxTextLength));
        return {
            nodes,
            totalMatches: all.length
        };
    } catch (err) {
        return { error: String(err) };
    }
}

function handleGetElementStyles(requestData: unknown) {
    const { selector, properties } = requestData as { selector: string; properties?: string[]; };
    const el = document.querySelector(selector);
    if (!el) return { found: false, selector, error: "No element matches selector" };

    const computed = window.getComputedStyle(el);
    const styles: Record<string, string> = {};

    if (properties && properties.length > 0) {
        for (const prop of properties.slice(0, 50)) {
            styles[prop] = computed.getPropertyValue(prop);
        }
    } else {
        const commonProps = [
            "display", "position", "width", "height", "margin", "padding",
            "color", "background-color", "background", "border", "border-radius",
            "font-size", "font-family", "font-weight", "line-height",
            "flex", "flex-direction", "align-items", "justify-content", "gap",
            "opacity", "visibility", "overflow", "z-index", "cursor"
        ];
        for (const prop of commonProps) {
            const value = computed.getPropertyValue(prop);
            if (value && value !== "none" && value !== "normal" && value !== "auto" && value !== "0px") {
                styles[prop] = value;
            }
        }
    }

    return { found: true, selector, tagName: el.tagName, styles };
}

function handleDomSnapshot(requestData: unknown) {
    const { selector, properties, includeAttrs = true } = requestData as { selector: string; properties?: string[]; includeAttrs?: boolean; };
    const el = document.querySelector(selector);
    if (!el) return { found: false, selector, error: "No element matches selector" };

    const computed = window.getComputedStyle(el);
    const styles: Record<string, string> = {};
    if (properties && properties.length > 0) {
        for (const prop of properties.slice(0, 50)) {
            styles[prop] = computed.getPropertyValue(prop);
        }
    } else {
        const commonProps = [
            "display", "position", "width", "height", "margin", "padding",
            "color", "background-color", "background", "border", "border-radius",
            "font-size", "font-family", "font-weight", "line-height",
            "flex", "flex-direction", "align-items", "justify-content", "gap",
            "opacity", "visibility", "overflow", "z-index", "cursor"
        ];
        for (const prop of commonProps) {
            const value = computed.getPropertyValue(prop);
            if (value && value !== "none" && value !== "normal" && value !== "auto" && value !== "0px") {
                styles[prop] = value;
            }
        }
    }

    return {
        found: true,
        selector,
        tagName: el.tagName,
        path: elementPath(el),
        classes: Array.from(el.classList),
        attrs: includeAttrs ? collectAttributes(el) : undefined,
        styles
    };
}

function handleModifyElement(requestData: unknown) {
    const { selector, styles, addClass, removeClass, setAttribute } = requestData as {
        selector: string;
        styles?: Record<string, string>;
        addClass?: string;
        removeClass?: string;
        setAttribute?: Record<string, string>;
    };

    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) return { found: false, selector, error: "No element matches selector" };

    const changes: string[] = [];

    if (styles) {
        for (const [prop, value] of Object.entries(styles).slice(0, 20)) {
            el.style.setProperty(prop, value);
            changes.push(`style.${prop}=${value}`);
        }
    }
    if (addClass) {
        el.classList.add(...addClass.split(" ").filter(Boolean));
        changes.push(`addClass:${addClass}`);
    }
    if (removeClass) {
        el.classList.remove(...removeClass.split(" ").filter(Boolean));
        changes.push(`removeClass:${removeClass}`);
    }
    if (setAttribute) {
        for (const [attr, value] of Object.entries(setAttribute).slice(0, 10)) {
            el.setAttribute(attr, value);
            changes.push(`attr.${attr}=${value}`);
        }
    }

    return {
        found: true,
        selector,
        changes,
        note: "Changes are temporary and will be lost on re-render or reload"
    };
}

function handleGetComponentTree(requestData: unknown) {
    const { selector, maxDepth = 50 } = requestData as { selector: string; maxDepth?: number; };
    const el = document.querySelector(selector);
    if (!el) return { found: false, selector, error: "No element matches selector" };

    const fiberKey = Object.keys(el).find(k => k.startsWith("__reactFiber$"));
    if (!fiberKey) {
        return { found: true, selector, hasFiber: false, components: [] };
    }

    const components: Array<{ name: string; hasProps: boolean; propKeys?: string[]; moduleId?: number | null; resolvedName?: string | null; resolvedSource?: string | null; resolvedConfidence?: number | null; }> = [];
    let fiber = (el as unknown as Record<string, unknown>)[fiberKey] as { type?: unknown; memoizedProps?: unknown; return?: unknown; } | null;
    let depth = 0;

    while (fiber && depth < Math.min(maxDepth, 100)) {
        if (fiber.type) {
            const info = getComponentInfoFromFiber(fiber);
            const name = info?.name ?? null;
            if (name && name.length > 1) {
                const hasProps = fiber.memoizedProps != null && typeof fiber.memoizedProps === "object";
                const entry: { name: string; hasProps: boolean; propKeys?: string[]; moduleId?: number | null; resolvedName?: string | null; resolvedSource?: string | null; resolvedConfidence?: number | null; } = {
                    name,
                    hasProps,
                    moduleId: info?.moduleId ?? null,
                    resolvedName: info?.resolvedName ?? null,
                    resolvedSource: info?.resolvedSource ?? null,
                    resolvedConfidence: info?.resolvedConfidence ?? null
                };
                if (hasProps) {
                    entry.propKeys = Object.keys(fiber.memoizedProps as object).slice(0, 20);
                }
                components.push(entry);
            }
        }
        fiber = fiber.return as typeof fiber;
        depth++;
    }

    return {
        found: true,
        selector,
        hasFiber: true,
        componentCount: components.length,
        components: components.slice(0, 50),
        truncated: components.length > 50
    };
}

function getFiberDisplayName(fiber: any): string | null {
    if (!fiber?.type) return null;
    if (typeof fiber.type === "string") return fiber.type;
    if (typeof fiber.type === "function") {
        return fiber.type.displayName || fiber.type.name || null;
    }
    if (typeof fiber.type === "object") {
        return fiber.type.displayName || null;
    }
    return null;
}

function getComponentInfoFromFiber(fiber: any) {
    const name = getFiberDisplayName(fiber);
    if (!name) return null;
    const moduleId = resolveModuleIdFromValue(fiber.type);
    const resolved = moduleId ? resolveComponentNameFromModule(moduleId, name) : null;
    return {
        name,
        moduleId,
        resolvedName: resolved?.name ?? null,
        resolvedSource: resolved?.source ?? null,
        resolvedConfidence: resolved?.confidence ?? null
    };
}

function getNearestComponentInfo(fiber: any) {
    let current = fiber?.return ?? null;
    let depth = 0;
    while (current) {
        const info = getComponentInfoFromFiber(current);
        if (info && info.name !== "div" && info.name !== "span" && typeof current.type !== "string") {
            return { ...info, depthFromTarget: depth + 1 };
        }
        current = current.return;
        depth++;
        if (depth > 50) break;
    }
    return null;
}

function getComponentChain(fiber: any, limit = 15) {
    const chain: string[] = [];
    let current = fiber;
    while (current && chain.length < limit) {
        const info = getComponentInfoFromFiber(current);
        if (info && typeof current.type !== "string") {
            chain.push(info.name);
        }
        current = current.return;
    }
    return chain;
}

function getComponentChainDetails(fiber: any, limit = 15) {
    const chain: Array<{ name: string; moduleId?: number | null; resolvedName?: string | null; resolvedSource?: string | null; resolvedConfidence?: number | null; }> = [];
    let current = fiber;
    while (current && chain.length < limit) {
        const info = getComponentInfoFromFiber(current);
        if (info && typeof current.type !== "string") {
            chain.push({
                name: info.name,
                moduleId: info.moduleId,
                resolvedName: info.resolvedName ?? null,
                resolvedSource: info.resolvedSource ?? null,
                resolvedConfidence: info.resolvedConfidence ?? null
            });
        }
        current = current.return;
    }
    return chain;
}

function buildFiberTree(fiber: any, depth: number, breadth: number): { name: string; hasProps: boolean; propKeys?: string[]; children?: unknown[]; } | null {
    const name = getFiberDisplayName(fiber);
    if (!name) return null;
    const hasProps = fiber.memoizedProps != null && typeof fiber.memoizedProps === "object";
    const node: { name: string; hasProps: boolean; propKeys?: string[]; children?: unknown[]; } = { name, hasProps };
    if (hasProps) {
        node.propKeys = Object.keys(fiber.memoizedProps).slice(0, 20);
    }

    if (depth <= 0) return node;
    const children: unknown[] = [];
    let { child } = fiber;
    let count = 0;
    while (child && count < breadth) {
        const childNode = buildFiberTree(child, depth - 1, breadth);
        if (childNode) {
            children.push(childNode);
        }
        child = child.sibling;
        count++;
    }
    if (children.length) {
        node.children = children;
    }
    return node;
}

function handleGetComponentTreeDetailed(requestData: unknown) {
    const { selector, maxDepth = 20, maxBreadth = 10 } = requestData as {
        selector: string;
        maxDepth?: number;
        maxBreadth?: number;
    };
    const el = document.querySelector(selector);
    if (!el) return { found: false, selector, error: "No element matches selector" };

    const fiberKey = Object.keys(el).find(k => k.startsWith("__reactFiber$"));
    if (!fiberKey) {
        return { found: true, selector, hasFiber: false, tree: null };
    }

    const fiber = (el as unknown as Record<string, unknown>)[fiberKey];
    const tree = buildFiberTree(fiber, Math.min(maxDepth, 50), Math.min(maxBreadth, 25));
    const nearestComponent = getNearestComponentInfo(fiber);
    const componentChain = getComponentChain(fiber);
    const componentChainDetails = getComponentChainDetails(fiber);
    return {
        found: true,
        selector,
        hasFiber: true,
        nearestComponent,
        componentChain,
        componentChainDetails,
        tree
    };
}

function handleInspectDomPath(requestData: unknown) {
    const {
        selector,
        index = 0,
        depth = 2,
        breadth = 10,
        includeText = true,
        maxTextLength = 200
    } = requestData as InspectDomPathRequest;

    try {
        const matches = Array.from(document.querySelectorAll(selector));
        if (index < 0 || index >= matches.length) {
            return { selector, index, found: false };
        }

        const target = matches[index];
        return {
            selector,
            index,
            found: true,
            root: buildTree(target, depth, breadth, includeText, maxTextLength)
        };
    } catch (err) {
        return { error: String(err) };
    }
}

function handleListDomClasses(requestData: unknown) {
    const { maxNodes = 2000, maxClasses = 50 } = requestData as ListDomClassesRequest;

    try {
        const elements = Array.from(document.querySelectorAll("*")).slice(0, Math.max(0, maxNodes));
        const counts = new Map<string, number>();

        for (const el of elements) {
            el.classList.forEach(cls => {
                counts.set(cls, (counts.get(cls) || 0) + 1);
            });
        }

        const classes = Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, Math.max(0, maxClasses))
            .map(([name, count]) => ({ name, count }));

        return {
            classes,
            totalDistinct: counts.size,
            scanned: elements.length
        };
    } catch (err) {
        return { error: String(err) };
    }
}

function handleFindTextNodes(requestData: unknown) {
    const {
        query,
        isRegex = false,
        maxResults = 20,
        maxTextLength = 120
    } = requestData as FindTextNodesRequest;

    let useRegex = isRegex;
    let pattern = query;

    if (!isRegex && query.startsWith("/") && query.lastIndexOf("/") > 0) {
        const lastSlash = query.lastIndexOf("/");
        pattern = query.substring(1, lastSlash);
        const flags = query.substring(lastSlash + 1);
        try {
            // test compilation
            new RegExp(pattern, flags);
            useRegex = true;
            pattern = `/${pattern}/${flags}`;
        } catch (err) {
            return { error: `Invalid regex: ${String(err)}` };
        }
    }

    let matcher: RegExp | null = null;
    if (useRegex) {
        const lastSlash = pattern.lastIndexOf("/");
        const body = pattern.startsWith("/") && lastSlash > 0 ? pattern.substring(1, lastSlash) : pattern;
        const flags = pattern.startsWith("/") && lastSlash > 0 ? pattern.substring(lastSlash + 1) : "g";
        try {
            matcher = new RegExp(body, flags);
        } catch (err) {
            return { error: `Invalid regex: ${String(err)}` };
        }
    }

    const matches: Array<{ text: string; tag: string; id?: string; classes: string[]; path: string; }> = [];
    let totalFound = 0;

    const root = document.body || document.documentElement;
    if (!root) {
        return { error: "No document root found" };
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();

    while (node) {
        const text = (node.textContent || "").trim();
        if (text.length > 0) {
            const matchesSearch = matcher ? (matcher.lastIndex = 0, matcher.test(text)) : text.includes(query);
            if (matchesSearch) {
                totalFound++;
                if (matches.length < Math.max(0, maxResults)) {
                    const parent = node.parentElement;
                    if (parent) {
                        matches.push({
                            text: normalizeText(text, maxTextLength),
                            tag: parent.tagName.toLowerCase(),
                            id: parent.id || undefined,
                            classes: Array.from(parent.classList),
                            path: elementPath(parent)
                        });
                    }
                }
            }
        }

        if (totalFound >= 500) {
            break;
        }

        node = walker.nextNode();
    }

    return { matches, totalFound };
}

const requestLimiterPerPort = new Map<number, Map<string, number>>();
const REQUEST_LIMIT_TIME = 100;
const MAX_REQUESTS_PER_TYPE = 3;

function handlePerformanceMetrics() {
    if (performanceMetrics.length === 0) {
        return {
            avgResponseTime: 0,
            slowestOperation: { type: "none", time: 0 },
            fastestOperation: { type: "none", time: 0 },
            totalRequests: 0,
            cacheHitRate: 0,
            toolCache: {
                enabled: settings.store.cacheEnabled,
                hits: toolCacheHits,
                stores: toolCacheStores,
                entries: toolResponseCache.size,
                maxEntries: settings.store.cacheMaxEntries ?? TOOL_CACHE_MAX_ENTRIES
            }
        };
    }

    const avgTime = performanceMetrics.reduce((sum, m) => sum + m.time, 0) / performanceMetrics.length;
    const sorted = [...performanceMetrics].sort((a, b) => b.time - a.time);

    return {
        avgResponseTime: avgTime,
        slowestOperation: sorted[0],
        fastestOperation: sorted[sorted.length - 1],
        totalRequests: totalMetricRequests,
        cacheHitRate: totalMetricRequests > 0 ? cacheHits / totalMetricRequests : 0,
        toolCache: {
            enabled: settings.store.cacheEnabled,
            hits: toolCacheHits,
            stores: toolCacheStores,
            entries: toolResponseCache.size,
            maxEntries: settings.store.cacheMaxEntries ?? TOOL_CACHE_MAX_ENTRIES
        }
    };
}

export function initWs(isManual = false) {
    if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
    }

    // Pull settings-driven values
    dynamicReconnectAttempts = Math.max(1, Math.min(20, settings.store.maxReconnectAttempts || 5));
    dynamicFallbackSpread = Math.max(0, Math.min(MAX_SCAN_SPREAD, settings.store.scanSpread || 2));
    if (settings.store.prebuildSearchIndex) {
        void ModuleSearchEngine.ensureTokenIndex();
    }
    startWarmupTasks("ws");

    const { ports, hasUserInput } = getPortPlan();
    const attempted = new Set<number>();

    ports.forEach(port => {
        attempted.add(port);
        ensureConnection(port, isManual);
    });

    // Only auto-scan when the user has not provided ports.
    if (!hasUserInput) {
        fallbackTimer = setTimeout(() => {
            const anyOpen = Array.from(sockets.values()).some(sock => sock.readyState === WebSocket.OPEN);
            if (anyOpen) return;
            const fallbackPorts = generateFallbackPorts().filter(p => !attempted.has(p));
            fallbackPorts.forEach(p => {
                attempted.add(p);
                ensureConnection(p, false);
            });
        }, 2000);
    }
}

function generateFallbackPorts(): number[] {
    const ports: number[] = [];
    const spread = dynamicFallbackSpread;
    const start = Math.max(1, DEFAULT_PORT - spread);
    const end = Math.min(65535, DEFAULT_PORT + spread);
    for (let p = start; p <= end; p++) {
        ports.push(p);
    }
    return ports;
}

function getPortPlan(): { ports: number[]; hasUserInput: boolean; } {
    const raw = settings.store.ports?.trim();
    if (!raw || raw === `${DEFAULT_PORT}`) {
        return { ports: generateFallbackPorts(), hasUserInput: false };
    }
    const parts = raw.split(/[,\s]+/).filter(Boolean);
    const parsed: number[] = [];

    for (const part of parts) {
        if (part.includes("-")) {
            const [startStr, endStr] = part.split("-");
            const start = Number(startStr);
            const end = Number(endStr);
            if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end > 0 && start <= 65535 && end <= 65535) {
                const low = Math.min(start, end);
                const high = Math.max(start, end);
                for (let p = low; p <= high && parsed.length < 50; p++) {
                    parsed.push(p);
                }
            }
        } else {
            const num = Number(part);
            if (Number.isFinite(num) && num > 0 && num < 65536) {
                parsed.push(num);
            }
        }
    }

    const unique = Array.from(new Set(parsed));
    return {
        ports: unique.length > 0 ? unique : generateFallbackPorts(),
        hasUserInput: unique.length > 0
    };
}

function getState(port: number): ConnectionState {
    const existing = connections.get(port);
    if (existing) return existing;
    const state: ConnectionState = { reconnectAttempts: 0 };
    connections.set(port, state);
    return state;
}

function ensureConnection(port: number, isManual: boolean) {
    const state = getState(port);

    if (state.reconnectTimeout) {
        clearTimeout(state.reconnectTimeout);
        state.reconnectTimeout = undefined;
    }

    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        return;
    }

    if (state.reconnectAttempts >= dynamicReconnectAttempts) {
        if (isManual) {
            const msg = `Stopped reconnecting on port ${port} after ${state.reconnectAttempts} attempts`;
            logger.warn(msg);
            Toasts.show({
                message: msg,
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                options: { position: Toasts.Position.TOP }
            });
        } else {
            recordStoppedPort(port);
        }
        return;
    }

    try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        state.socket = ws;
        sockets.set(port, ws);
        let hasConnected = false;

        ws.addEventListener("open", () => {
            hasConnected = true;
            state.reconnectAttempts = 0;

            if (settings.store.notifyOnConnect || isManual) {
                Toasts.show({
                    message: `Dev Companion connected (port ${port})`,
                    id: Toasts.genId(),
                    type: Toasts.Type.SUCCESS,
                    options: {
                        position: Toasts.Position.TOP
                    }
                });
            }
        });

        ws.addEventListener("error", () => {
            if (!hasConnected && isManual) {
                logger.error("Failed to connect to MCP server on port " + port);
            }
        });

        ws.addEventListener("close", () => {
            sockets.delete(port);
            state.socket = undefined;
            const delay = Math.min(INITIAL_RECONNECT_DELAY * (1 << state.reconnectAttempts), MAX_RECONNECT_DELAY);
            state.reconnectAttempts++;
            if (state.reconnectAttempts < dynamicReconnectAttempts) {
                state.reconnectTimeout = setTimeout(() => ensureConnection(port, false), delay);
            } else {
                recordStoppedPort(port);
            }
        });

        ws.addEventListener("message", async e => {
            const startTime = performance.now();
            let data: WSMessage;

            try {
                data = JSON.parse(e.data);
            } catch {
                return;
            }

            const { type, data: requestData, nonce } = data;
            if (type !== "tool_call") {
                const error = `Unknown request type: ${type}`;
                ws.send(JSON.stringify({ ok: false, nonce, error }));
                logToolResult({ type: "tool_call", requestData, startTime, error });
                return;
            }
            const toolName = requestData?.name;
            const toolArgs = requestData?.arguments ?? {};
            const raw = requestData?.raw === true;
            if (!toolName) {
                const error = "Missing tool name";
                ws.send(JSON.stringify({ ok: false, nonce, error }));
                logToolResult({ type: "tool_call", requestData, startTime, error });
                return;
            }

            // Per-port rate limiting
            const limiter = requestLimiterPerPort.get(port) || new Map<string, number>();
            requestLimiterPerPort.set(port, limiter);

            const now = Date.now();
            const lastRequest = limiter.get(toolName) || 0;
            if (now - lastRequest < REQUEST_LIMIT_TIME) {
                let recentCount = 0;
                for (const t of limiter.values()) {
                    if (now - t < REQUEST_LIMIT_TIME) recentCount++;
                }
                if (recentCount > MAX_REQUESTS_PER_TYPE) {
                    logger.warn(`Rate limit hit for ${type}, delaying request`);
                    await new Promise(resolve => setTimeout(resolve, REQUEST_LIMIT_TIME));
                }
            }
            limiter.set(toolName, now);

            if (limiter.size > 100) {
                const toDelete: string[] = [];
                for (const [key, t] of limiter.entries()) {
                    if (now - t > 5000) toDelete.push(key);
                }
                toDelete.forEach(k => limiter.delete(k));
            }

            logger.info(`MCP tool called: ${toolName} (port ${port})`);

            function reply(error?: string, responseData?: unknown) {
                const response = {
                    ok: !error,
                    nonce,
                    ...(error ? { error } : { data: responseData })
                };

                ws.send(JSON.stringify(response));
                logToolResult({
                    type: toolName,
                    requestData: toolArgs,
                    startTime,
                    error,
                    responseData
                });
            }

            try {
                const result = raw
                    ? await callMcpToolRaw(toolName, toolArgs as Record<string, unknown>)
                    : await callMcpTool(toolName, toolArgs as Record<string, unknown>);
                reply(undefined, result);
            } catch (error) {
                reply(error instanceof Error ? error.message : String(error));
            }
        });
    } catch (error) {
        logger.error("Failed to create WebSocket: " + String(error));

        if (isManual) {
            Toasts.show({
                message: `Failed to connect to MCP server on port ${port}`,
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                options: {
                    position: Toasts.Position.TOP
                }
            });
        }
    }
}
function sliceSnippets(text: string, matches: RegExpMatchArray[] | null, limit: number, radius = 60): string[] {
    if (!matches) return [];
    const snippets: string[] = [];
    for (let i = 0; i < matches.length && snippets.length < limit; i++) {
        const m = matches[i];
        if (typeof m.index !== "number") continue;
        const start = Math.max(0, m.index - radius);
        const end = Math.min(text.length, m.index + (m[0]?.length || 0) + radius);
        snippets.push(text.slice(start, end).replace(/\s+/g, " "));
    }
    return snippets;
}

function getLineColumn(text: string, index: number) {
    const safeIndex = Math.max(0, Math.min(text.length, index));
    const before = text.slice(0, safeIndex);
    const lines = before.split("\n");
    const line = lines.length;
    const column = lines[lines.length - 1].length + 1;
    return { line, column };
}

function getLineContext(text: string, index: number, contextLines: number) {
    const { line } = getLineColumn(text, index);
    const lines = text.split("\n");
    const start = Math.max(0, line - 1 - contextLines);
    const end = Math.min(lines.length, line - 1 + contextLines + 1);
    const before = lines.slice(start, line - 1);
    const current = lines[line - 1] ?? "";
    const after = lines.slice(line, end);
    return { before, current, after, line };
}

function normalizeRegex(pattern: string | RegExp) {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(escapeRegex(pattern), "g");
    const flags = regex.flags.replace("g", "");
    return new RegExp(regex.source, flags);
}

type MatchContextResult =
    | { found: false; }
    | {
        found: true;
        index: number;
        line: number;
        column: number;
        match: string;
        matchLength: number;
        snippet: string;
        context: ReturnType<typeof getLineContext>;
    };

function getMatchContext(text: string, pattern: string | RegExp, contextLines = 2, radius = 120): MatchContextResult {
    const safePattern = normalizeRegex(pattern);
    const matcher = canonicalizeMatch(safePattern);
    const match = matcher.exec(text);
    if (!match || typeof match.index !== "number") {
        return { found: false };
    }
    const { index } = match;
    const { line, column } = getLineColumn(text, index);
    const snippet = text.slice(Math.max(0, index - radius), Math.min(text.length, index + match[0].length + radius));
    const matchLength = match[0]?.length ?? 0;
    return {
        found: true,
        index,
        line,
        column,
        match: match[0],
        matchLength,
        snippet,
        context: getLineContext(text, index, contextLines)
    };
}

function findLookbehindAnchor(text: string, pattern: string | RegExp) {
    const safePattern = normalizeRegex(pattern);
    const matcher = canonicalizeMatch(safePattern);
    const match = matcher.exec(text);
    if (!match) return null;
    const lastGroup = match.length > 1 ? match[match.length - 1] : "";
    if (!lastGroup) return null;
    const anchorIndex = text.indexOf(lastGroup, match.index ?? 0);
    return anchorIndex >= 0 ? anchorIndex : null;
}

function collectPatchWarnings(
    text: string,
    replacements: Array<{ match: string | { pattern: string; flags: string; }; replace: string; }>
) {
    const warnings: string[] = [];
    const invalidChildrenArrow = /children:[A-Za-z_$][\w$]*\([^)]*\)=>/;
    if (invalidChildrenArrow.test(text)) {
        warnings.push("Detected children:<call>(...)=> pattern; this usually means a replacement hit the render-prop argument instead of the inner children value.");
    }
    if (/,\s*,/.test(text)) {
        warnings.push("Detected consecutive commas; this often means a replacement appended a comma after an existing comma.");
    }
    if (replacements.length > 1) {
        warnings.push("Patch has multiple replacements; consider simplifying to reduce break risk.");
    }
    const selfRefs = new Set<string>();
    for (const replacement of replacements) {
        if (typeof replacement.replace !== "string") continue;
        for (const match of replacement.replace.matchAll(/\$self\.([A-Za-z_$][\w$]*)/g)) {
            selfRefs.add(match[1]);
        }
    }
    if (selfRefs.size) {
        warnings.push(`Patch references $self.${Array.from(selfRefs).join(", ")}; ensure these methods are exported on the plugin object.`);
    }
    return warnings;
}

function trimPreviewText(value: string, maxLength = 160) {
    if (value.length <= maxLength) return value;
    return value.slice(0, Math.max(0, maxLength - 3)) + "...";
}

const SENSITIVE_KEY_REGEX = /token|authorization|cookie|password|pass|email|phone|secret/i;
const TOKEN_VALUE_REGEX = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{10,}/g;

function filterFields(value: unknown, fields?: string[] | null): unknown {
    if (!fields || fields.length === 0) return value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    for (const key of fields) {
        if (key in record) filtered[key] = record[key];
    }
    return filtered;
}

function ensureBaseFields(entry: Record<string, unknown>, base: Record<string, unknown>) {
    for (const [key, value] of Object.entries(base)) {
        if (!(key in entry)) entry[key] = value;
    }
    return entry;
}

function redactSensitive(value: unknown, depth = 0): unknown {
    if (depth > 4) return value;
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
        if (TOKEN_VALUE_REGEX.test(value)) {
            TOKEN_VALUE_REGEX.lastIndex = 0;
            return value.replace(TOKEN_VALUE_REGEX, "[redacted]");
        }
        return value;
    }
    if (typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(item => redactSensitive(item, depth + 1));

    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
        if (SENSITIVE_KEY_REGEX.test(key)) {
            result[key] = "[redacted]";
            continue;
        }
        result[key] = redactSensitive(val, depth + 1);
    }
    return result;
}
