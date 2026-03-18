// ============ Chatwoot Webhook Event Types ============

export interface ChatwootSender {
    id?: number;
    name?: string;
    email?: string;
    type?: string; // 'contact' | 'user' | 'agent_bot'
}

export interface ChatwootConversation {
    id: number;
    account_id?: number;
    inbox_id?: number;
    status?: string;
}

export interface ChatwootAccount {
    id: number;
}

export interface ChatwootAttachment {
    id?: number;
    file_type?: string;
    content_type?: string;
    file_name?: string;
    file_size?: number;
    size?: number;
    url?: string;
    file_url?: string;
    download_url?: string;
    data_url?: string;
    thumb_url?: string;
}

export interface ChatwootMessageEvent {
    event: 'message_created';
    id?: number;
    content?: string;
    message_type?: 'incoming' | 'outgoing' | 'activity' | 'template';
    private?: boolean;
    content_attributes?: Record<string, unknown>;
    sender?: ChatwootSender;
    conversation?: ChatwootConversation;
    account?: ChatwootAccount;
    attachments?: ChatwootAttachment[];
    message?: { attachments?: ChatwootAttachment[] };
}

export interface ChatwootConversationStatusEvent {
    event: 'conversation_status_changed';
    id?: number;
    status?: string;
    conversation?: ChatwootConversation;
}

export type ChatwootWebhookEvent = ChatwootMessageEvent | ChatwootConversationStatusEvent;

// ============ Chatwoot API Response Types ============

export interface CannedResponse {
    id: number;
    short_code: string;
    content: string;
}
