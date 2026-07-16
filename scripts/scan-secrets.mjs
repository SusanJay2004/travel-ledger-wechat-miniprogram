import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const patterns = [
  { name: '微信 AppID', expression: /\bwx[a-z0-9]{16}\b/g },
  { name: '微信 OpenID', expression: /\bo[A-Za-z0-9_-]{27}\b/g },
  { name: '腾讯云访问密钥 ID', expression: /\bAKID[A-Za-z0-9]{13,}\b/g },
  {
    name: '私钥',
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    name: '疑似硬编码密钥',
    expression: /\b(?:app_?secret|api_?key|secret_?key)\s*[:=]\s*['"][A-Za-z0-9+/_=-]{16,}['"]/gi,
  },
];

const candidateFiles = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter((path) => path.length > 0);
const findings = [];

for (const path of candidateFiles) {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const pattern of patterns) {
    pattern.expression.lastIndex = 0;
    for (const match of text.matchAll(pattern.expression)) {
      const offset = match.index ?? 0;
      const line = text.slice(0, offset).split('\n').length;
      findings.push(`${path}:${line} ${pattern.name}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`敏感信息扫描失败：\n${findings.map((item) => `- ${item}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `敏感信息扫描通过：已检查 ${candidateFiles.length} 个 Git 跟踪或待提交文件。\n`,
  );
}
