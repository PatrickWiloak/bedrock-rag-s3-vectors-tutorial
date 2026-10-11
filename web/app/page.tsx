'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Citation, Message, StreamEvent } from './lib/types';
import MisconfiguredBanner from './components/MisconfiguredBanner';
import QuickStarters from './components/QuickStarters';
import Citations from './components/Citations';

/**
 * The chat API is served from the same origin as this page - CloudFront routes
 * /api/* to a streaming Lambda Function URL. That means no endpoint to discover
 * at runtime, no CORS, and no cross-origin preflight.
 */
const CHAT_ENDPOINT = '/api/chat';

/** Lower-case hex SHA-256 of a string, via the browser's Web Crypto API. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const AssistantAvatar = () => (
  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200">
    <svg className="h-5 w-5 text-black" fill="currentColor" viewBox="0 0 20 20">
      <path d="M2 5a2 2 0 012-2h7a2 2 0 012 2v4a2 2 0 01-2 2H9l-3 3v-3H4a2 2 0 01-2-2V5z" />
      <path d="M15 7v2a4 4 0 01-4 4H9.828l-1.766 1.767c.28.149.599.233.938.233h2l3 3v-3h2a2 2 0 002-2V9a2 2 0 00-2-2h-1z" />
    </svg>
  </div>
);

const UserAvatar = () => (
  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black">
    <svg className="h-5 w-5 text-white" fill="currentColor" viewBox="0 0 20 20">
      <path
        fillRule="evenodd"
        d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
        clipRule="evenodd"
      />
    </svg>
  </div>
);

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  /**
   * RetrieveAndGenerate issues its own session IDs and keeps conversation
   * history server-side. A browser-invented ID is rejected, so this stays empty
   * until the first response supplies one.
   */
  const [sessionId, setSessionId] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [streamingCitations, setStreamingCitations] = useState<Citation[]>([]);
  const [apiUnreachable, setApiUnreachable] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  const sendMessage = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const question = input.trim();
      if (!question || isLoading) return;

      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: 'user',
          content: question,
          timestamp: new Date(),
        },
      ]);
      setInput('');
      setIsLoading(true);
      setStreamingText('');
      setStreamingCitations([]);
      setApiUnreachable(null);

      // Accumulated locally as well as in state: the final message is built
      // from these, and state updates are batched so they can't be read back
      // synchronously at the end of the stream.
      let text = '';
      const citations: Citation[] = [];
      let streamError: string | null = null;

      try {
        const body = JSON.stringify({
          message: question,
          // Omitted on the first request of a conversation.
          ...(sessionId ? { sessionId } : {}),
        });

        const response = await fetch(CHAT_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            /**
             * Required by CloudFront's Origin Access Control for a Lambda
             * Function URL: CloudFront signs the request with SigV4, and
             * Lambda does not accept unsigned payloads, so any request WITH
             * a body must carry the SHA-256 of that body. Leave this out and
             * the origin answers "The request signature we calculated does
             * not match" - CloudFront cannot compute it for you.
             */
            'x-amz-content-sha256': await sha256Hex(body),
          },
          body,
        });

        if (!response.ok || !response.body) {
          setApiUnreachable(`HTTP ${response.status} from ${CHAT_ENDPOINT}`);
          setIsLoading(false);
          return;
        }

        /**
         * Parse NDJSON as it arrives.
         *
         * Chunk boundaries fall wherever the network puts them, not on line
         * breaks, so the trailing partial line is held in `buffer` until the
         * rest of it turns up.
         */
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;

            let event: StreamEvent;
            try {
              event = JSON.parse(line) as StreamEvent;
            } catch {
              continue; // Ignore anything that isn't a complete JSON object.
            }

            switch (event.type) {
              case 'session':
                setSessionId(event.sessionId);
                break;
              case 'text':
                text += event.delta;
                setStreamingText(text);
                break;
              case 'citation':
                citations.push(event.citation);
                setStreamingCitations([...citations]);
                break;
              case 'error':
                streamError = event.message;
                break;
              case 'done':
                break;
            }
          }
        }
      } catch (error) {
        streamError =
          error instanceof Error ? error.message : 'Could not reach the chat API.';
      }

      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: streamError
            ? `Sorry - something went wrong.\n\n\`${streamError}\``
            : text,
          citations: citations.length > 0 ? citations : undefined,
          timestamp: new Date(),
        },
      ]);

      setStreamingText('');
      setStreamingCitations([]);
      setIsLoading(false);
    },
    [input, isLoading, sessionId]
  );

  return (
    <div className="flex h-screen flex-col bg-white">
      {/* Header */}
      <header className="border-b border-gray-300 bg-black px-6 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">RAG Chat</h1>
            <p className="mt-1 text-sm text-gray-400">
              Amazon Bedrock Knowledge Bases &amp; S3 Vectors
            </p>
          </div>
          <span className="inline-flex items-center rounded-full bg-white px-3 py-1 text-xs font-medium text-black">
            <span
              className={`mr-2 h-2 w-2 rounded-full bg-black ${
                isLoading ? 'animate-pulse' : ''
              }`}
            />
            {isLoading ? 'Streaming' : 'Ready'}
          </span>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto bg-white px-4 py-6">
        <div className="mx-auto max-w-4xl space-y-6">
          {apiUnreachable && <MisconfiguredBanner detail={apiUnreachable} />}

          {messages.length === 0 && !apiUnreachable && (
            <div className="py-12 text-center">
              <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
                <svg
                  className="h-8 w-8 text-black"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                  />
                </svg>
              </div>
              <h2 className="mb-2 text-xl font-semibold text-black">
                Ask about the knowledge base
              </h2>
              <p className="mb-6 text-gray-600">
                Answers are generated from your documents, with citations.
              </p>
              <QuickStarters onSelect={setInput} />
            </div>
          )}

          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${
                message.role === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              <div
                className={`flex max-w-3xl gap-3 ${
                  message.role === 'user' ? 'flex-row-reverse' : 'flex-row'
                }`}
              >
                {message.role === 'user' ? <UserAvatar /> : <AssistantAvatar />}

                <div
                  className={`flex flex-col gap-2 ${
                    message.role === 'user' ? 'items-end' : 'items-start'
                  }`}
                >
                  <div
                    className={`rounded-lg px-4 py-3 ${
                      message.role === 'user'
                        ? 'bg-black text-white'
                        : 'border border-gray-300 bg-white text-black'
                    }`}
                  >
                    {message.role === 'user' ? (
                      <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                    ) : (
                      <div className="markdown prose prose-sm max-w-none prose-headings:text-black prose-p:text-gray-800 prose-strong:text-black prose-code:text-black">
                        <ReactMarkdown>{message.content}</ReactMarkdown>
                      </div>
                    )}
                  </div>

                  {message.citations && <Citations citations={message.citations} />}

                  <span className="text-xs text-gray-500">
                    {message.timestamp.toLocaleTimeString()}
                  </span>
                </div>
              </div>
            </div>
          ))}

          {/* In-flight response - real tokens, arriving as the model writes them */}
          {(isLoading || streamingText) && (
            <div className="flex justify-start">
              <div className="flex max-w-3xl gap-3">
                <AssistantAvatar />
                <div className="flex flex-col gap-2">
                  <div className="rounded-lg border border-gray-300 bg-white px-4 py-3">
                    {streamingText ? (
                      <div className="markdown prose prose-sm max-w-none prose-headings:text-black prose-p:text-gray-800 prose-strong:text-black prose-code:text-black">
                        <ReactMarkdown>{streamingText}</ReactMarkdown>
                      </div>
                    ) : (
                      <span className="text-sm text-gray-500">Searching documents…</span>
                    )}
                    <div className="mt-2 flex gap-1">
                      <div className="typing-dot h-2 w-2 rounded-full bg-gray-400" />
                      <div className="typing-dot h-2 w-2 rounded-full bg-gray-400" />
                      <div className="typing-dot h-2 w-2 rounded-full bg-gray-400" />
                    </div>
                  </div>
                  {streamingCitations.length > 0 && (
                    <Citations citations={streamingCitations} />
                  )}
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-gray-300 bg-white px-4 py-4">
        <div className="mx-auto max-w-4xl">
          <form onSubmit={sendMessage} className="flex gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask me anything…"
              disabled={isLoading}
              className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-3 text-black placeholder-gray-500 focus:border-transparent focus:outline-hidden focus:ring-2 focus:ring-black disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="flex items-center gap-2 rounded-lg bg-black px-6 py-3 font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-400"
            >
              {isLoading ? (
                <>
                  <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  <span>Streaming…</span>
                </>
              ) : (
                <>
                  <svg
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                    />
                  </svg>
                  <span>Send</span>
                </>
              )}
            </button>
          </form>
          <p className="mt-2 text-center text-xs text-gray-500">
            Session: {sessionId ? `${sessionId.slice(0, 8)}…` : 'not started'}
          </p>
        </div>
      </div>
    </div>
  );
}
