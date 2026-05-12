/**
 * Regex-based extraction of GitHub URLs, dataset names, and benchmark patterns
 * from paper text. Tier 1 (free) extraction — no API calls.
 */

import type { BenchmarkResult, DatasetLink } from '@openarx/types';

// GitHub URL patterns
const GITHUB_URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/g;
const NON_REPO_PATHS = new Set([
  'topics',
  'orgs',
  'settings',
  'issues',
  'pulls',
  'marketplace',
  'explore',
  'notifications',
  'sponsors',
  'features',
  'pricing',
  'login',
  'signup',
  'join',
]);

// Known dataset patterns (word-boundary matched)
const DATASET_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bImageNet\b/i, name: 'ImageNet' },
  { pattern: /\bCIFAR[- ]?10\b/i, name: 'CIFAR-10' },
  { pattern: /\bCIFAR[- ]?100\b/i, name: 'CIFAR-100' },
  { pattern: /\bMS[- ]?COCO\b/i, name: 'MS-COCO' },
  { pattern: /\bCOCO\b/, name: 'COCO' },
  { pattern: /\bWMT[- ]?\d{2,4}\b/i, name: 'WMT' },
  { pattern: /\bSQuAD\s*2\.0\b/, name: 'SQuAD 2.0' },
  { pattern: /\bSQuAD\s*1\.[01]\b/, name: 'SQuAD 1.1' },
  { pattern: /\bSQuAD\b/, name: 'SQuAD' },
  { pattern: /\bSuperGLUE\b/, name: 'SuperGLUE' },
  { pattern: /\bGLUE\b/, name: 'GLUE' },
  { pattern: /\bMNIST\b/, name: 'MNIST' },
  { pattern: /\bFashion[- ]?MNIST\b/i, name: 'Fashion-MNIST' },
  { pattern: /\bPenn Treebank\b/i, name: 'Penn Treebank' },
  { pattern: /\bPTB\b/, name: 'PTB' },
  { pattern: /\bWikiText[- ]?103\b/i, name: 'WikiText-103' },
  { pattern: /\bWikiText[- ]?2\b/i, name: 'WikiText-2' },
  { pattern: /\bLAMBADA\b/, name: 'LAMBADA' },
  { pattern: /\bVOC\s*20(?:07|12)\b/, name: 'Pascal VOC' },
  { pattern: /\bADE20K\b/i, name: 'ADE20K' },
  { pattern: /\bCityscapes\b/i, name: 'Cityscapes' },
  { pattern: /\bOpenImages\b/i, name: 'OpenImages' },
  { pattern: /\bLibriSpeech\b/i, name: 'LibriSpeech' },
  { pattern: /\bCommonCrawl\b/i, name: 'CommonCrawl' },
  { pattern: /\bBookCorpus\b/i, name: 'BookCorpus' },
  { pattern: /\bHellaSwag\b/i, name: 'HellaSwag' },
  { pattern: /\bWinoGrande?\b/i, name: 'WinoGrande' },
  { pattern: /\bARC[- ]?Challenge\b/i, name: 'ARC-Challenge' },
  { pattern: /\bMMLU\b/, name: 'MMLU' },
  { pattern: /\bTriviaQA\b/i, name: 'TriviaQA' },
  { pattern: /\bNatural Questions\b/i, name: 'Natural Questions' },
  { pattern: /\bHumanEval\b/i, name: 'HumanEval' },
  { pattern: /\bMBPP\b/, name: 'MBPP' },
  { pattern: /\bGSM8K\b/i, name: 'GSM8K' },
  { pattern: /\bMATH\b/, name: 'MATH' },
];

// Benchmark score patterns
const BENCHMARK_PATTERNS: RegExp[] = [
  // "achieves 95.2% accuracy on ImageNet"
  /achieves?\s+([\d.]+)\s*%?\s+(\w[\w\s-]*?)\s+on\s+([\w][\w\s.-]*\w)/gi,
  // "95.2% accuracy on ImageNet"
  /([\d.]+)\s*%\s+(accuracy|top-[15]|F1|BLEU|ROUGE-?L?|mAP|EM|exact match)\s+on\s+([\w][\w\s.-]*\w)/gi,
  // "X.X BLEU on DATASET"
  /([\d.]+)\s+(BLEU|ROUGE-?L?|mAP|perplexity)\s+on\s+([\w][\w\s.-]*\w)/gi,
  // "accuracy of 95.2% on DATASET"
  /(accuracy|top-[15]|F1|BLEU|ROUGE-?L?|mAP|EM)\s+(?:of|score of)\s+([\d.]+)\s*%?\s+on\s+([\w][\w\s.-]*\w)/gi,
  // "F1 score of 95.2 on SQuAD"
  /(F1|BLEU|ROUGE-?L?|EM|accuracy)\s+score\s+of\s+([\d.]+)\s*%?\s+on\s+([\w][\w\s.-]*\w)/gi,
];

export function extractGitHubUrls(text: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const match of text.matchAll(GITHUB_URL_RE)) {
    const owner = match[1];
    const repo = match[2];

    // Filter out non-repo paths
    if (NON_REPO_PATHS.has(owner.toLowerCase())) continue;

    // Strip trailing punctuation from repo name
    const cleanRepo = repo.replace(/[.),:;]+$/, '');
    const url = `https://github.com/${owner}/${cleanRepo}`;

    if (!seen.has(url.toLowerCase())) {
      seen.add(url.toLowerCase());
      results.push(url);
    }
  }

  return results;
}

export function extractDatasetNames(text: string): DatasetLink[] {
  const seen = new Set<string>();
  const results: DatasetLink[] = [];

  for (const { pattern, name } of DATASET_PATTERNS) {
    if (pattern.test(text) && !seen.has(name)) {
      seen.add(name);
      results.push({ name, extractedFrom: 'paper_text' });
    }
  }

  return results;
}

export function extractBenchmarkPatterns(text: string): BenchmarkResult[] {
  const results: BenchmarkResult[] = [];
  const seen = new Set<string>();

  for (const pattern of BENCHMARK_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;

    for (const match of text.matchAll(pattern)) {
      let metric: string;
      let score: number;
      let dataset: string;

      // Different capture group layouts depending on pattern
      if (match[0].toLowerCase().startsWith('achieve')) {
        // "achieves X.X% metric on dataset"
        score = parseFloat(match[1]);
        metric = match[2].trim();
        dataset = match[3].trim();
      } else if (/^\d/.test(match[1])) {
        // "X.X% metric on dataset" or "X.X metric on dataset"
        score = parseFloat(match[1]);
        metric = match[2].trim();
        dataset = match[3].trim();
      } else {
        // "metric of X.X on dataset"
        metric = match[1].trim();
        score = parseFloat(match[2]);
        dataset = match[3].trim();
      }

      if (isNaN(score)) continue;

      const key = `${metric}|${dataset}|${score}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        task: '',
        dataset,
        metric,
        score,
        extractedFrom: 'paper_text',
      });
    }
  }

  return results;
}
