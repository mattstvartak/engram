import { extractFromConversation } from './extractor.js';
export async function importConversation(config, storage, format, content) {
    const result = {
        format,
        conversationsFound: 0,
        memoriesExtracted: 0,
        errors: [],
    };
    let conversations;
    try {
        switch (format) {
            case 'claude-jsonl':
                conversations = parseClaudeJsonl(content);
                break;
            case 'chatgpt-json':
                conversations = parseChatGptJson(content);
                break;
            case 'plain-text':
                conversations = parsePlainText(content);
                break;
            default:
                result.errors.push(`Unknown format: ${format}`);
                return result;
        }
    }
    catch (err) {
        result.errors.push(`Parse error: ${err.message}`);
        return result;
    }
    result.conversationsFound = conversations.length;
    for (const convo of conversations) {
        if (convo.messages.length < 2)
            continue;
        try {
            const chunks = await extractFromConversation(config, storage, convo.messages, `import:${convo.id}`, { forceExtract: true });
            result.memoriesExtracted += chunks.length;
        }
        catch (err) {
            result.errors.push(`Extraction error in ${convo.id}: ${err.message}`);
        }
    }
    return result;
}
// ── Claude Code JSONL ───────────────────────────────────────────────
// Each line is a JSON object with at least {type, role?, content?}
// Conversations are delimited by type: "session_start" or similar.
function parseClaudeJsonl(content) {
    const lines = content.split('\n').filter(l => l.trim());
    const conversations = [];
    let current = [];
    let convoIndex = 0;
    for (const line of lines) {
        try {
            const obj = JSON.parse(line);
            // Session boundary markers
            if (obj.type === 'session_start' || obj.type === 'system') {
                if (current.length >= 2) {
                    conversations.push({ id: `claude-${convoIndex}`, messages: current });
                    convoIndex++;
                }
                current = [];
                continue;
            }
            // Extract message content
            const role = obj.role ?? obj.type;
            let text = '';
            if (typeof obj.content === 'string') {
                text = obj.content;
            }
            else if (Array.isArray(obj.content)) {
                // Content blocks: [{type: "text", text: "..."}]
                text = obj.content
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text)
                    .join('\n');
            }
            else if (obj.message) {
                text = typeof obj.message === 'string' ? obj.message : JSON.stringify(obj.message);
            }
            if ((role === 'user' || role === 'assistant' || role === 'human') && text.length > 0) {
                current.push({ role: role === 'human' ? 'user' : role, content: text });
            }
        }
        catch {
            // Skip malformed lines
        }
    }
    // Don't forget the last conversation
    if (current.length >= 2) {
        conversations.push({ id: `claude-${convoIndex}`, messages: current });
    }
    return conversations;
}
// ── ChatGPT JSON ────────────────────────────────────────────────────
// Standard ChatGPT export: array of conversation objects with mapping.
function parseChatGptJson(content) {
    const data = JSON.parse(content);
    const conversations = [];
    // ChatGPT exports can be an array of conversations or a single one
    const convos = Array.isArray(data) ? data : [data];
    for (const convo of convos) {
        const id = convo.id ?? convo.title ?? `chatgpt-${conversations.length}`;
        const messages = [];
        if (convo.mapping) {
            // Tree structure -- walk the mapping
            const nodes = Object.values(convo.mapping);
            const sorted = nodes
                .filter((n) => n.message?.content?.parts?.length > 0)
                .sort((a, b) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0));
            for (const node of sorted) {
                const msg = node.message;
                const role = msg.author?.role;
                const text = msg.content?.parts?.filter((p) => typeof p === 'string').join('\n') ?? '';
                if ((role === 'user' || role === 'assistant') && text.length > 0) {
                    messages.push({ role, content: text });
                }
            }
        }
        else if (Array.isArray(convo.messages)) {
            // Simple message array format
            for (const msg of convo.messages) {
                if ((msg.role === 'user' || msg.role === 'assistant') && msg.content) {
                    messages.push({
                        role: msg.role,
                        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                    });
                }
            }
        }
        if (messages.length >= 2) {
            conversations.push({ id, messages });
        }
    }
    return conversations;
}
// ── Plain Text ──────────────────────────────────────────────────────
// Simple format: lines starting with "user:" or "assistant:" (case insensitive)
function parsePlainText(content) {
    const messages = [];
    let currentRole = '';
    let currentContent = '';
    for (const line of content.split('\n')) {
        const roleMatch = line.match(/^(user|assistant|human|ai):\s*(.*)/i);
        if (roleMatch) {
            // Save previous message
            if (currentRole && currentContent.trim()) {
                messages.push({ role: currentRole, content: currentContent.trim() });
            }
            currentRole = roleMatch[1].toLowerCase();
            if (currentRole === 'human')
                currentRole = 'user';
            if (currentRole === 'ai')
                currentRole = 'assistant';
            currentContent = roleMatch[2];
        }
        else if (currentRole) {
            currentContent += '\n' + line;
        }
    }
    // Last message
    if (currentRole && currentContent.trim()) {
        messages.push({ role: currentRole, content: currentContent.trim() });
    }
    if (messages.length < 2)
        return [];
    return [{ id: `plaintext-${Date.now()}`, messages }];
}
//# sourceMappingURL=importer.js.map