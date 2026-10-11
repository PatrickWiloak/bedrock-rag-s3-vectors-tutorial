import { BedrockAgentClient, ListIngestionJobsCommand, GetIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { resolveOutputs } from './outputs';

async function checkIngestionStatus() {
  console.log('🔍 Checking Ingestion Status\n');

  const { knowledgeBaseId, dataSourceId, region } = await resolveOutputs();
  console.log(`Knowledge Base: ${knowledgeBaseId}`);
  console.log(`Data Source: ${dataSourceId}`);
  console.log(`Region: ${region}\n`);

  const bedrockClient = new BedrockAgentClient({ region });

  // List all ingestion jobs
  const listResponse = await bedrockClient.send(
    new ListIngestionJobsCommand({
      knowledgeBaseId,
      dataSourceId,
      maxResults: 10,
    })
  );

  const jobs = listResponse.ingestionJobSummaries || [];

  if (jobs.length === 0) {
    console.log('❌ No ingestion jobs found.');
    console.log('   Run "npm run upload-docs" to upload documents and start ingestion.');
    return;
  }

  console.log(`Found ${jobs.length} ingestion job(s):\n`);

  // Sort by start time (newest first)
  jobs.sort((a, b) => {
    const timeA = a.startedAt?.getTime() || 0;
    const timeB = b.startedAt?.getTime() || 0;
    return timeB - timeA;
  });

  for (const job of jobs) {
    const status = job.status;
    const jobId = job.ingestionJobId;
    const startedAt = job.startedAt?.toLocaleString() || 'N/A';

    // Get detailed info for the latest job
    if (job === jobs[0]) {
      const detailResponse = await bedrockClient.send(
        new GetIngestionJobCommand({
          knowledgeBaseId,
          dataSourceId,
          ingestionJobId: jobId,
        })
      );

      const detail = detailResponse.ingestionJob;
      const stats = detail?.statistics;

      console.log('═══════════════════════════════════════════');
      console.log('Latest Ingestion Job');
      console.log('═══════════════════════════════════════════');
      console.log(`Job ID: ${jobId}`);
      console.log(`Status: ${getStatusIcon(status!)} ${status}`);
      console.log(`Started: ${startedAt}`);

      if (detail?.updatedAt) {
        console.log(`Updated: ${detail.updatedAt.toLocaleString()}`);
      }

      if (stats) {
        console.log('\nStatistics:');
        console.log(`  Documents Scanned: ${stats.numberOfDocumentsScanned || 0}`);
        console.log(`  Documents Indexed (new): ${stats.numberOfNewDocumentsIndexed || 0}`);
        console.log(`  Documents Indexed (modified): ${stats.numberOfModifiedDocumentsIndexed || 0}`);
        console.log(`  Documents Deleted: ${stats.numberOfDocumentsDeleted || 0}`);
        console.log(`  Documents Failed: ${stats.numberOfDocumentsFailed || 0}`);
      }

      if (detail?.failureReasons && detail.failureReasons.length > 0) {
        console.log('\n❌ Failure Reasons:');
        detail.failureReasons.forEach((reason) => {
          console.log(`  - ${reason}`);
        });
      }

      console.log('═══════════════════════════════════════════\n');

      // Show status-specific messages
      if (status === 'COMPLETE') {
        console.log('✅ Ingestion complete! Your knowledge base is ready to query.');
        console.log('   Run "npm run test-rag" to query it.\n');
      } else if (status === 'IN_PROGRESS' || status === 'STARTING') {
        console.log('⏳ Ingestion in progress. This usually takes 2-5 minutes.');
        console.log('   Run this command again to check status.\n');
      } else if (status === 'FAILED') {
        console.log('❌ Ingestion failed. Check the failure reasons above.');
        console.log('   Try running "npm run upload-docs" again.\n');
      }
    } else {
      // Show summary for older jobs
      console.log(`${getStatusIcon(status!)} ${status} - ${jobId} (${startedAt})`);
    }
  }

  // Provide AWS CLI command for manual checking
  console.log('\nTo check status manually, run:');
  console.log(`aws bedrock-agent list-ingestion-jobs \\`);
  console.log(`  --knowledge-base-id ${knowledgeBaseId} \\`);
  console.log(`  --data-source-id ${dataSourceId}`);
}

function getStatusIcon(status: string): string {
  const icons: Record<string, string> = {
    STARTING: '🔄',
    IN_PROGRESS: '⏳',
    COMPLETE: '✅',
    FAILED: '❌',
  };
  return icons[status] || '❓';
}

async function main() {
  try {
    await checkIngestionStatus();
  } catch (error) {
    console.error('\n❌ Error:', error);
    console.log('\nMake sure you have:');
    console.log('1. Deployed the stack: ./scripts/deploy.sh infra (CDK) or IAC=terraform ./scripts/deploy.sh infra');
    console.log('2. Configured AWS credentials');
    process.exit(1);
  }
}

main();
