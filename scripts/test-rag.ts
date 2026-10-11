/**
 * Query the deployed knowledge base from the terminal.
 *
 * Two modes:
 *   npm run test-rag              - run a scripted set of demo questions
 *   npm run test-rag interactive  - ask your own questions
 */

import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { REGION, resolveOutputs } from './outputs';

// The same templates the deployed Lambda uses. The Claude 5.5 models refuse
// RetrieveAndGenerate without both of them.
const CONFIG_DIR = path.join(__dirname, '..', 'config');
const PROMPT_TEMPLATE = fs.readFileSync(path.join(CONFIG_DIR, 'prompt-template.txt'), 'utf8').trimEnd();
const ORCHESTRATION_PROMPT_TEMPLATE = fs
  .readFileSync(path.join(CONFIG_DIR, 'orchestration-prompt-template.txt'), 'utf8')
  .trimEnd();

async function getStackOutputs(): Promise<{ knowledgeBaseId: string; modelArn: string; region: string }> {
  const { knowledgeBaseId, modelId, region, account } = await resolveOutputs();
  // Terraform exports do not carry the account ID; derive it from STS only then.
  const accountId = account || (await currentAccountId());
  return {
    knowledgeBaseId,
    region,
    modelArn: `arn:aws:bedrock:${region}:${accountId}:inference-profile/${modelId}`,
  };
}

async function currentAccountId(): Promise<string> {
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const identity = await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}));
  if (!identity.Account) throw new Error('Could not determine the AWS account ID');
  return identity.Account;
}

/**
 * Ask the knowledge base one question.
 *
 * `sessionId` threads multi-turn conversations together. Bedrock issues the ID,
 * so the first call must omit it and later calls pass back whatever came out of
 * the previous response.
 */
async function askKnowledgeBase(
  client: BedrockAgentRuntimeClient,
  knowledgeBaseId: string,
  modelArn: string,
  question: string,
  sessionId?: string
): Promise<{ answer: string; sources: string[]; sessionId?: string }> {
  const response = await client.send(
    new RetrieveAndGenerateCommand({
      input: { text: question },
      ...(sessionId ? { sessionId } : {}),
      retrieveAndGenerateConfiguration: {
        type: 'KNOWLEDGE_BASE',
        knowledgeBaseConfiguration: {
          knowledgeBaseId,
          modelArn,
          retrievalConfiguration: {
            vectorSearchConfiguration: { numberOfResults: 5 },
          },
          generationConfiguration: {
            promptTemplate: { textPromptTemplate: PROMPT_TEMPLATE },
          },
          orchestrationConfiguration: {
            promptTemplate: { textPromptTemplate: ORCHESTRATION_PROMPT_TEMPLATE },
          },
        },
      },
    })
  );

  const sources = new Set<string>();
  for (const citation of response.citations ?? []) {
    for (const ref of citation.retrievedReferences ?? []) {
      const uri = ref.location?.s3Location?.uri;
      if (uri) sources.add(uri);
    }
  }

  return {
    answer: response.output?.text ?? '',
    sources: [...sources],
    sessionId: response.sessionId,
  };
}

function printSources(sources: string[]) {
  if (sources.length === 0) return;
  console.log('\n📚 Sources:');
  sources.forEach((source, idx) => {
    console.log(`  ${idx + 1}. ${source}`);
  });
}

async function runDemo(
  client: BedrockAgentRuntimeClient,
  knowledgeBaseId: string,
  modelArn: string
) {
  const questions = [
    { q: 'What is the target net income for 2025?', category: '💰 Financial Data' },
    { q: 'How many PTO days do employees get per year?', category: '👥 Human Resources' },
    { q: 'What are the top 5 strategic priorities for 2025?', category: '📝 Meeting Notes' },
    {
      q: 'What was our Q4 2024 revenue and how did it compare to the target?',
      category: '💰 Financial Data',
    },
  ];

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  🎬 Demo Mode - Automated RAG Testing                         ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  console.log('Testing Knowledge Base retrieval across all document categories:\n');

  let sessionId: string | undefined;

  for (let i = 0; i < questions.length; i++) {
    const { q, category } = questions[i];

    console.log(`\n${'─'.repeat(70)}`);
    console.log(`${category} | Question ${i + 1}/${questions.length}`);
    console.log(`${'─'.repeat(70)}`);
    console.log(`\n❓ ${q}\n`);
    process.stdout.write('🤖 Thinking...');

    try {
      const result = await askKnowledgeBase(
        client,
        knowledgeBaseId,
        modelArn,
        q,
        sessionId
      );
      sessionId = result.sessionId;

      process.stdout.write('\r' + ' '.repeat(20) + '\r');
      console.log(result.answer);
      printSources(result.sources);
      console.log();
    } catch (error) {
      console.error('\n❌ Error:', error);
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log('✅ Demo complete! All Knowledge Base categories tested successfully.');
  console.log(`${'═'.repeat(70)}\n`);
  console.log('💡 Tip: Run interactive mode to ask your own questions:');
  console.log('   npm run test-rag interactive\n');
}

async function runInteractive(
  client: BedrockAgentRuntimeClient,
  knowledgeBaseId: string,
  modelArn: string
) {
  let sessionId: string | undefined;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  💬 Interactive Mode                                          ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  console.log('Ask questions about:');
  console.log('  💰 Financial Data - budgets, reports, expense policies');
  console.log('  👥 Human Resources - benefits, PTO, remote work, reviews');
  console.log('  📝 Meeting Notes - strategy, roadmap, sprint retros\n');
  console.log('Type "exit" to quit.\n');

  const askQuestion = () => {
    rl.question('❓ You: ', async (input) => {
      const question = input.trim();

      if (!question) {
        askQuestion();
        return;
      }

      if (question.toLowerCase() === 'exit') {
        rl.close();
        return;
      }

      process.stdout.write('\n🤖 Thinking...');

      try {
        const result = await askKnowledgeBase(
          client,
          knowledgeBaseId,
          modelArn,
          question,
          sessionId
        );
        sessionId = result.sessionId;

        process.stdout.write('\r' + ' '.repeat(20) + '\r');
        console.log(`🤖 ${result.answer}`);
        printSources(result.sources);
        console.log();
      } catch (error) {
        console.error('\n❌ Error:', error, '\n');
      }

      askQuestion();
    });
  };

  askQuestion();
}

async function main() {
  try {
    const { knowledgeBaseId, modelArn, region } = await getStackOutputs();

    console.log(`Knowledge Base: ${knowledgeBaseId}`);
    console.log(`Model: ${modelArn.split('/').pop()}`);
    console.log(`Region: ${region}`);

    const client = new BedrockAgentRuntimeClient({ region });

    if (process.argv.includes('interactive')) {
      await runInteractive(client, knowledgeBaseId, modelArn);
    } else {
      await runDemo(client, knowledgeBaseId, modelArn);
    }
  } catch (error) {
    console.error('\n❌ Error:', error);
    console.log('\nMake sure you have:');
    console.log('1. Deployed the stack: cdk deploy');
    console.log('2. Uploaded documents: npm run upload-docs');
    console.log('3. Configured AWS credentials');
    process.exit(1);
  }
}

main();
