/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type MCPTool = {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
    };
};

export const MCP_TOOLS: MCPTool[] = [
    {
        name: "module",
        description: "Unified webpack module operations: find, extract, exports, context, diff, relationships, size, ids, stats, explain, findStrings.",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["find", "extract", "exports", "context", "diff", "deps", "relationships", "size", "ids", "stats", "explain", "findStrings"],
                    description: "find=search modules, extract=get source, exports=list exports, context=summary/snippets, diff=patched vs original, deps/relationships=module graph, size=module size, ids=list module ids, stats=webpack summary"
                },
                id: { type: "number", description: "Module id (alias for moduleId)" },
                moduleId: { type: "number", description: "Module id" },
                props: { type: "array", items: { type: "string" }, description: "Find by export props" },
                code: { type: "array", items: { type: "string" }, description: "Find by code snippets" },
                displayName: { type: "string", description: "Find by displayName (components)" },
                className: { type: "string", description: "Find by CSS module class fragment" },
                exportName: { type: "string", description: "Find by export name (prop match)" },
                exportValue: { type: "string", description: "Find by export value (string search)" },
                pattern: { type: "string", description: "Search pattern (string or /regex/flags)" },
                kind: { type: "string", enum: ["literal", "regex", "props", "code", "store", "component", "moduleId"] },
                all: { type: "boolean", default: false },
                limit: { type: "number", default: 20 },
                stringMinLength: { type: "number", default: 4 },
                stringMaxLength: { type: "number", default: 80 },
                offset: { type: "number", default: 0 },
                maxLength: { type: "number", default: 50000 },
                usePatched: { type: "boolean", default: true },
                isRegex: { type: "boolean", default: false },
                radius: { type: "number", default: 80 },
                contextLines: { type: "number", default: 2 },
                searchLimit: { type: "number", default: 5 },
                matchLimit: { type: "number", default: 3 },
                summary: { type: "boolean", default: false },
                maxItems: { type: "number" },
                maxChars: { type: "number" }
            }
        }
    },
    {
        name: "store",
        description: "Unified Flux store operations: find, list, state, call, diff, subscriptions, methods.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["find", "list", "state", "call", "diff", "subscriptions", "methods"] },
                name: { type: "string", description: "Store name" },
                storeName: { type: "string", description: "Store name (alias)" },
                method: { type: "string", description: "Method or getter name" },
                args: { type: "array", items: {}, description: "Arguments for method call" },
                filter: { type: "string", description: "Filter store names by substring" },
                limit: { type: "number", default: 50 },
                offset: { type: "number", default: 0 },
                summary: { type: "boolean", default: false },
                maxItems: { type: "number" },
                maxChars: { type: "number" }
            }
        }
    },
    {
        name: "component",
        description: "Component operations: find by code, inspect from DOM, component tree.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["find", "inspect", "tree"] },
                code: { type: "array", items: { type: "string" }, description: "Code snippets for find" },
                selector: { type: "string", description: "CSS selector for inspect/tree" },
                isRegex: { type: "boolean", default: false },
                limit: { type: "number", default: 20 },
                maxDepth: { type: "number", default: 20 },
                maxBreadth: { type: "number", default: 10 },
                summary: { type: "boolean", default: false },
                maxItems: { type: "number" },
                maxChars: { type: "number" }
            }
        }
    },
    {
        name: "intl",
        description: "Unified intl operations: hash, reverse, search, scan, targets.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["hash", "reverse", "search", "scan", "targets"] },
                key: { type: "string", description: "Readable intl key (e.g. USER_SETTINGS)" },
                hash: { type: "string", description: "6-char intl hash" },
                query: { type: "string", description: "Search text for intl keys" },
                moduleId: { type: "number", description: "Module id for scan" },
                limit: { type: "number", default: 20 },
                summary: { type: "boolean", default: false },
                maxItems: { type: "number" },
                maxChars: { type: "number" }
            }
        }
    },
    {
        name: "flux",
        description: "Unified Flux operations: events, types, dispatch, listeners.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["events", "types", "dispatch", "listeners"] },
                event: { type: "string", description: "Event name for listeners" },
                type: { type: "string", description: "Action type for dispatch" },
                payload: { type: "object", description: "Payload for dispatch" },
                filter: { type: "string", description: "Filter for events/types" },
                isRegex: { type: "boolean", default: false },
                summary: { type: "boolean", default: false },
                maxItems: { type: "number" },
                maxChars: { type: "number" }
            }
        }
    },
    {
        name: "patch",
        description: "Unified patch operations: test, lint, overlap, unique, analyze, plugin, suggest.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["test", "lint", "overlap", "unique", "analyze", "plugin", "suggest"] },
                find: { type: "string", description: "Find string for test/unique" },
                match: { type: "string", description: "Match regex for test (optional if replacements provided)" },
                replace: { type: "string", description: "Replacement string for test preview" },
                replacements: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            match: { type: "string" },
                            replace: { type: "string" }
                        },
                        required: ["match", "replace"]
                    }
                },
                moduleId: { type: "number", description: "Optional module id to generate anchor suggestions for lint" },
                brokenFind: { type: "string", description: "Broken find string for suggest" },
                pluginName: { type: "string", description: "Plugin name for analyze/plugin" },
                limit: { type: "number", default: 20 },
                summary: { type: "boolean", default: false },
                maxItems: { type: "number" },
                maxChars: { type: "number" }
            }
        }
    },
    {
        name: "dom",
        description: "Unified DOM operations: inspect, query, styles, modify, tree, classes, text, path, snapshot.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["inspect", "query", "styles", "modify", "tree", "classes", "text", "path", "snapshot"] },
                selector: { type: "string", description: "CSS selector" },
                limit: { type: "number", default: 20 },
                includeText: { type: "boolean", default: true },
                includeAttrs: { type: "boolean", default: false },
                maxTextLength: { type: "number", default: 200 },
                properties: { type: "array", items: { type: "string" } },
                styles: { type: "object" },
                addClass: { type: "string" },
                removeClass: { type: "string" },
                setAttribute: { type: "object" },
                index: { type: "number", default: 0 },
                depth: { type: "number", default: 2 },
                breadth: { type: "number", default: 10 },
                maxDepth: { type: "number", default: 50 },
                query: { type: "string", description: "Text search for action=text" },
                isRegex: { type: "boolean", default: false },
                maxResults: { type: "number", default: 20 },
                summary: { type: "boolean", default: false },
                maxItems: { type: "number" },
                maxChars: { type: "number" }
            }
        }
    },
    {
        name: "discord",
        description: "Discord context and APIs: context, ready, waitForIpc, REST, snowflake, endpoints, common, stores, memory, performance, enum.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["context", "ready", "waitForIpc", "api", "snowflake", "endpoints", "common", "stores", "memory", "performance", "enum"] },
                method: { type: "string", enum: ["get", "post", "put", "patch", "del"] },
                url: { type: "string" },
                body: { type: ["object", "array", "string", "number", "boolean", "null"] },
                query: { type: "object" },
                headers: { type: "object" },
                snowflake: { type: "string" },
                filter: { type: "string" },
                queryEnum: { type: "string", description: "Enum member query" },
                includeMembers: { type: "boolean", default: false },
                limit: { type: "number", default: 20 },
                timeoutMs: { type: "number", description: "Ready wait timeout in ms (action=ready/waitForIpc)" },
                intervalMs: { type: "number", description: "Ready poll interval in ms (action=ready/waitForIpc)" },
                warmupMs: { type: "number", description: "Warmup delay before polling (action=waitForIpc)" },
                summary: { type: "boolean", default: false },
                maxItems: { type: "number" },
                maxChars: { type: "number" }
            }
        }
    },
    {
        name: "analytics",
        description: "Analytics event capture via trackWithMetadata.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["start", "get", "stop", "events", "status", "clear"] },
                filter: { type: "string", description: "Filter by event name" },
                isRegex: { type: "boolean", default: false },
                limit: { type: "number", default: 50 },
                offset: { type: "number", default: 0 },
                maxEntries: { type: "number", default: 500 },
                redact: { type: "boolean", default: true },
                fields: { type: "array", items: { type: "string" } },
                maxPayloadChars: { type: "number" },
                stopOnMatch: { type: "boolean", default: false },
                stopAfter: { type: "number" },
                summary: { type: "boolean", default: false },
                maxItems: { type: "number" },
                maxChars: { type: "number" }
            }
        }
    },
    {
        name: "plugin",
        description: "Plugin operations: list, info, patches, enable/disable, toggle, settings, setSetting.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["list", "info", "patches", "enable", "disable", "toggle", "settings", "setSetting"] },
                name: { type: "string", description: "Filter plugin list by name" },
                pluginName: { type: "string", description: "Plugin name for patches/toggle" },
                enabled: { type: "boolean", description: "Enable/disable for toggle" },
                showPatches: { type: "boolean", default: false },
                pluginId: { type: "string", description: "Plugin id for settings" },
                values: { type: "object", description: "Settings values for settings action" },
                summary: { type: "boolean", default: false },
                maxItems: { type: "number" },
                maxChars: { type: "number" }
            }
        }
    },
    {
        name: "search",
        description: "Unified search: literal/regex/pattern/props/code/store/component/moduleId, extract, or context.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["literal", "regex", "pattern", "props", "code", "store", "component", "moduleId", "extract", "context"] },
                pattern: { type: "string", description: "Search pattern or comma-separated props/code" },
                isRegex: { type: "boolean", default: false },
                preset: { type: "string", enum: ["full", "compact", "minimal"], default: "full" },
                limit: { type: "number", default: 20 },
                offset: { type: "number", default: 0 },
                kind: { type: "string", enum: ["literal", "regex", "pattern", "props", "code"] },
                searchLimit: { type: "number", default: 20 },
                usePatched: { type: "boolean", default: true },
                maxLength: { type: "number", default: 50000 },
                radius: { type: "number", default: 80 },
                contextLines: { type: "number", default: 2 },
                matchLimit: { type: "number", default: 3 },
                summary: { type: "boolean", default: false },
                maxItems: { type: "number" },
                maxChars: { type: "number" }
            }
        }
    },
    {
        name: "testPatch",
        description: "Test if a patch works against current Discord. Validates find uniqueness and match patterns.",
        inputSchema: {
            type: "object",
            properties: {
                find: { type: "string" },
                preview: { type: "boolean", default: false },
                previewMode: { type: "string", enum: ["compact", "full", "context-only"], default: "compact" },
                contextLines: { type: "number", default: 2 },
                radius: { type: "number", default: 120 },
                summary: { type: "boolean", default: false },
                maxItems: { type: "number" },
                maxChars: { type: "number" },
                replacements: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            match: { type: "string" },
                            replace: { type: "string" }
                        },
                        required: ["match", "replace"]
                    }
                }
            },
            required: ["find", "replacements"]
        }
    },
    {
        name: "trace",
        description: "Trace Flux actions and store changes.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["events", "handlers", "storeEvents", "start", "get", "stop", "store", "status", "clear"] },
                event: { type: "string" },
                filter: { type: "string" },
                isRegex: { type: "boolean", default: false },
                storeName: { type: "string" },
                limit: { type: "number", default: 50 },
                offset: { type: "number", default: 0 },
                maxEntries: { type: "number", default: 500 },
                redact: { type: "boolean", default: false },
                fields: { type: "array", items: { type: "string" } },
                sampleRate: { type: "number", default: 1 },
                matchPayload: { type: "string" },
                maxPayloadChars: { type: "number" },
                maxPayloadDepth: { type: "number" },
                summary: { type: "boolean", default: false },
                maxItems: { type: "number" },
                maxChars: { type: "number" }
            }
        }
    },
    {
        name: "intercept",
        description: "Intercept function calls and capture arguments/return values.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["set", "get", "stop", "status"] },
                moduleId: { type: "number" },
                exportName: { type: "string" },
                path: { type: "string", description: "Dot path to function (e.g. default.render)" },
                id: { type: "string", description: "Intercept id (optional)" },
                limit: { type: "number", default: 50 },
                offset: { type: "number", default: 0 },
                maxEntries: { type: "number", default: 200 },
                sampleRate: { type: "number", default: 1 },
                matchArgs: { type: "string" },
                matchResult: { type: "string" },
                isRegex: { type: "boolean", default: false },
                summary: { type: "boolean", default: false },
                maxItems: { type: "number" },
                maxChars: { type: "number" }
            }
        }
    },
    {
        name: "evaluateCode",
        description: "Evaluate JS in the Discord client context.",
        inputSchema: {
            type: "object",
            properties: {
                code: { type: "string" },
                async: { type: "boolean", default: false },
                expression: { type: "boolean", default: false },
                timeoutMs: { type: "number", default: 8000 },
                maxOutputChars: { type: "number", default: 20000 }
            },
            required: ["code"]
        }
    },
    {
        name: "reloadDiscord",
        description: "Reload the Discord client. Useful after making changes that require a reload.",
        inputSchema: {
            type: "object",
            properties: {
                delayMs: { type: "number", description: "Delay before reloading (ms)" }
            }
        }
    },
    {
        name: "batch_tools",
        description: "Run multiple tools in a single request.",
        inputSchema: {
            type: "object",
            properties: {
                parallelism: { type: "number", description: "Max concurrent tool calls (default 4, max 10)" },
                timeoutMs: { type: "number", description: "Default per-tool timeout in ms (default 60000, max 120000)" },
                stream: { type: "boolean", description: "Return immediately and stream results via read_resource", default: false },
                requests: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            tool: { type: "string" },
                            arguments: { type: "object" },
                            timeoutMs: { type: "number", description: "Override timeout for this request in ms" }
                        },
                        required: ["tool"]
                    }
                }
            },
            required: ["requests"]
        }
    },
    {
        name: "read_resource",
        description: "Read a stored resource by id (supports offset/length).",
        inputSchema: {
            type: "object",
            properties: {
                resourceId: { type: "string" },
                offset: { type: "number" },
                length: { type: "number" }
            },
            required: ["resourceId"]
        }
    }
];

export function getMcpTools(availableNames?: Iterable<string>): MCPTool[] {
    if (!availableNames) return MCP_TOOLS;
    const allowed = new Set(availableNames);
    return MCP_TOOLS.filter(tool => allowed.has(tool.name));
}
