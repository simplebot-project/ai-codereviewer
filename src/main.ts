import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { readFileSync } from "fs";
import minimatch from "minimatch";
import OpenAI from "openai";
import parseDiff, { Chunk, File } from "parse-diff";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);

      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Você é um revisor de código brasileiro. Sua tarefa é revisar pull requests em PORTUGUÊS BRASILEIRO.

INSTRUÇÕES OBRIGATÓRIAS:
- Forneça a resposta APENAS no formato JSON: {"reviews": [{"lineNumber": <numero_da_linha>, "reviewComment": "<comentário da revisão>"}]}
- TODOS os comentários DEVEM ser escritos em PORTUGUÊS BRASILEIRO.
- Use termos técnicos em português quando possível (exemplo: "variável" ao invés de "variable").
- Não faça comentários positivos ou elogios.
- Forneça comentários e sugestões SOMENTE se houver algo a melhorar, caso contrário "reviews" deve ser um array vazio.
- Escreva o comentário em Markdown do GitHub.
- Utilize a descrição apenas para contexto geral e comente somente o código.
- IMPORTANTE: NUNCA sugira adicionar comentários ao código.
- Foque em: bugs potenciais, problemas de segurança, erros de lógica, código duplicado, problemas de performance.

Revise o seguinte diff do arquivo "${file.to}" considerando o título e a descrição do pull request.

Título do pull request: ${prDetails.title}
Descrição do pull request:

---
${prDetails.description}
---

Diff do código a ser revisado:

\`\`\`diff
${chunk.content}
${chunk.changes
      // @ts-expect-error - ln and ln2 exists where needed
      .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
      .join("\n")}
\`\`\`

LEMBRE-SE: Responda EXCLUSIVAMENTE em português brasileiro.`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.1,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      messages: [
        {
          role: "system",
          content: "Você é um assistente brasileiro especializado em revisão de código. Você SEMPRE responde em português brasileiro, usando termos técnicos em português. Nunca use inglês em suas respostas. Exemplos: use 'variável' ao invés de 'variable', 'indefinido' ao invés de 'undefined', 'nulo' ao invés de 'null'."
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    let res = response.choices[0].message?.content || "{}";

    // Remove ```json ou ``` e qualquer espaço extra
    res = res.replace(/```(json)?/gi, "").trim();

    // Garante que só pegue a primeira chave JSON válida
    const firstCurly = res.indexOf("{");
    const lastCurly = res.lastIndexOf("}");
    if (firstCurly !== -1 && lastCurly !== -1) {
      res = res.slice(firstCurly, lastCurly + 1);
    }

    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error parsing AI response:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
