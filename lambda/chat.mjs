/**
 * Streaming chat Lambda - fronted by a Lambda Function URL with
 * invoke_mode = RESPONSE_STREAM, reached through CloudFront at /api/chat.
 *
 * Request:  POST { message: string, sessionId?: string }
 * Response: NDJSON stream - one JSON object per line:
 *           { "type": "text",     "delta": "...chunk..." }
 *           { "type": "citation", "citation": { index, title, source, excerpt, uri } }
 *           { "type": "session",  "sessionId": "..." }
 *           { "type": "done" }
 *           { "type": "error",    "message": "..." }
 *
 * This file is plain ESM (.mjs) on purpose. An earlier version of this tutorial
 * shipped the handler as TypeScript that nothing ever compiled - the bundler
 * copied the .ts file straight into the asset and the Node runtime could not
 * load it. Keeping the handler as runnable JavaScript removes that whole class
 * of problem.
 */

import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateStreamCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID;
const MODEL_ARN = process.env.MODEL_ARN;
const NUMBER_OF_RESULTS = Number(process.env.NUMBER_OF_RESULTS ?? '5');

/**
 * Prompt templates.
 *
 * GENERATION writes the answer from the retrieved chunks; it must contain
 * `$search_results$`. ORCHESTRATION turns the conversation into a search
 * query; it must contain `$conversation_history$` and
 * `$output_format_instructions$`.
 *
 * Both are optional for older models, where unset means Bedrock's built-in
 * templates. **The Claude 5.5 family (Haiku, Sonnet, Opus 5.5) requires both
 * templates, and each must also contain `$query$`.** Leave either out and
 * RetrieveAndGenerate fails with a ValidationException naming the missing
 * piece. Both ship in config/ so the CDK and Terraform paths send the same text.
 */
const PROMPT_TEMPLATE = process.env.PROMPT_TEMPLATE;
const ORCHESTRATION_PROMPT_TEMPLATE = process.env.ORCHESTRATION_PROMPT_TEMPLATE;

const bedrock = new BedrockAgentRuntimeClient({ region: REGION });

/**
 * Turn a source filename into something a person would want to read.
 *
 * `Human-Resources/remote-work-policy.md` -> "Remote Work Policy"
 *
 * Citations are only useful if the reader recognises the document, and a raw
 * s3:// URI is not recognisable. Add entries to TITLES for documents whose
 * filename does not derive a good title on its own.
 */
const TITLES = {
  'quarterly-report-q4-2024.md': 'Q4 2024 Quarterly Report',
  'budget-2025.md': '2025 Annual Budget',
  'expense-policy.md': 'Corporate Expense Policy',
  'accounts-receivable-aging-report-2025-01.md': 'Accounts Receivable Aging Report',
  'benefits-guide-2025.md': 'Benefits Guide 2025',
  'employee-handbook.md': 'Employee Handbook',
  'remote-work-policy.md': 'Remote Work Policy',
  'performance-review-guidelines.md': 'Performance Review Guidelines',
  'Dress_Code_Policy.docx': 'Dress Code Policy',
  'Vacation_Policy.docx': 'Vacation Policy',
  'executive-leadership-meeting-2025-01-15.md': 'Executive Leadership Meeting (Jan 2025)',
  'product-roadmap-planning-2025-q1.md': 'Product Roadmap Planning (Q1 2025)',
  'engineering-sprint-retro-2025-01-17.md': 'Engineering Sprint Retrospective',
  'Meeting_Notes.docx': 'Meeting Notes',
  'CS_Team_Weekly_Sync_Feb_5.docx': 'CS Team Weekly Sync (Feb 5)',
  'Marketing_Campaign_Planning_Jan_29.docx': 'Marketing Campaign Planning (Jan 29)',
};

function basenameFromS3Uri(uri) {
  if (!uri || !uri.startsWith('s3://')) return null;
  const path = uri.slice('s3://'.length);
  const slash = path.indexOf('/');
  if (slash < 0) return null;
  return path.slice(slash + 1).split('/').pop() ?? null;
}

/** The folder a document lives in - "Human-Resources", "Financial-Data", ... */
function categoryFromS3Uri(uri) {
  if (!uri || !uri.startsWith('s3://')) return null;
  const parts = uri.slice('s3://'.length).split('/');
  return parts.length > 2 ? parts[1] : null;
}

function titleFor(basename) {
  if (!basename) return 'Source document';
  return (
    TITLES[basename] ??
    basename
      .replace(/\.(md|txt|pdf|docx|html|csv)$/i, '')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/** Trim a retrieved chunk down to something previewable. */
function excerptOf(text, max = 240) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * `awslambda.streamifyResponse` is a global the Node.js runtime injects when
 * the Function URL is configured with invoke_mode = RESPONSE_STREAM.
 */
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  // HTTP metadata must be attached before anything is written to the body.
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
    },
  });

  const write = (obj) => stream.write(`${JSON.stringify(obj)}\n`);

  const fail = (message) => {
    console.error('[RAG]', message);
    write({ type: 'error', message });
    stream.end();
  };

  try {
    if (!KNOWLEDGE_BASE_ID || !MODEL_ARN) {
      return fail('Server misconfigured: KNOWLEDGE_BASE_ID or MODEL_ARN is not set.');
    }

    let body;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return fail('Request body was not valid JSON.');
    }

    const message = body.message;
    const sessionId = body.sessionId;

    if (!message || typeof message !== 'string') {
      return fail('Missing "message" in request body.');
    }

    console.log('[RAG] request', {
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      hasSession: Boolean(sessionId),
      messageLength: message.length,
    });

    /**
     * Session handling
     *
     * RetrieveAndGenerate issues its own session IDs and keeps conversation
     * history server-side. A client-invented ID is rejected with a validation
     * error, so the first request of a conversation must omit it entirely.
     */
    const response = await bedrock.send(
      new RetrieveAndGenerateStreamCommand({
        input: { text: message },
        ...(sessionId ? { sessionId } : {}),
        retrieveAndGenerateConfiguration: {
          type: 'KNOWLEDGE_BASE',
          knowledgeBaseConfiguration: {
            knowledgeBaseId: KNOWLEDGE_BASE_ID,
            modelArn: MODEL_ARN,
            retrievalConfiguration: {
              vectorSearchConfiguration: { numberOfResults: NUMBER_OF_RESULTS },
            },
            ...(PROMPT_TEMPLATE
              ? {
                  generationConfiguration: {
                    promptTemplate: { textPromptTemplate: PROMPT_TEMPLATE },
                  },
                }
              : {}),
            ...(ORCHESTRATION_PROMPT_TEMPLATE
              ? {
                  orchestrationConfiguration: {
                    promptTemplate: { textPromptTemplate: ORCHESTRATION_PROMPT_TEMPLATE },
                  },
                }
              : {}),
          },
        },
      })
    );

    // The session ID is on the response itself, so the browser can have it
    // before a single token of the answer arrives.
    if (response.sessionId) {
      write({ type: 'session', sessionId: response.sessionId });
    }

    const seen = new Set();
    let citationIndex = 0;
    let textLength = 0;

    for await (const chunk of response.stream ?? []) {
      // Text deltas as the model generates them.
      if (chunk.output?.text) {
        textLength += chunk.output.text.length;
        write({ type: 'text', delta: chunk.output.text });
        continue;
      }

      // Citations arrive alongside the text they support. The same document
      // commonly backs several spans, so deduplicate by URI.
      if (chunk.citation?.citation) {
        for (const ref of chunk.citation.citation.retrievedReferences ?? []) {
          const uri = ref.location?.s3Location?.uri;
          if (!uri || seen.has(uri)) continue;
          seen.add(uri);

          const basename = basenameFromS3Uri(uri);
          write({
            type: 'citation',
            citation: {
              index: ++citationIndex,
              title: titleFor(basename),
              source: basename,
              category: categoryFromS3Uri(uri),
              excerpt: excerptOf(ref.content?.text),
              uri,
            },
          });
        }
        continue;
      }

      // Modelled exceptions arrive as members of the stream union rather than
      // as thrown errors, so they have to be checked explicitly.
      const modelledError =
        chunk.internalServerException ??
        chunk.validationException ??
        chunk.resourceNotFoundException ??
        chunk.serviceQuotaExceededException ??
        chunk.throttlingException ??
        chunk.accessDeniedException ??
        chunk.conflictException ??
        chunk.dependencyFailedException ??
        chunk.badGatewayException;

      if (modelledError) {
        return fail(modelledError.message ?? 'The knowledge base returned an error.');
      }
    }

    console.log('[RAG] complete', { textLength, citations: citationIndex });
    write({ type: 'done' });
    stream.end();
  } catch (error) {
    // Thrown errors (auth, throttling before the stream opens, network) land here.
    console.error('[RAG] error', {
      name: error?.name,
      message: error?.message,
      statusCode: error?.$metadata?.httpStatusCode,
      requestId: error?.$metadata?.requestId,
    });

    const hint =
      error?.name === 'AccessDeniedException'
        ? ' (check Bedrock model access, and that InvokeModel is granted on both the inference profile and the foundation model)'
        : '';

    write({
      type: 'error',
      message: `${error?.message ?? 'Unknown error'}${hint}`,
    });
    stream.end();
  }
});
