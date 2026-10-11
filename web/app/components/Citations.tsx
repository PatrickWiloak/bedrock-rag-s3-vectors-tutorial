import type { Citation } from '../lib/types';

/**
 * Sources backing an answer.
 *
 * The Lambda resolves each S3 key to a readable title and a short excerpt
 * before sending it, because a raw `s3://docs-1234.../file.md` tells the reader
 * nothing about whether the answer came from the right place - which is the
 * whole point of showing citations.
 */
export default function Citations({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;

  return (
    <div className="w-full max-w-2xl space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
        Sources
      </p>
      {citations.map((c) => (
        <details
          key={c.uri}
          className="rounded-sm border border-gray-300 bg-gray-50 px-3 py-2 text-xs"
        >
          <summary className="cursor-pointer list-none">
            <span className="mr-1 text-gray-500">{c.index}.</span>
            <span className="font-medium text-gray-800">{c.title}</span>
            {c.category && (
              <span className="ml-2 rounded-sm bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600">
                {c.category}
              </span>
            )}
          </summary>
          {c.excerpt && <p className="mt-2 text-gray-600">{c.excerpt}</p>}
          <p className="mt-2 break-all font-mono text-[10px] text-gray-400">{c.uri}</p>
        </details>
      ))}
    </div>
  );
}
