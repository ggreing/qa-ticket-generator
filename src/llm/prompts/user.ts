/**
 * User-message builders (SPEC §8). Block order is fixed for cache reuse:
 * <prd_documents> → <repo_instructions> → <pr_metadata> → <code_changes> → <skipped_files> → task.
 * The first three are identical for every call of a run (the "shared prefix").
 * Owner: qa-work-session-c(fable).
 */
import type {
  CodeChunk,
  GenerateRequest,
  PackedFile,
  PromptContext,
  SkippedFile,
} from '../../core/contracts';

/** Tags this module emits. Data that contains them is defused so it cannot close a section early. */
const RESERVED_TAGS =
  /<(\/?)(prd_documents|prd_document|acceptance_criteria|repo_instructions|glossary|pr_metadata|pr_title|pr_body|code_changes|changed_file|file_summary|hunk|code_context|skipped_files|partial_reports|partial_report|task)\b/gi;

const MAX_SKIPPED_LISTED = 300;

/** Neutralizes reserved tag names inside untrusted text (trust boundary, SPEC §11). */
export function guardData(text: string): string {
  return text.replace(RESERVED_TAGS, '&lt;$1$2');
}

/** Escapes a value for use inside a double-quoted XML attribute. */
export function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `<prd_documents>` block — first and largest part of the shared prefix (LLM-06). */
export function buildPrdSection(context: PromptContext): string {
  if (context.prdDocuments.length === 0) {
    return '<prd_documents>\n(No PRD is linked to this pull request.)\n</prd_documents>';
  }
  const docs = context.prdDocuments.map((doc) => {
    const criteria =
      doc.acceptanceCriteria.length > 0
        ? `\n<acceptance_criteria>\n${doc.acceptanceCriteria.map((ac) => `- ${guardData(ac)}`).join('\n')}\n</acceptance_criteria>`
        : '';
    return `<prd_document id="${attr(doc.ref.id)}" source="${doc.ref.source}" title="${attr(doc.title)}">${criteria}\n${guardData(doc.bodyMarkdown)}\n</prd_document>`;
  });
  return `<prd_documents>\n${docs.join('\n')}\n</prd_documents>`;
}

/** `<repo_instructions>` + `<pr_metadata>` — the rest of the shared prefix. */
export function buildMetadataSection(context: PromptContext): string {
  const parts: string[] = [];
  const repo = context.repoInstructions;
  const glossary = repo?.glossary ?? [];
  if (repo?.extraInstructions?.trim() || glossary.length > 0) {
    const lines: string[] = [];
    if (repo?.extraInstructions?.trim()) lines.push(guardData(repo.extraInstructions.trim()));
    if (glossary.length > 0) {
      lines.push(
        `<glossary>\n${glossary.map((g) => `- ${guardData(g.term)}: ${guardData(g.meaning)}`).join('\n')}\n</glossary>`,
      );
    }
    parts.push(`<repo_instructions>\n${lines.join('\n')}\n</repo_instructions>`);
  }
  const { pr } = context;
  parts.push(
    `<pr_metadata number="${pr.number}" author="${attr(pr.author)}" base="${attr(pr.baseRef)}" head="${attr(pr.headRef)}">
<pr_title>${guardData(pr.title)}</pr_title>
<pr_body>
${guardData(pr.body)}
</pr_body>
</pr_metadata>`,
  );
  return parts.join('\n');
}

function renderFile(file: PackedFile): string {
  const previous = file.previousPath ? ` previous_path="${attr(file.previousPath)}"` : '';
  const body: string[] = [];
  if (file.summary) body.push(`<file_summary>${guardData(file.summary)}</file_summary>`);
  for (const hunk of file.hunks) {
    body.push(`<hunk header="${attr(hunk.header)}">\n${guardData(hunk.text)}\n</hunk>`);
  }
  for (const ctx of file.contexts) {
    const name = ctx.name ? ` name="${attr(ctx.name)}"` : '';
    body.push(
      `<code_context kind="${ctx.kind}"${name} lines="${ctx.startLine}-${ctx.endLine}">\n${guardData(ctx.text)}\n</code_context>`,
    );
  }
  return `<changed_file path="${attr(file.path)}" status="${file.status}"${previous}>\n${body.join('\n')}\n</changed_file>`;
}

/** `<code_changes>` for one chunk: diff hunks plus the enclosing symbols (PRE-06 output). */
export function buildCodeSection(chunk: CodeChunk): string {
  return `<code_changes>\n${chunk.files.map(renderFile).join('\n')}\n</code_changes>`;
}

/** `<skipped_files>` — paths only, so the model can name coverage gaps without guessing content. */
export function buildSkippedSection(skipped: SkippedFile[]): string {
  if (skipped.length === 0) return '<skipped_files>\n(none)\n</skipped_files>';
  const listed = skipped.slice(0, MAX_SKIPPED_LISTED).map((s) => `- ${guardData(s.path)} (${s.reason})`);
  if (skipped.length > MAX_SKIPPED_LISTED) {
    listed.push(`(${skipped.length - MAX_SKIPPED_LISTED} more files not listed)`);
  }
  return `<skipped_files>\n${listed.join('\n')}\n</skipped_files>`;
}

/** Closing instruction. Kept last because it carries the only per-call values. */
export function buildTaskInstruction(phase: GenerateRequest['phase'], maxScenarios: number): string {
  const scope =
    phase === 'single'
      ? 'Review the pull request above.'
      : `Review this part of the pull request. The PR is too large for one pass, so it was split: you are seeing one part, the other parts are reviewed separately, and a final step merges the results. Judge only the files shown here. When a requirement's implementation is not in this part, mark the finding "unclear" and note that it may live in another part, because "missing" would be wrong if another part implements it.`;
  return `<task>\n${scope} Return at most ${maxScenarios} scenarios.\n</task>`;
}

/** Everything after the shared prefix for a generate call. */
export function buildGenerateTail(req: GenerateRequest): string {
  return [
    buildCodeSection(req.chunk),
    buildSkippedSection(req.skipped),
    buildTaskInstruction(req.phase, req.context.maxScenarios),
  ].join('\n');
}
